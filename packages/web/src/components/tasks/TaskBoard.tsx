import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Task, TaskStatus } from '@cocoon/protocol';
import { Plus } from 'lucide-react';
import { qk } from '../../api/keys';
import { useAgents, useSettings } from '../../api/queries';
import { describeError, rpc } from '../../api/rpc';
import { rich, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { moveKind, orderAt, sortByOrder, TASK_COLUMNS, taskStatusMeta } from '../../lib/tasks';
import { useAppDialogs } from '../AppDialogs';
import { StatusDot } from '../Badge';
import { ConfirmDialog } from '../Dialog';
import { InfoTip } from '../HelpText';
import { useToast } from '../Toast';
import { TaskCard } from './TaskCard';
import { useStoreTask, useTaskActions } from './useTaskActions';

const DRAG_TYPE = 'application/x-cocoon-task';

interface DropTarget {
  status: TaskStatus;
  index: number;
}

/**
 * Kanban board: Backlog / Ready / Running / Review / Done / Failed.
 * Cards can be dragged between columns (start, stop, approve or just move) and reordered within a column.
 */
export function TaskBoard({
  tasks,
  allTasks,
  workspaceId,
  compact,
  showWorkspace,
}: {
  /** Tasks shown on this board (already filtered by workspace). */
  tasks: Task[];
  /** All known tasks (for dependency lookups across the workspace). */
  allTasks: Task[];
  /** Workspace for "new task" buttons (none = the dialog asks). */
  workspaceId?: string;
  compact?: boolean;
  showWorkspace?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useSettings();
  const agents = useAgents();
  const dialogs = useAppDialogs();
  const store = useStoreTask();
  const { remove } = useTaskActions();
  const [dragId, setDragId] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [toDelete, setToDelete] = useState<Task | null>(null);
  const columnsRef = useRef<HTMLDivElement>(null);

  const columns = useMemo(() => {
    const by: Record<TaskStatus, Task[]> = { backlog: [], queued: [], running: [], review: [], done: [], failed: [] };
    for (const task of tasks) (by[task.status] ?? by.backlog).push(task);
    for (const s of TASK_COLUMNS) by[s].sort(sortByOrder);
    // Newest first in the "finished" columns.
    by.done.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return by;
  }, [tasks]);

  const dragged = dragId ? tasks.find((x) => x.id === dragId) : undefined;

  const drop = async (task: Task, to: DropTarget) => {
    const kind = moveKind(task.status, to.status);
    if (kind === 'forbidden') {
      toast.info(t('board.cannotMove'), t(`board.cannotMove.${to.status === 'review' ? 'review' : 'running'}`));
      return;
    }
    const column = columns[to.status].filter((x) => x.id !== task.id);
    const order = orderAt(column, to.index);
    const snapshot = qc.getQueryData<Task[]>(qk.tasks);
    // Optimistic: show the card at its new place right away.
    if (kind === 'reorder' || kind === 'update') {
      qc.setQueryData<Task[]>(qk.tasks, (old) => old?.map((x) => (x.id === task.id ? { ...x, status: to.status, order } : x)));
    }
    try {
      let result: Task;
      if (kind === 'start') result = await rpc('task.start', { taskId: task.id });
      else if (kind === 'stop') result = await rpc('task.stop', { taskId: task.id });
      else if (kind === 'approve') result = await rpc('task.approve', { taskId: task.id });
      else result = await rpc('task.update', kind === 'reorder' ? { taskId: task.id, order } : { taskId: task.id, status: to.status, order });
      store(result);
      if (kind === 'start') toast.success(t('taskAction.started'));
      if (kind === 'stop') toast.success(t('taskAction.stopped'));
      if (kind === 'approve') toast.success(result.status === 'done' ? t('taskAction.approvedDone') : t('taskAction.approvedNext'));
    } catch (err) {
      if (snapshot) qc.setQueryData(qk.tasks, snapshot);
      toast.error(t('board.moveFailed'), describeError(err));
    }
  };

  const endDrag = () => {
    setDragId(null);
    setTarget(null);
  };

  /** Index within the column where the pointer is (between cards). */
  const indexFromPointer = (status: TaskStatus, e: React.DragEvent) => {
    const list = e.currentTarget.querySelectorAll<HTMLElement>('[data-task-card]');
    let index = 0;
    for (const el of Array.from(list)) {
      if (el.dataset.taskCard === dragId) continue;
      const r = el.getBoundingClientRect();
      if (e.clientY > r.top + r.height / 2) index++;
    }
    return { status, index };
  };

  return (
    <>
      <div ref={columnsRef} className={cn('flex gap-3 overflow-x-auto pb-2', compact ? 'h-full' : 'min-h-[60vh]')}>
        {TASK_COLUMNS.map((status) => {
          const meta = taskStatusMeta(t, status);
          const list = columns[status];
          const kind = dragged ? moveKind(dragged.status, status) : null;
          const forbidden = kind === 'forbidden';
          const isTarget = target?.status === status && !forbidden;
          return (
            <section
              key={status}
              className={cn(
                'flex shrink-0 flex-col rounded-xl border bg-surface-2/50 transition-colors',
                compact ? 'w-60' : 'w-[272px] xl:w-auto xl:min-w-[220px] xl:flex-1',
                isTarget ? 'border-accent bg-accent-soft/50' : 'border-line',
                dragged && forbidden && 'opacity-50',
              )}
              onDragOver={(e) => {
                if (!dragId || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = forbidden ? 'none' : 'move';
                const next = indexFromPointer(status, e);
                if (next.status !== target?.status || next.index !== target?.index) setTarget(next);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setTarget((x) => (x?.status === status ? null : x));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData(DRAG_TYPE) || dragId;
                const task = tasks.find((x) => x.id === id);
                const to = indexFromPointer(status, e);
                endDrag();
                if (task) void drop(task, to);
              }}
            >
              <header className={cn('flex items-center gap-2 px-3', compact ? 'py-2' : 'py-2.5')}>
                <StatusDot tone={meta.tone} animated={meta.animated && list.length > 0} />
                <h3 className="text-sm font-semibold text-fg">{meta.label}</h3>
                <span className="rounded-full bg-surface px-1.5 text-xs text-fg-muted ring-1 ring-line">{list.length}</span>
                {!compact && <InfoTip>{meta.explanation}</InfoTip>}
                <span className="flex-1" />
                {(status === 'backlog' || status === 'queued') && (
                  <button
                    type="button"
                    onClick={() => dialogs.task({ workspaceId, initialStatus: status })}
                    className="rounded-md p-1 text-fg-subtle hover:bg-surface hover:text-fg"
                    aria-label={t('board.addTo', { column: meta.label })}
                    title={t('board.addTo', { column: meta.label })}
                  >
                    <Plus className="size-4" />
                  </button>
                )}
              </header>
              <div className={cn('flex-1 space-y-2 overflow-y-auto px-2 pb-2', compact && 'min-h-0')}>
                {list.map((task, i) => (
                  <div key={task.id} data-task-card={task.id}>
                    {isTarget && dragId !== task.id && target!.index === list.slice(0, i).filter((x) => x.id !== dragId).length && <DropLine />}
                    <TaskCard
                      task={task}
                      allTasks={allTasks}
                      agent={task.agentId ? agents.data?.find((a) => a.id === task.agentId) : undefined}
                      settings={settings.data}
                      compact={compact}
                      showWorkspace={showWorkspace}
                      dragging={dragId === task.id}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_TYPE, task.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDragId(task.id);
                      }}
                      onDragEnd={endDrag}
                      onDelete={setToDelete}
                    />
                  </div>
                ))}
                {isTarget && target!.index >= list.filter((x) => x.id !== dragId).length && <DropLine />}
                {list.length === 0 && !isTarget && (
                  <p className="px-2 py-6 text-center text-xs leading-relaxed text-fg-subtle">{t(`board.empty.${status}`)}</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        danger
        loading={remove.isPending}
        title={t('board.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={rich(t(toDelete?.status === 'running' ? 'board.deleteRunning' : 'board.deleteText'), { task: <strong className="text-fg">{toDelete?.title}</strong> })}
        onConfirm={() => toDelete && remove.mutate(toDelete.id, { onSuccess: () => setToDelete(null) })}
      />
    </>
  );
}

function DropLine() {
  return <div className="mx-1 my-1 h-0.5 rounded-full bg-accent" />;
}
