import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, MethodParams, Task } from '@cocoon/protocol';
import { ActivityLog } from './activity.ts';
import type { AgentManager } from './agents/manager.ts';
import { EventBus } from './events.ts';
import type { Notifier } from './notifications.ts';
import type { SandboxManager } from './sandbox/manager.ts';
import type { WorkspaceService as FilesService } from './sandbox/workspace.ts';
import { runLabel, ScheduleService, type ScheduleTasks } from './schedules.ts';
import { SettingsService } from './settings.ts';
import { Store, type SandboxRecord } from './store.ts';
import { TaskService } from './tasks.ts';
import { WorkspaceService } from './workspaces.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-schedules-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const daily = (params: Partial<MethodParams<'schedule.create'>> = {}) => ({ name: 'Nightly checks', cron: '0 3 * * *', timezone: 'UTC', prompt: 'Run all checks', ...params });

/** Real store/settings/workspaces; tasks are recorded by a fake that behaves like the task service. */
function setup(start = '2026-10-16T10:00:00Z') {
  const store = new Store(dir);
  const bus = new EventBus();
  const activity = new ActivityLog(bus);
  const settings = new SettingsService(store, bus, undefined);
  const workspaces = new WorkspaceService(store, bus, activity);
  const ws = workspaces.create({ name: 'Shop' });
  let now = new Date(start);
  let n = 0;
  const tasks: ScheduleTasks & { deleted: string[] } = {
    deleted: [],
    create(params, origin = {}) {
      const at = now.toISOString();
      const task = { id: `ts_${++n}`, workspaceId: params.workspaceId, handle: `S-${n}`, title: params.title, description: params.description ?? '', status: 'backlog', priority: 'normal', order: n, dependsOn: [], stage: 0, runs: [], attention: false, reviews: [], pullRequests: [], createdAt: at, updatedAt: at, agentKind: params.agentKind, workflowId: params.workflowId ?? undefined, ...origin } as Task;
      store.putTask(task);
      return task;
    },
    start(taskId) {
      const task = { ...store.task(taskId)!, status: 'running' as const };
      store.putTask(task);
      return task;
    },
    async delete(taskId) {
      tasks.deleted.push(taskId);
      store.deleteTask(taskId);
    },
  };
  const service = new ScheduleService(store, bus, settings, workspaces, tasks, activity, () => undefined, () => now);
  return { store, service, tasks, ws, setNow: (iso: string) => (now = new Date(iso)), setStatus: (id: string, status: Task['status']) => store.putTask({ ...store.task(id)!, status }) };
}

