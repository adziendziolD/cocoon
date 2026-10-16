import type { Agent, Settings, Task } from '@cocoon/protocol';
import { Bot, Check, CircleStop, Hand, Link2, MessageSquareReply, MonitorPlay, MoreHorizontal, Pencil, Play, RotateCcw, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { useLanguage, useT } from '../../i18n';
import { useSchedules, useWorkspaces } from '../../api/queries';
import { cn } from '../../lib/cn';
import { agentStatusMeta } from '../../lib/status';
import { openDependencies, taskRunLabel } from '../../lib/tasks';
import { useAppDialogs } from '../AppDialogs';
import { StatusDot } from '../Badge';
import { Button } from '../Button';
import { MenuItem, MenuSeparator, Popover } from '../Popover';
import { ReportBadge, ScheduledTag } from '../schedules/ScheduleBits';
import { WorkspaceTag } from '../WorkspaceSwitcher';
import { PriorityIcon } from './TaskBits';
import { useOpenInCockpit, useOpenTask, useTaskActions } from './useTaskActions';

export interface TaskCardProps {
  task: Task;
  allTasks: Task[];
  agent?: Agent;
  settings?: Settings;
  compact?: boolean;
  showWorkspace?: boolean;
  dragging?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDelete?: (task: Task) => void;
}

/** A task on the board: what it is, how far it got, what it needs from you – plus one-click actions. */
export function TaskCard({ task, allTasks, agent, settings, compact, showWorkspace, dragging, onDragStart, onDragEnd, onDelete }: TaskCardProps) {
  const t = useT();
  const { lang } = useLanguage();
  const openTask = useOpenTask();
  const openInCockpit = useOpenInCockpit();
  const dialogs = useAppDialogs();
  const { start, approve, stop } = useTaskActions();
  const schedules = useSchedules();
  const scheduleName = task.scheduleId ? schedules.data?.find((x) => x.id === task.scheduleId)?.name : undefined;
  const reviewOnApprove = useWorkspaces().data?.find((w) => w.id === task.workspaceId)?.review?.enabled;
  const run = taskRunLabel(task, settings, lang);
  const deps = openDependencies(task, allTasks);
  const s = task.status;
  const attention = task.attention && s === 'running';
  const busy = (m: { isPending: boolean; variables?: unknown }) => m.isPending && m.variables === task.id;

  return (
    <div
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => openTask(task.id)}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && openTask(task.id)}
      tabIndex={0}
      role="button"
      aria-label={task.title}
      className={cn(
        'group cursor-pointer rounded-xl border bg-surface text-left shadow-[0_1px_2px_rgba(16,24,40,0.05)] transition-all hover:border-line-strong hover:shadow-sm focus-visible:outline-2 focus-visible:outline-accent',
        compact ? 'p-2.5' : 'p-3',
        attention ? 'border-amber-400 ring-2 ring-amber-400/40' : s === 'review' ? 'border-amber-400/60' : s === 'failed' ? 'border-red-500/40' : 'border-line',
        dragging && 'opacity-40',
      )}
    >
      {attention && (
        <div className="-mx-0.5 -mt-0.5 mb-2 flex items-center gap-1.5 rounded-lg bg-amber-400 px-2 py-1 text-xs font-semibold text-amber-950">
          <Hand className="size-3.5" />
          <span className="flex-1">{t('taskCard.needsYou')}</span>
        </div>
      )}
      <div className="flex items-start gap-1.5">
        <PriorityIcon priority={task.priority} className="mt-0.5" />
        <div className={cn('min-w-0 flex-1 font-medium text-fg', compact ? 'line-clamp-2 text-[13px]' : 'line-clamp-3 text-sm')}>
          {task.handle && <span className="mr-1.5 font-mono text-[11px] font-semibold text-fg-subtle">{task.handle}</span>}
          {task.title}
        </div>
        <span onClick={(e) => e.stopPropagation()} className="-mt-1 -mr-1">
          <Popover
            align="right"
            trigger={({ toggle }) => (
              <button
                type="button"
                onClick={toggle}
                className="rounded-md p-1 text-fg-subtle opacity-0 group-hover:opacity-100 hover:bg-surface-2 hover:text-fg focus:opacity-100"
                aria-label={t('taskCard.menu')}
              >
                <MoreHorizontal className="size-4" />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), dialogs.task({ task }))}>
                  {t('common.edit')}
                </MenuItem>
                {task.agentId && (
                  <MenuItem icon={<MonitorPlay className="size-4" />} onClick={() => (close(), openInCockpit(task.agentId!, task.workspaceId))}>
                    {t('taskCard.openInCockpit')}
                  </MenuItem>
                )}
                {onDelete && (
                  <>
                    <MenuSeparator />
                    <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => (close(), onDelete(task))}>
                      {t('common.delete')}
                    </MenuItem>
                  </>
                )}
              </>
            )}
          </Popover>
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
        <span className="inline-flex min-w-0 items-center gap-1" title={run.label}>
          {run.kind === 'workflow' ? <WorkflowIcon className="size-3.5 shrink-0" /> : <Bot className="size-3.5 shrink-0" />}
          <span className="truncate">{run.stage && s !== 'backlog' && s !== 'queued' ? run.stage : run.label}</span>
        </span>
        {deps.length > 0 && (
          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400" title={deps.map((d) => `• ${d.title}`).join('\n')}>
            <Link2 className="size-3.5" />
            {t('taskCard.blockedBy', { count: deps.length })}
          </span>
        )}
        {task.scheduleId && <ScheduledTag name={scheduleName} />}
        {task.report && <ReportBadge report={task.report} />}
        {showWorkspace && <WorkspaceTag workspaceId={task.workspaceId} />}
      </div>

      {task.note && (
        <p className={cn('mt-1.5 line-clamp-2 text-xs', s === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-fg-subtle')}>{task.note}</p>
      )}

      {agent && (s === 'running' || s === 'review') && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openInCockpit(agent.id, task.workspaceId);
          }}
          className="mt-2 flex w-full items-center gap-1.5 rounded-md bg-surface-2/70 px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
          title={t('taskCard.openInCockpit')}
        >
          <StatusDot tone={agentStatusMeta(t, agent.status).tone} animated={agentStatusMeta(t, agent.status).animated} />
          <span className="flex-1 truncate text-left">{agentStatusMeta(t, agent.status).label}</span>
          <MonitorPlay className="size-3.5" />
        </button>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5 empty:hidden" onClick={(e) => e.stopPropagation()}>
        {(s === 'backlog' || s === 'queued') && (
          <Button size="sm" icon={<Play className="size-3.5" />} loading={busy(start)} onClick={() => start.mutate(task.id)} disabled={deps.length > 0} title={deps.length ? t('taskCard.depsFirst') : t('taskCard.startHint')}>
            {t('taskCard.start')}
          </Button>
        )}
        {s === 'failed' && (
          <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={busy(start)} onClick={() => start.mutate(task.id)}>
            {t('taskCard.retry')}
          </Button>
        )}
        {s === 'review' && (
          <>
            <Button size="sm" variant="success" icon={<Check className="size-3.5" />} loading={busy(approve)} onClick={() => approve.mutate(task.id)} title={reviewOnApprove ? t('taskCard.approveReviewHint') : t('taskCard.approveHint')}>
              {t('taskCard.approve')}
            </Button>
            <Button size="sm" icon={<MessageSquareReply className="size-3.5" />} onClick={() => dialogs.reject(task)} title={t('taskCard.rejectHint')}>
              {t('taskCard.reject')}
            </Button>
          </>
        )}
        {attention && task.agentId && (
          <Button size="sm" variant="warning" icon={<Hand className="size-3.5" />} onClick={() => openInCockpit(task.agentId!, task.workspaceId)}>
            {t('taskCard.answer')}
          </Button>
        )}
        {s === 'running' && !compact && (
          <Button size="sm" variant="ghost" icon={<CircleStop className="size-3.5" />} loading={busy(stop)} onClick={() => stop.mutate(task.id)} title={t('taskCard.stopHint')}>
            {t('taskCard.stop')}
          </Button>
        )}
      </div>
    </div>
  );
}
