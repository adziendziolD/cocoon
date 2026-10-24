import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { localize, type Task, type TaskRun } from '@cocoon/protocol';
import {
  GitBranch,
  CircleDot,
  GitPullRequest,
  Bot,
  Check,
  CheckCheck,
  CircleStop,
  ExternalLink,
  FileDiff,
  Hand,
  Link2,
  MessageSquareReply,
  MonitorPlay,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react';
import { useAgents, useSandboxes, useSchedules, useSettings, useTask, useTasks, useWorkspaces } from '../../api/queries';
import { isNotFound, rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { rich, useLanguage, useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { formatDateTime, formatRelative } from '../../lib/format';
import { openDependencies, taskRunLabel } from '../../lib/tasks';
import { AgentConsole } from '../AgentConsole';
import { useAppDialogs } from '../AppDialogs';
import { AgentStatusBadge, Badge } from '../Badge';
import { Button, ButtonLink } from '../Button';
import { ConfirmDialog } from '../Dialog';
import { CopyButton } from '../CodeBlock';
import { Callout } from '../HelpText';
import { ErrorState, LoadingState } from '../States';
import { ReportBadge, ScheduledTag } from '../schedules/ScheduleBits';
import { WorkspaceTag } from '../WorkspaceSwitcher';
import { PriorityIcon, StageChips, TaskStatusBadge } from './TaskBits';
import { useOpenInCockpit, useOpenTask, useTaskActions } from './useTaskActions';

/** Slide-over with everything about one task. Opened anywhere via `?task=<id>` (see useOpenTask). */
export function TaskDrawer() {
  const [params] = useSearchParams();
  const taskId = params.get('task');
  const openTask = useOpenTask();
  const t = useT();

  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => {
      // Only when focus is not inside a dialog or the drawer's terminal.
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]') && !(e.target as HTMLElement)?.closest?.('.xterm')) openTask(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [taskId, openTask]);

  if (!taskId) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={() => openTask(null)} />
      <aside
        className="animate-in relative flex h-full w-full max-w-[min(820px,100vw)] flex-col border-l border-line bg-canvas shadow-2xl"
        aria-label={t('taskDrawer.label')}
      >
        <TaskDrawerContent taskId={taskId} onClose={() => openTask(null)} />
      </aside>
    </div>,
    document.body,
  );
}

function TaskDrawerContent({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const t = useT();
  const tasks = useTasks();
  const listed = tasks.data?.find((x) => x.id === taskId);
  // Fall back to task.get for tasks not (yet) in the list.
  const single = useTask(listed ? null : taskId);
  const task = listed ?? single.data;

  if (!task) {
    return (
      <>
        <DrawerHeader onClose={onClose} title={t('taskDrawer.label')} />
        <div className="p-6">
          {tasks.isLoading || single.isLoading ? (
            <LoadingState />
          ) : isNotFound(single.error) || !single.error ? (
            <Callout tone="info" title={t('taskDrawer.notFound')}>
              {t('taskDrawer.notFoundText')}
            </Callout>
          ) : (
            <ErrorState error={single.error} onRetry={() => single.refetch()} />
          )}
        </div>
      </>
    );
  }
  return <TaskDetail task={task} allTasks={tasks.data ?? []} onClose={onClose} />;
}

function DrawerHeader({ title, onClose, children }: { title: ReactNode; onClose: () => void; children?: ReactNode }) {
  const t = useT();
  return (
    <div className="flex items-start gap-3 border-b border-line bg-surface px-5 py-4">
      <div className="min-w-0 flex-1">
        {children}
        <h2 className="text-lg font-semibold break-words text-fg">{title}</h2>
      </div>
      <button onClick={onClose} className="rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg" aria-label={t('common.close')}>
        <X className="size-5" />
      </button>
    </div>
  );
}

function TaskDetail({ task, allTasks, onClose }: { task: Task; allTasks: Task[]; onClose: () => void }) {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const agents = useAgents();
  const sandboxes = useSandboxes();
  const schedule = useSchedules().data?.find((x) => x.id === task.scheduleId);
  const dialogs = useAppDialogs();
  const openTask = useOpenTask();
  const openInCockpit = useOpenInCockpit();
  const { start, approve, markFinished, stop, remove, update } = useTaskActions();
  const reviewOnApprove = useWorkspaces().data?.find((w) => w.id === task.workspaceId)?.review?.enabled;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const agent = task.agentId ? agents.data?.find((a) => a.id === task.agentId) : undefined;
  const sandbox = task.sandboxId ? sandboxes.data?.find((s) => s.id === task.sandboxId) : undefined;
  const run = taskRunLabel(task, settings.data, lang);
  const wf = task.workflowId ? settings.data?.workflows[task.workflowId] : undefined;
  const deps = task.dependsOn.map((id) => allTasks.find((x) => x.id === id)).filter((x): x is Task => !!x);
  const open = openDependencies(task, allTasks);
  const s = task.status;
  const keys = useAction((k: string[]) => rpc('agent.send_keys', { agentId: task.agentId!, keys: k }), { error: t('agentDetail.keysFailed') });

  return (
    <>
      <DrawerHeader
        onClose={onClose}
        title={
          <span className="flex items-start gap-2">
            <PriorityIcon priority={task.priority} className="mt-1.5" />
            <span>
              {task.handle && <span className="mr-2 font-mono text-sm font-semibold text-fg-subtle">{task.handle}</span>}
              {task.title}
            </span>
          </span>
        }
      >
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <WorkspaceTag workspaceId={task.workspaceId} />
          <TaskStatusBadge status={s} />
          {task.priority !== 'normal' && <Badge tone={task.priority === 'high' ? 'red' : 'slate'}>{t(`task.priority.${task.priority}`)}</Badge>}
        </div>
      </DrawerHeader>

      <div className="flex-1 space-y-5 overflow-y-auto p-5">
        {task.attention && s === 'running' && (
          <div className="rounded-2xl border-2 border-amber-400 bg-amber-400/15 p-4">
            <div className="flex items-start gap-3">
              <Hand className="mt-0.5 size-5 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-fg">{t('taskDrawer.attentionTitle')}</div>
                <p className="mt-0.5 text-sm text-fg-muted">{t('taskDrawer.attentionText')}</p>
                {task.agentId && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="success" icon={<Check className="size-3.5" />} loading={keys.isPending && keys.variables?.[0] === 'Enter'} onClick={() => keys.mutate(['Enter'])}>
                      {t('common.yes')}
                    </Button>
                    <Button size="sm" icon={<X className="size-3.5" />} loading={keys.isPending && keys.variables?.[0] === 'Escape'} onClick={() => keys.mutate(['Escape'])}>
                      {t('agentDetail.noCancel')}
                    </Button>
                    <Button size="sm" variant="ghost" icon={<MonitorPlay className="size-3.5" />} onClick={() => openInCockpit(task.agentId!, task.workspaceId)}>
                      {t('taskCard.openInCockpit')}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {s === 'review' && (
          <div className="rounded-2xl border-2 border-amber-400/70 bg-amber-400/10 p-4">
            <div className="font-semibold text-fg">{wf && task.stage < wf.stages.length - 1 ? t('taskDrawer.reviewStageTitle') : t('taskDrawer.reviewTitle')}</div>
            <p className="mt-0.5 text-sm text-fg-muted">{wf && task.stage < wf.stages.length - 1 ? t('taskDrawer.reviewStageText') : t('taskDrawer.reviewText')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="success" icon={<Check className="size-3.5" />} loading={approve.isPending} onClick={() => approve.mutate(task.id)} title={reviewOnApprove ? t('taskCard.approveReviewHint') : undefined}>
                {wf && task.stage < wf.stages.length - 1 ? t('taskDrawer.approveNext') : t('taskCard.approve')}
              </Button>
              <Button size="sm" icon={<MessageSquareReply className="size-3.5" />} onClick={() => dialogs.reject(task)}>
                {t('taskCard.reject')}
              </Button>
              {task.sandboxId && (
                <ButtonLink size="sm" variant="ghost" icon={<FileDiff className="size-3.5" />} to={`/sandboxes/${task.sandboxId}/changes`} onClick={onClose}>
                  {t('taskDrawer.viewChanges')}
                </ButtonLink>
              )}
            </div>
          </div>
        )}

        {s === 'failed' && task.note && <Callout tone="danger" title={t('task.status.failed')}>{task.note}</Callout>}

        <div className="flex flex-wrap gap-2">
          {(s === 'backlog' || s === 'queued' || s === 'failed') && (
            <Button variant="primary" size="sm" icon={s === 'failed' ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />} loading={start.isPending} onClick={() => start.mutate(task.id)} disabled={open.length > 0 && s !== 'failed'}>
              {s === 'failed' ? t('taskCard.retry') : t('taskCard.start')}
            </Button>
          )}
          {s === 'failed' && (
            <Button size="sm" icon={<CheckCheck className="size-3.5" />} loading={markFinished.isPending} onClick={() => markFinished.mutate(task.id)} title={t('taskCard.markFinishedHint')}>
              {t('taskCard.markFinished')}
            </Button>
          )}
          {s === 'backlog' && (
            <Button size="sm" loading={update.isPending} onClick={() => update.mutate({ taskId: task.id, status: 'queued' })} title={t('taskDialog.toQueueHint')}>
              {t('taskDrawer.toQueue')}
            </Button>
          )}
          {s === 'running' && (
            <Button size="sm" icon={<CircleStop className="size-3.5" />} loading={stop.isPending} onClick={() => stop.mutate(task.id)}>
              {t('taskCard.stop')}
            </Button>
          )}
          {task.agentId && (
            <Button size="sm" icon={<MonitorPlay className="size-3.5" />} onClick={() => openInCockpit(task.agentId!, task.workspaceId)}>
              {t('taskCard.openInCockpit')}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => dialogs.task({ task })}>
            {t('common.edit')}
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(true)}>
            {t('common.delete')}
          </Button>
        </div>

        {task.note && s !== 'failed' && <p className="text-sm text-fg-muted italic">{task.note}</p>}

        {task.report && (
          <Section title={t('schedule.reportTitle')} action={<ReportBadge report={task.report} />}>
            {task.report.summary && <p className="mb-2 text-sm font-medium text-fg">{task.report.summary}</p>}
            {task.report.details ? (
              <pre className="max-h-96 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">{task.report.details}</pre>
            ) : (
              task.report.status === 'missing' && <p className="text-sm text-fg-muted">{t('schedule.reportMissing')}</p>
            )}
          </Section>
        )}

        <Section title={t('taskDrawer.description')}>
          {task.description ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg">{task.description}</p>
          ) : (
            <p className="text-sm text-fg-muted">{t('taskDrawer.noDescription')}</p>
          )}
        </Section>

        <Section title={t('taskDrawer.details')}>
          <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-fg-muted">{t('taskDialog.runWith')}</dt>
            <dd className="min-w-0 space-y-1.5 text-fg">
              <span className="inline-flex items-center gap-1.5">
                {run.kind === 'workflow' ? <WorkflowIcon className="size-4 text-fg-muted" /> : <Bot className="size-4 text-fg-muted" />}
                {run.label}
              </span>
              {wf && <StageChips workflow={wf} current={s === 'backlog' || s === 'queued' ? undefined : s === 'done' ? wf.stages.length : task.stage} small />}
            </dd>
            {(task.providers?.length || task.model) && (
              <>
                <dt className="text-fg-muted">{t('agentDetail.model')}</dt>
                <dd className="font-mono text-xs text-fg">
                  {[task.providers?.map((id) => settings.data?.providers[id]?.label ?? id).join(', '), task.model].filter(Boolean).join(' · ')}
                </dd>
              </>
            )}
            {deps.length > 0 && (
              <>
                <dt className="text-fg-muted">{t('taskDialog.dependsOn')}</dt>
                <dd className="space-y-1">
                  {deps.map((d) => (
                    <button key={d.id} type="button" onClick={() => openTask(d.id)} className="flex w-full items-center gap-2 text-left hover:underline">
                      <Link2 className="size-3.5 text-fg-subtle" />
                      <span className="min-w-0 flex-1 truncate">{d.title}</span>
                      <TaskStatusBadge status={d.status} />
                    </button>
                  ))}
                  {open.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-400">{t('taskDrawer.waitingForDeps', { count: open.length })}</p>}
                </dd>
              </>
            )}
            {task.branch && (
              <>
                <dt className="text-fg-muted">{t('taskDrawer.branch')}</dt>
                <dd className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-fg">
                  <GitBranch className="size-3.5 shrink-0 text-fg-subtle" />
                  <span className="truncate">{task.branch}</span>
                  <CopyButton text={task.branch} />
                </dd>
              </>
            )}
            {task.scheduleId && (
              <>
                <dt className="text-fg-muted">{t('schedule.scheduled')}</dt>
                <dd className="min-w-0">
                  <Link to={`/workspaces/${task.workspaceId}/schedules`} onClick={onClose} className="hover:underline">
                    <ScheduledTag name={schedule?.name} />
                  </Link>
                </dd>
              </>
            )}
            {task.issue && /^https:\/\//.test(task.issue.url) && (
              <>
                <dt className="text-fg-muted">{t('taskDrawer.issue')}</dt>
                <dd>
                  <a href={task.issue.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-accent hover:underline">
                    <CircleDot className="size-3.5" />
                    <span className="truncate">{task.issue.repo}#{task.issue.number}</span>
                  </a>
                </dd>
              </>
            )}
            {(task.pullRequests ?? []).length > 0 && (
              <>
                <dt className="text-fg-muted">{t('taskDrawer.pullRequests')}</dt>
                <dd className="space-y-1">
                  {(task.pullRequests ?? []).map((pr) => (
                    <a key={pr.url} href={pr.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-accent hover:underline">
                      <GitPullRequest className="size-3.5" />
                      <span className="truncate">{pr.repo ? `${pr.repo}: ` : ''}{pr.url.replace(/^https:\/\/github\.com\//, '')}</span>
                    </a>
                  ))}
                </dd>
              </>
            )}
            {((task.reviews ?? []).length > 0 || task.reviewStep !== undefined) && (
              <>
                <dt className="text-fg-muted">{t('taskDrawer.reviews')}</dt>
                <dd className="space-y-2">
                  {task.reviewStep !== undefined && <p className="text-xs text-fg-muted">{t('taskDrawer.reviewRunning')}</p>}
                  {(task.reviews ?? []).map((r) => (
                    <div key={r.agentId} className="text-xs">
                      <span className="flex items-center gap-1.5">
                        <Badge tone={r.verdict === 'approved' ? 'green' : r.verdict === 'changes_requested' ? 'amber' : 'gray'}>{t(`taskDrawer.verdict.${r.verdict}`)}</Badge>
                        <span className="text-fg-muted">{settings.data?.agents[r.agentKind]?.label ? String(localize(settings.data.agents[r.agentKind]!.label, lang)) : r.agentKind}</span>
                      </span>
                      {r.summary && <p className="mt-1 whitespace-pre-wrap text-fg">{r.summary}</p>}
                    </div>
                  ))}
                </dd>
              </>
            )}
            <dt className="text-fg-muted">{t('taskDrawer.sandbox')}</dt>
            <dd className="min-w-0">
              {task.sandboxId ? (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link to={`/sandboxes/${task.sandboxId}`} onClick={onClose} className="text-accent hover:underline">
                    {sandbox?.name ?? task.sandboxId}
                  </Link>
                  <Link to={`/sandboxes/${task.sandboxId}/changes`} onClick={onClose} className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg hover:underline">
                    <FileDiff className="size-3.5" /> {t('taskDrawer.viewChanges')}
                  </Link>
                </span>
              ) : (
                <span className="text-fg-muted">{t('taskDrawer.noSandbox')}</span>
              )}
            </dd>
            <dt className="text-fg-muted">{t('taskDrawer.created')}</dt>
            <dd className="text-fg">{formatDateTime(task.createdAt, lang)}</dd>
            <dt className="text-fg-muted">{t('taskDrawer.updated')}</dt>
            <dd className="text-fg">{formatRelative(task.updatedAt, Date.now(), lang)}</dd>
          </dl>
        </Section>

        <Section title={t('taskDrawer.timeline')}>
          {task.runs.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('taskDrawer.noRuns')}</p>
          ) : (
            <ol className="relative space-y-3 border-l border-line pl-5">
              {task.runs.map((r, i) => (
                <RunItem key={`${r.agentId}-${i}`} run={r} current={r.agentId === task.agentId} onNavigate={onClose} />
              ))}
            </ol>
          )}
        </Section>

        {task.agentId && (
          <Section
            title={t('taskDrawer.terminal')}
            action={
              agent && (
                <span className="flex items-center gap-2">
                  <AgentStatusBadge status={agent.status} />
                  <Link to={`/agents/${agent.id}`} onClick={onClose} className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg hover:underline">
                    <ExternalLink className="size-3.5" /> {t('taskDrawer.agentPage')}
                  </Link>
                </span>
              )
            }
          >
            {agent ? (
              <div className="relative h-[380px] overflow-hidden rounded-xl border border-line">
                <AgentConsole agent={agent} sandboxStatus={sandbox?.status} autoFocus={false} compact />
              </div>
            ) : (
              <p className="text-sm text-fg-muted">{agents.isLoading ? t('common.loading') : t('taskDrawer.agentGone')}</p>
            )}
          </Section>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        danger
        loading={remove.isPending}
        title={t('board.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={rich(t(s === 'running' ? 'board.deleteRunning' : 'board.deleteText'), { task: <strong className="text-fg">{task.title}</strong> })}
        onConfirm={() =>
          remove.mutate(task.id, {
            onSuccess: () => {
              setConfirmDelete(false);
              onClose();
            },
          })
        }
      />
    </>
  );
}

function Section({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

const OUTCOME_TONE = { running: 'blue', finished: 'green', failed: 'red', stopped: 'slate' } as const;

function RunItem({ run, current, onNavigate }: { run: TaskRun; current: boolean; onNavigate: () => void }) {
  const t = useT();
  const { lang } = useLanguage();
  return (
    <li className="relative">
      <span className={cn('absolute top-1.5 -left-[25px] size-2.5 rounded-full ring-4 ring-canvas', run.outcome === 'running' ? 'animate-status bg-blue-500' : run.outcome === 'finished' ? 'bg-emerald-500' : run.outcome === 'failed' ? 'bg-red-500' : 'bg-slate-400')} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">
          {t('taskDrawer.stage', { n: run.stage + 1 })} · {run.stageName}
        </span>
        <Badge tone={OUTCOME_TONE[run.outcome]}>{t(`taskDrawer.outcome.${run.outcome}`)}</Badge>
        {current && <Badge tone="accent">{t('taskDrawer.current')}</Badge>}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-fg-muted">
        <span>
          {formatDateTime(run.startedAt, lang)}
          {run.finishedAt && ` – ${formatDateTime(run.finishedAt, lang)}`}
        </span>
        <Link to={`/agents/${run.agentId}`} onClick={onNavigate} className="text-accent hover:underline">
          {t('taskDrawer.openAgent')}
        </Link>
      </div>
    </li>
  );
}
