import { useState } from 'react';
import type { Schedule, Task } from '@cocoon/protocol';
import { CalendarClock, MoreHorizontal, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useTasks } from '../../api/queries';
import { qk } from '../../api/keys';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { useLanguage, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { formatDateTime, formatRelative } from '../../lib/format';
import { describeCron } from '../../lib/schedules';
import { taskStatusMeta } from '../../lib/tasks';
import { Badge, StatusDot } from '../Badge';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { EmptyState } from '../EmptyState';
import { Checkbox } from '../Field';
import { MenuItem, MenuSeparator, Popover } from '../Popover';
import { useOpenTask } from '../tasks/useTaskActions';
import { WorkspaceTag } from '../WorkspaceSwitcher';
import { ReportBadge, TemplateIcon } from './ScheduleBits';
import { ScheduleDialog } from './ScheduleDialog';

const HISTORY = 12;

/** Scheduled agents with their next/last run, recent runs and actions; `workspaceId` limits the list and preselects new ones. */
export function ScheduleList({ schedules, workspaceId, showWorkspace }: { schedules: Schedule[]; workspaceId?: string; showWorkspace?: boolean }) {
  const t = useT();
  const tasks = useTasks();
  const [editing, setEditing] = useState<{ open: boolean; schedule?: Schedule }>({ open: false });
  const [deleting, setDeleting] = useState<Schedule | null>(null);

  return (
    <>
      {schedules.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="size-6" />}
          title={t('schedule.emptyTitle')}
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ open: true })}>
              {t('schedule.newTitle')}
            </Button>
          }
        >
          {t('schedule.emptyText')}
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {schedules.map((s) => (
            <ScheduleRow
              key={s.id}
              schedule={s}
              runs={(tasks.data ?? []).filter((x) => x.scheduleId === s.id)}
              showWorkspace={showWorkspace}
              onEdit={() => setEditing({ open: true, schedule: s })}
              onDelete={() => setDeleting(s)}
            />
          ))}
        </ul>
      )}
      <ScheduleDialog open={editing.open} onClose={() => setEditing((x) => ({ ...x, open: false }))} schedule={editing.schedule} workspaceId={workspaceId} />
      <DeleteScheduleDialog schedule={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}

/** Opens the "new scheduled agent" dialog (for page headers). */
export function NewScheduleButton({ workspaceId, disabled }: { workspaceId?: string; disabled?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)} disabled={disabled}>
        {t('schedule.newTitle')}
      </Button>
      <ScheduleDialog open={open} onClose={() => setOpen(false)} workspaceId={workspaceId} />
    </>
  );
}