describe('ScheduleService', () => {
  it('computes the next run on create and validates input', () => {
    const { service, ws } = setup();
    const s = service.create({ workspaceId: ws.id, ...daily() });
    expect(s).toMatchObject({ enabled: true, nextRunAt: '2026-10-17T03:00:00.000Z', runCount: 0, overlap: 'skip', autoClose: true });
    expect(() => service.create({ workspaceId: ws.id, ...daily({ cron: '0 3 * *' }) })).toThrow(/5 fields/);
    expect(() => service.create({ workspaceId: ws.id, ...daily({ agentKind: 'nope' }) })).toThrow(/nope/);
    expect(() => service.create({ workspaceId: ws.id, ...daily({ workflowId: 'nope' }) })).toThrow(/nope/);
    expect(() => service.create({ workspaceId: 'ws_missing', ...daily() })).toThrow(/ws_missing/);
  });

  it('defaults to the server time zone and keeps paused schedules without next run', () => {
    const { service, ws } = setup();
    const s = service.create({ workspaceId: ws.id, ...daily({ timezone: undefined, enabled: false }) });
    expect(s.timezone).toBeTruthy();
    expect(s.nextRunAt).toBeUndefined();
    const resumed = service.update({ scheduleId: s.id, enabled: true, timezone: 'UTC' });
    expect(resumed.nextRunAt).toBe('2026-10-17T03:00:00.000Z');
    expect(service.update({ scheduleId: s.id, cron: '30 * * * *' }).nextRunAt).toBe('2026-10-16T10:30:00.000Z');
  });

  it('creates and starts a task when due, then moves to the next run', async () => {
    const { service, ws, store, setNow } = setup();
    const s = service.create({ workspaceId: ws.id, ...daily({ agentKind: 'codex' }) });
    await service.tick();
    expect(store.tasks()).toHaveLength(0);

    setNow('2026-10-17T03:00:10Z');
    await service.tick();
    const [task] = store.tasks();
    expect(task).toMatchObject({ scheduleId: s.id, status: 'running', title: 'Nightly checks · 2026-10-17 03:00', description: 'Run all checks', agentKind: 'codex' });
    expect(service.get(s.id)).toMatchObject({ lastResult: 'started', lastTaskId: task!.id, runCount: 1, nextRunAt: '2026-10-18T03:00:00.000Z' });

    // Not due again until the next day.
    await service.tick();
    expect(store.tasks()).toHaveLength(1);
  });

  it('makes up a missed run once (server was down)', async () => {
    const { service, ws, store, setNow } = setup();
    service.create({ workspaceId: ws.id, ...daily({ cron: '0 * * * *', overlap: 'always' }) });
    setNow('2026-10-17T15:20:00Z');
    await service.tick();
    await service.tick();
    expect(store.tasks()).toHaveLength(1);
    expect(service.list()[0]!.nextRunAt).toBe('2026-10-17T16:00:00.000Z');
  });

  it('skips while the previous run is open (overlap "skip"), unless forced', async () => {
    const { service, ws, store, setNow, setStatus } = setup();
    const s = service.create({ workspaceId: ws.id, ...daily() });
    setNow('2026-10-17T03:00:00Z');
    await service.tick();
    const first = store.tasks()[0]!;
    setStatus(first.id, 'review');

    setNow('2026-10-18T03:00:00Z');
    await service.tick();
    expect(store.tasks()).toHaveLength(1);
    expect(service.get(s.id)).toMatchObject({ lastResult: 'skipped', lastNote: expect.stringContaining('S-1'), nextRunAt: '2026-10-19T03:00:00.000Z' });

    const forced = await service.run(s.id, true);
    expect(forced.result).toBe('started');
    expect(store.tasks()).toHaveLength(2);
    // A manual run does not shift the schedule.
    expect(forced.schedule.nextRunAt).toBe('2026-10-19T03:00:00.000Z');
  });

  it('treats a failed run whose agent is still alive as open (it can be revived)', async () => {
    const { service, ws, store, setNow, setStatus } = setup();
    const s = service.create({ workspaceId: ws.id, ...daily() });
    setNow('2026-10-17T03:00:00Z');
    await service.tick();
    const first = store.tasks()[0]!;
    store.putAgent({ id: 'ag_1', sandboxId: 'sb_1', kind: 'shell', status: 'working' } as Agent);
    store.putTask({ ...first, agentId: 'ag_1', status: 'failed' });

    setNow('2026-10-18T03:00:00Z');
    await service.tick();
    expect(store.tasks()).toHaveLength(1);
    expect(service.get(s.id)).toMatchObject({ lastResult: 'skipped' });

    // Once the agent is gone, the failed run no longer blocks the next one.
    store.putAgent({ id: 'ag_1', sandboxId: 'sb_1', kind: 'shell', status: 'exited' } as Agent);
    setStatus(first.id, 'failed');
    setNow('2026-10-19T03:00:00Z');
    await service.tick();
    expect(store.tasks()).toHaveLength(2);
  });

  it('rejects expressions that never fire', () => {
    const { service, ws } = setup();
    expect(() => service.create({ workspaceId: ws.id, ...daily({ cron: '0 0 31 2 *' }) })).toThrow(/never fires/);
  });

  it('starts another run with overlap "always"', async () => {
    const { service, ws, store } = setup();
    const s = service.create({ workspaceId: ws.id, ...daily({ overlap: 'always' }) });
    await service.run(s.id);
    await service.run(s.id);
    expect(store.tasks()).toHaveLength(2);
  });

  it('keeps only the newest finished runs', async () => {
    const { service, ws, store, tasks, setNow, setStatus } = setup();
    const s = service.create({ workspaceId: ws.id, ...daily({ keepRuns: 2, overlap: 'always' }) });
    for (let day = 17; day <= 20; day++) {
      setNow(`2026-10-${day}T03:00:00Z`);
      const { task } = await service.run(s.id);
      if (day < 20) setStatus(task!.id, day === 18 ? 'failed' : 'done');
    }
    // Run 4 is still running; of the finished runs 1–3 only the two newest stay.
    expect(tasks.deleted).toEqual(['ts_1']);
    expect(store.tasks().map((x) => x.id).sort()).toEqual(['ts_2', 'ts_3', 'ts_4']);
  });

  it('records start errors and deletes runs with the schedule on request', async () => {
    const { service, ws, store, tasks } = setup();
    const s = service.create({ workspaceId: ws.id, ...daily() });
    const start = tasks.start;
    tasks.start = () => {
      throw new Error('no sandbox image');
    };
    expect(await service.run(s.id)).toMatchObject({ result: 'error' });
    expect(service.get(s.id)).toMatchObject({ lastResult: 'error', lastNote: 'no sandbox image' });
    expect(store.tasks()).toHaveLength(0);
    tasks.start = start;

    await service.delete(s.id, true);
    expect(store.tasks()).toHaveLength(0);
    expect(service.list()).toHaveLength(0);
  });

  it('labels runs in the schedule time zone', () => {
    expect(runLabel(new Date('2026-07-01T01:00:00Z'), 'Europe/Berlin')).toBe('2026-07-01 03:00');
  });
});

