import { cronError, isValidTimeZone, nextCronRun, nextCronRuns, Schedule, type MethodParams, type MethodResult, type Task, type TaskStatus } from '@cocoon/protocol';
import type { ActivityLog } from './activity.ts';
import { CocoonError, notFound } from './errors.ts';
import type { EventBus } from './events.ts';
import { t } from './i18n.ts';
import { newId } from './ids.ts';
import type { SettingsService } from './settings.ts';
import type { Store } from './store.ts';
import type { TaskService } from './tasks.ts';
import { applyPatch, type WorkspaceService } from './workspaces.ts';

const TICK_MS = 20_000;
/** A run in one of these states is still open: overlap "skip" waits for it. */
const OPEN_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'review'];

export type ScheduleTasks = Pick<TaskService, 'create' | 'start' | 'delete'>;
type RunResult = MethodResult<'schedule.run'>;

/** The server's time zone (used when a schedule has none). */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** "2026-10-16 03:00" in the given time zone – makes the task titles of the runs distinguishable. */
export function runLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

/**
 * Scheduled agents: every schedule creates a task in its workspace when its cron expression is due and starts it right
 * away (the task engine does the rest). Missed runs (server was down) are made up once on start. Old finished runs are
 * pruned together with the sandboxes created for them.
 */
export class ScheduleService {
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly settings: SettingsService,
    private readonly workspaces: WorkspaceService,
    private readonly tasks: ScheduleTasks,
    private readonly activity: ActivityLog,
    private readonly log: (msg: string, err?: unknown) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── queries ────────────────────────────────────────────────────────────────