function ScheduleRow({ schedule: s, runs, showWorkspace, onEdit, onDelete }: { schedule: Schedule; runs: Task[]; showWorkspace?: boolean; onEdit: () => void; onDelete: () => void }) {
  const t = useT();
  const { lang } = useLanguage();
  const openTask = useOpenTask();
  const recent = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const last = s.lastTaskId ? runs.find((x) => x.id === s.lastTaskId) : undefined;
  const open = recent.find((x) => x.status === 'queued' || x.status === 'running' || x.status === 'review');

  const run = useAction((force: boolean) => rpc('schedule.run', { scheduleId: s.id, force }), {
    success: (r) => (r.result === 'started' ? t('schedule.runStarted') : r.result === 'skipped' ? t('schedule.runSkipped') : undefined),
    error: t('schedule.runFailed'),
    invalidate: [qk.schedules, qk.tasks],
    onSuccess: (r) => r.task && openTask(r.task.id),
  });
  const toggle = useAction(() => rpc('schedule.update', { scheduleId: s.id, enabled: !s.enabled }), {
    success: s.enabled ? t('schedule.paused') : t('schedule.resumed'),
    error: t('common.saveFailed'),
    invalidate: [qk.schedules],
  });

  return (
    <li className={cn('rounded-xl border bg-surface p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]', s.enabled ? 'border-line' : 'border-dashed border-line-strong')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className={cn('mt-0.5 rounded-lg p-2', s.enabled ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-fg-subtle')}>
          <TemplateIcon template={s.template} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onEdit} className="font-semibold text-fg hover:text-accent hover:underline">
              {s.name}
            </button>
            {!s.enabled && <Badge tone="slate">{t('schedule.pausedBadge')}</Badge>}
            {showWorkspace && <WorkspaceTag workspaceId={s.workspaceId} />}
          </div>
          <p className="mt-0.5 text-sm text-fg-muted">
            {describeCron(t, s.cron, lang)}
            {s.timezone && <span className="text-fg-subtle"> · {s.timezone}</span>}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" icon={<Play className="size-3.5" />} loading={run.isPending} onClick={() => run.mutate(!!open)} title={open ? t('schedule.runNowForceHint', { handle: open.handle ?? open.title }) : t('schedule.runNowHint')}>
            {t('schedule.runNow')}
          </Button>
          <Popover
            align="right"
            trigger={({ toggle: toggleMenu }) => (
              <button type="button" onClick={toggleMenu} className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg" aria-label={t('taskCard.menu')}>
                <MoreHorizontal className="size-4" />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), onEdit())}>
                  {t('common.edit')}
                </MenuItem>
                <MenuItem icon={s.enabled ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={() => (close(), toggle.mutate())}>
                  {s.enabled ? t('schedule.pause') : t('schedule.resume')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => (close(), onDelete())}>
                  {t('common.delete')}
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-fg-muted">{t('schedule.next')}</dt>
        <dd className="text-fg">
          {s.enabled && s.nextRunAt ? (
            <span title={formatDateTime(s.nextRunAt, lang)}>
              {formatDateTime(s.nextRunAt, lang)} <span className="text-fg-subtle">({formatRelative(s.nextRunAt, Date.now(), lang)})</span>
            </span>
          ) : (
            <span className="text-fg-muted">{s.enabled ? '–' : t('schedule.pausedHint')}</span>
          )}
        </dd>
        <dt className="text-fg-muted">{t('schedule.last')}</dt>
        <dd className="min-w-0 space-y-1">
          {s.lastRunAt ? (
            <>
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-fg">{formatRelative(s.lastRunAt, Date.now(), lang)}</span>
                {s.lastResult === 'skipped' && <Badge tone="slate">{t('schedule.result.skipped')}</Badge>}
                {s.lastResult === 'error' && <Badge tone="red">{t('schedule.result.error')}</Badge>}
                {s.lastResult === 'started' && last && (
                  <button type="button" onClick={() => openTask(last.id)} className="inline-flex min-w-0 items-center gap-1.5 hover:underline">
                    {last.report ? <ReportBadge report={last.report} /> : <RunStatus task={last} />}
                    <span className="truncate font-mono text-xs text-fg-muted">{last.handle}</span>
                  </button>
                )}
              </span>
              {(s.lastNote || last?.report?.summary) && <p className="line-clamp-2 text-xs text-fg-muted">{s.lastResult === 'started' ? last?.report?.summary : s.lastNote}</p>}
            </>
          ) : (
            <span className="text-fg-muted">{t('schedule.neverRun')}</span>
          )}
        </dd>
        {recent.length > 0 && (
          <>
            <dt className="text-fg-muted">{t('schedule.history')}</dt>
            <dd className="flex flex-wrap items-center gap-1">
              {recent
                .slice(0, HISTORY)
                .reverse()
                .map((x) => (
                  <HistoryDot key={x.id} task={x} onClick={() => openTask(x.id)} />
                ))}
              <span className="ml-1 text-xs text-fg-subtle">{t('schedule.runCount', { count: s.runCount })}</span>
            </dd>
          </>
        )}
      </dl>
    </li>
  );
}

function RunStatus({ task }: { task: Task }) {
  const t = useT();
  const m = taskStatusMeta(t, task.status);
  return (
    <Badge tone={m.tone}>
      <StatusDot tone={m.tone} animated={m.animated} />
      {m.label}
    </Badge>
  );
}

/** One run in the history strip: green = ok, amber = needs you, red = failed, blue = running. */
function HistoryDot({ task, onClick }: { task: Task; onClick: () => void }) {
  const t = useT();
  const { lang } = useLanguage();
  const color =
    task.status === 'failed'
      ? 'bg-red-500'
      : task.status === 'running' || task.status === 'queued'
        ? 'bg-sky-500 animate-pulse'
        : task.report?.status === 'ok'
          ? 'bg-emerald-500'
          : task.status === 'review' || task.report?.status === 'action_needed'
            ? 'bg-amber-400'
            : task.status === 'done'
              ? 'bg-emerald-500/60'
              : 'bg-line-strong';
  const label = task.report ? t(`schedule.report.${task.report.status}`) : taskStatusMeta(t, task.status).label;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('size-3.5 rounded-sm ring-offset-1 ring-offset-surface hover:ring-2 hover:ring-accent', color)}
      title={`${task.handle ?? ''} · ${formatDateTime(task.createdAt, lang)} · ${label}${task.report?.summary ? `\n${task.report.summary}` : ''}`}
      aria-label={`${task.handle ?? task.title}: ${label}`}
    />
  );
}

function DeleteScheduleDialog({ schedule, onClose }: { schedule: Schedule | null; onClose: () => void }) {
  const t = useT();
  const [deleteTasks, setDeleteTasks] = useState(false);
  const remove = useAction((s: Schedule) => rpc('schedule.delete', { scheduleId: s.id, deleteTasks }), {
    success: t('schedule.deleted'),
    error: t('common.deleteFailed'),
    invalidate: [qk.schedules, qk.tasks],
    onSuccess: () => (setDeleteTasks(false), onClose()),
  });
  return (
    <Dialog
      open={!!schedule}
      onClose={onClose}
      size="sm"
      dismissable={!remove.isPending}
      title={t('schedule.deleteTitle', { name: schedule?.name ?? '' })}
      footer={
        <>
          <Button onClick={onClose} disabled={remove.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => schedule && remove.mutate(schedule)}>
            {t('common.delete')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-fg-muted">
        <p>{t('schedule.deleteText')}</p>
        <Checkbox checked={deleteTasks} onChange={setDeleteTasks} label={t('schedule.deleteTasks')} description={t('schedule.deleteTasksHint')} />
      </div>
    </Dialog>
  );
}