describe('scheduled runs in the task engine', () => {
  /** TaskService with fake sandboxes/agents: the agent's report file is served by sandboxes.sh. */
  function engine(report: string) {
    const store = new Store(dir);
    const bus = new EventBus();
    const activity = new ActivityLog(bus);
    const settings = new SettingsService(store, bus, undefined);
    const workspaces = new WorkspaceService(store, bus, activity);
    const ws = workspaces.create({ name: 'Shop' });
    const prompts: string[] = [];
    const envs: (Record<string, string> | undefined)[] = [];
    const deletedSandboxes: string[] = [];
    let agentNo = 0;
    const sandboxes = {
      create: async (_p: unknown, opts: { taskId?: string }) => {
        const record = { id: 'sb_1', name: 'x', status: 'running', workdir: '/workspace', taskId: opts.taskId, workspaceId: ws.id, createdAt: 'x', proxyToken: 't' } as unknown as SandboxRecord;
        store.putSandbox(record);
        return record;
      },
      start: async () => undefined,
      delete: async (id: string) => {
        deletedSandboxes.push(id);
        store.deleteSandbox(id);
      },
      sh: async (_id: string, script: string) => (script.startsWith('cat') ? report : ''),
    } as unknown as SandboxManager;
    const files = { checkoutBranch: async () => undefined, diff: async () => ({ files: [] }) } as unknown as FilesService;
    const agents = {
      spawn: async (p: { prompt: string; sandboxId: string; kind: string; env?: Record<string, string> }) => {
        prompts.push(p.prompt);
        envs.push(p.env);
        const agent = { id: `ag_${++agentNo}`, sandboxId: p.sandboxId, kind: p.kind, status: 'working' } as Agent;
        store.putAgent(agent);
        return agent;
      },
      kill: async () => undefined,
      read: async () => '',
    } as unknown as AgentManager;
    const notified: string[] = [];
    const notifier = { notify: (event: string) => notified.push(event) } as unknown as Notifier;
    const tasks = new TaskService(store, bus, settings, workspaces, sandboxes, files, agents, notifier, () => undefined);
    const schedules = new ScheduleService(store, bus, settings, workspaces, tasks, activity, () => undefined);
    const finish = (agentId: string) => bus.publish({ type: 'agent.updated', agent: { ...store.agent(agentId)!, status: 'done' } });
    return { store, tasks, schedules, ws, prompts, envs, deletedSandboxes, notified, finish };
  }

  async function runOnce(e: ReturnType<typeof engine>, params: Partial<MethodParams<'schedule.create'>> = {}) {
    const s = e.schedules.create({ workspaceId: e.ws.id, ...daily(params) });
    const { task } = await e.schedules.run(s.id);
    await vi.waitFor(() => expect(e.store.task(task!.id)?.agentId).toBeDefined());
    return e.store.task(task!.id)!;
  }

  it('asks the agent for a report and closes "ok" runs automatically', async () => {
    const e = engine('{"status":"ok","summary":"lint, typecheck and 120 tests passed","report":"- ✅ lint"}');
    const task = await runOnce(e);
    expect(e.prompts[0]).toContain('Run all checks');
    expect(e.prompts[0]).toContain(`/workspace/.cocoon/report/${task.id}.json`);
    expect(e.envs[0]).toEqual({ COCOON_REPORT_FILE: `/workspace/.cocoon/report/${task.id}.json` });

    e.finish(task.agentId!);
    await vi.waitFor(() => expect(e.store.task(task.id)?.status).toBe('done'));
    const done = e.tasks.get(task.id);
    expect(done.report).toMatchObject({ status: 'ok', summary: 'lint, typecheck and 120 tests passed', details: '- ✅ lint' });
    expect(done.note).toContain('120 tests passed');
    expect(done.sandboxId).toBeUndefined();
    expect(e.deletedSandboxes).toEqual(['sb_1']);
    expect(e.notified).toEqual(['task.done']);
  });

  it('sends runs with findings to review and keeps their sandbox', async () => {
    const e = engine('{"status":"action_needed","summary":"2 unit tests fail"}');
    const task = await runOnce(e);
    e.finish(task.agentId!);
    await vi.waitFor(() => expect(e.store.task(task.id)?.status).toBe('review'));
    expect(e.tasks.get(task.id)).toMatchObject({ sandboxId: 'sb_1', report: { status: 'action_needed' } });
    expect(e.deletedSandboxes).toEqual([]);
    expect(e.notified).toEqual(['task.review']);
  });

  it('shell agents get the report path but no extra instructions (the prompt is their command)', async () => {
    const e = engine('{"status":"ok"}');
    const task = await runOnce(e, { agentKind: 'shell', prompt: 'pnpm test && echo \'{"status":"ok"}\' > "$COCOON_REPORT_FILE"' });
    expect(e.prompts[0]).toBe('pnpm test && echo \'{"status":"ok"}\' > "$COCOON_REPORT_FILE"');
    expect(e.envs[0]?.COCOON_REPORT_FILE).toContain(task.id);
  });

  it('in a workflow only the last stage writes the report; an approval stage before it pauses as usual', async () => {
    const e = engine('{"status":"ok"}');
    const task = await runOnce(e, { workflowId: 'plan-build-review' });
    expect(e.prompts[0]).not.toContain('.cocoon/report');
    e.finish(task.agentId!);
    // The plan stage needs approval: review, no report read.
    await vi.waitFor(() => expect(e.store.task(task.id)?.status).toBe('review'));
    expect(e.store.task(task.id)?.report).toBeUndefined();
  });

  it('without autoClose, even "ok" runs wait for review; a missing report too', async () => {
    const ok = engine('{"status":"ok","summary":"fine"}');
    const task = await runOnce(ok, { autoClose: false });
    ok.finish(task.agentId!);
    await vi.waitFor(() => expect(ok.store.task(task.id)?.status).toBe('review'));

    rmSync(dir, { recursive: true, force: true });
    const missing = engine('garbage');
    const other = await runOnce(missing);
    missing.finish(other.agentId!);
    await vi.waitFor(() => expect(missing.store.task(other.id)?.status).toBe('review'));
    expect(missing.tasks.get(other.id).report?.status).toBe('missing');
  });
});