  list(workspaceId?: string): Schedule[] {
    return this.store
      .schedules()
      .filter((s) => !workspaceId || s.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Schedule {
    const schedule = this.store.schedule(id);
    if (!schedule) throw notFound('Schedule', id);
    return schedule;
  }

  preview(cron: string, timezone: string | undefined, count: number): MethodResult<'schedule.preview'> {
    const zone = timezone || serverTimeZone();
    const error = cronError(cron) ?? (isValidTimeZone(zone) ? undefined : t('error.invalidTimezone', { timezone: zone }));
    if (error) return { valid: false, error, timezone: zone, next: [] };
    return { valid: true, timezone: zone, next: nextCronRuns(cron, this.now(), count, zone).map((d) => d.toISOString()) };
  }

  // ── commands ───────────────────────────────────────────────────────────────

  create(params: MethodParams<'schedule.create'>): Schedule {
    this.workspaces.get(params.workspaceId);
    const now = this.now().toISOString();
    const schedule = Schedule.parse(
      applyPatch({ id: newId('sc'), runCount: 0, createdAt: now, updatedAt: now }, params),
    );
    if (!schedule.timezone) schedule.timezone = serverTimeZone();
    this.validate(schedule);
    schedule.nextRunAt = this.computeNext(schedule, this.now());
    this.save(schedule);
    this.activity.add('info', 'activity.scheduleCreated', { name: schedule.name });
    return schedule;
  }

  update({ scheduleId, ...patch }: MethodParams<'schedule.update'>): Schedule {
    const current = this.get(scheduleId);
    const schedule = Schedule.parse({ ...applyPatch(current, patch), updatedAt: this.now().toISOString() });
    if (!schedule.timezone) schedule.timezone = serverTimeZone();
    this.validate(schedule);
    if (patch.workflowId) schedule.agentKind = undefined;
    else if (patch.agentKind) schedule.workflowId = undefined;
    const timing = schedule.cron !== current.cron || schedule.timezone !== current.timezone || schedule.enabled !== current.enabled;
    if (timing || (schedule.enabled && !schedule.nextRunAt)) schedule.nextRunAt = this.computeNext(schedule, this.now());
    this.save(schedule);
    return schedule;
  }

  /** Deletes the schedule; its runs stay on the board unless deleteTasks is set. */
  async delete(scheduleId: string, deleteTasks = false): Promise<void> {
    const schedule = this.get(scheduleId);
    if (deleteTasks) {
      for (const task of this.runs(scheduleId)) await this.tasks.delete(task.id, { removeSandbox: true });
    }
    this.store.deleteSchedule(scheduleId);
    this.bus.publish({ type: 'schedule.deleted', scheduleId, workspaceId: schedule.workspaceId });
  }

  /** Runs the schedule now, once; the regular schedule is not shifted. */
  async run(scheduleId: string, force = false): Promise<RunResult> {
    return this.fire(this.get(scheduleId), { force, manual: true });
  }

  // ── engine ─────────────────────────────────────────────────────────────────

  start(): void {
    for (const schedule of this.store.schedules()) {
      if (schedule.enabled && !schedule.nextRunAt) this.save({ ...schedule, nextRunAt: this.computeNext(schedule, this.now()) });
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Fires every enabled schedule that is due (a run missed while the server was down is made up once). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now().getTime();
      for (const schedule of this.store.schedules()) {
        if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > now) continue;
        if (!this.store.workspace(schedule.workspaceId)) continue;
        await this.fire(schedule, { force: false, manual: false });
      }
    } catch (err) {
      this.log('scheduled agents: tick failed', err);
    } finally {
      this.ticking = false;
    }
  }

  private async fire(schedule: Schedule, { force, manual }: { force: boolean; manual: boolean }): Promise<RunResult> {
    const now = this.now();
    const zone = schedule.timezone || serverTimeZone();
    const next: Schedule = {
      ...schedule,
      lastRunAt: now.toISOString(),
      lastNote: undefined,
      nextRunAt: manual ? schedule.nextRunAt : this.computeNext(schedule, now),
    };
    let task: Task | undefined;
    const open = this.runs(schedule.id).find((x) => OPEN_STATUSES.includes(x.status));
    if (open && schedule.overlap === 'skip' && !force) {
      next.lastResult = 'skipped';
      next.lastNote = t('schedule.previousOpen', { handle: open.handle ?? open.title });
      this.activity.add('info', 'activity.scheduleSkipped', { name: schedule.name, reason: next.lastNote });
    } else {
      let created: Task | undefined;
      try {
        // Created in the backlog and started directly: scheduled runs do not wait for auto-run.
        created = this.tasks.create(
          {
            workspaceId: schedule.workspaceId,
            status: 'backlog',
            title: `${schedule.name} · ${runLabel(now, zone)}`,
            description: schedule.prompt,
            priority: schedule.priority,
            agentKind: schedule.workflowId ? undefined : schedule.agentKind,
            workflowId: schedule.workflowId,
            providers: schedule.providers,
            model: schedule.model,
          },
          { scheduleId: schedule.id },
        );
        task = this.tasks.start(created.id);
        next.lastResult = 'started';
        next.lastTaskId = task.id;
        next.runCount = (schedule.runCount ?? 0) + 1;
        this.activity.add('info', 'activity.scheduleStarted', { name: schedule.name, handle: task.handle ?? task.title });
      } catch (err) {
        // A run that could not start (e.g. its workflow was deleted) would only clutter the backlog.
        if (created) await this.tasks.delete(created.id).catch(() => undefined);
        next.lastResult = 'error';
        next.lastNote = (err as Error).message;
        this.activity.add('error', 'activity.scheduleFailed', { name: schedule.name, error: next.lastNote });
      }
    }
    // The schedule may have been changed or deleted meanwhile: only the run bookkeeping is written back.
    const latest = this.store.schedule(schedule.id);
    if (!latest) return { schedule: next, result: next.lastResult!, task };
    const saved: Schedule = {
      ...latest,
      lastRunAt: next.lastRunAt,
      lastResult: next.lastResult,
      lastNote: next.lastNote,
      lastTaskId: next.lastTaskId,
      runCount: next.runCount,
      nextRunAt: manual || latest.cron !== schedule.cron || latest.timezone !== schedule.timezone ? latest.nextRunAt : next.nextRunAt,
    };
    this.save(saved);
    await this.prune(saved).catch((err) => this.log(`scheduled agents: pruning ${schedule.id} failed`, err));
    return { schedule: saved, result: saved.lastResult!, task };
  }

  /** Keeps the newest `keepRuns` finished runs; older ones are deleted with the sandbox created for them. */
  private async prune(schedule: Schedule): Promise<void> {
    const finished = this.runs(schedule.id)
      .filter((x) => x.status === 'done' || x.status === 'failed')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const old of finished.slice(schedule.keepRuns)) await this.tasks.delete(old.id, { removeSandbox: true });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private runs(scheduleId: string): Task[] {
    return this.store.tasks().filter((x) => x.scheduleId === scheduleId);
  }

  private computeNext(schedule: Schedule, after: Date): string | undefined {
    if (!schedule.enabled) return undefined;
    return nextCronRun(schedule.cron, after, schedule.timezone || serverTimeZone())?.toISOString();
  }

  private validate(schedule: Schedule): void {
    const error = cronError(schedule.cron);
    if (error) throw new CocoonError('bad_request', t('error.invalidCron', { cron: schedule.cron, error }));
    if (schedule.timezone && !isValidTimeZone(schedule.timezone)) throw new CocoonError('bad_request', t('error.invalidTimezone', { timezone: schedule.timezone }));
    const { agents, workflows } = this.settings.get();
    if (schedule.workflowId && !workflows[schedule.workflowId]) throw new CocoonError('bad_request', t('error.unknownWorkflow', { id: schedule.workflowId }));
    if (!schedule.workflowId && schedule.agentKind && !agents[schedule.agentKind]) {
      throw new CocoonError('bad_request', t('error.unknownAgentKind', { kind: schedule.agentKind, available: Object.keys(agents).join(', ') }));
    }
  }

  private save(schedule: Schedule): void {
    this.store.putSchedule(schedule);
    this.bus.publish({ type: 'schedule.updated', schedule });
  }
}
