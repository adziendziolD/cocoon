import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Bot, Box, CircleAlert, ClipboardCheck, Hand, Hourglass, Layers, MonitorPlay, Plus, Sparkles, TriangleAlert } from 'lucide-react';
import { useActivity, useAgents, useSandboxes, useSetupStatus, useTasks, useWorkspaces } from '../api/queries';
import { useAppDialogs } from '../components/AppDialogs';
import { TaskStatusBadge } from '../components/tasks/TaskBits';
import { useOpenTask } from '../components/tasks/useTaskActions';
import { WorkspaceDot, WorkspaceTag } from '../components/WorkspaceSwitcher';
import { workspaceStats } from './WorkspacesPage';
import { ActivityList } from '../components/ActivityList';
import { AgentList, sortAgents } from '../components/AgentList';
import { Button, ButtonLink } from '../components/Button';
import { Card, CardHeader, PageHeader } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { SectionTitle, useOpenCreateSandbox } from '../components/Layout';
import { SetupChecklist } from '../components/SetupChecklist';
import { ErrorState, LoadingState } from '../components/States';
import { useT } from '../i18n';
import { cn } from '../lib/cn';

export function DashboardPage() {
  const t = useT();
  const sandboxes = useSandboxes();
  const agents = useAgents();
  const activity = useActivity();
  const setup = useSetupStatus();
  const openCreate = useOpenCreateSandbox();
  const tasks = useTasks();
  const workspaces = useWorkspaces();
  const dialogs = useAppDialogs();
  const openTask = useOpenTask();
  const review = (tasks.data ?? []).filter((x) => x.status === 'review').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  const allAgents = agents.data ?? [];
  const blocked = sortAgents(allAgents.filter((a) => a.status === 'blocked'));
  const broken = (sandboxes.data ?? []).filter((s) => s.status === 'error' || s.status === 'missing');
  const active = sortAgents(allAgents.filter((a) => a.status === 'working' || a.status === 'done' || a.status === 'idle'));
  const running = (sandboxes.data ?? []).filter((s) => s.status === 'running').length;
  const working = allAgents.filter((a) => a.status === 'working').length;

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.description')}
        actions={
          <>
            <ButtonLink to="/cockpit" icon={<MonitorPlay className="size-4" />}>
              {t('dashboard.openCockpit')}
            </ButtonLink>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
              {t('dashboard.newSandbox')}
            </Button>
          </>
        }
      />

      <SetupChecklist />

      {(blocked.length > 0 || broken.length > 0 || review.length > 0) && (
        <section className="mb-8">
          <div className="rounded-2xl border-2 border-amber-400/70 bg-amber-400/10 p-5">
            <div className="mb-4 flex items-center gap-2.5">
              <TriangleAlert className="size-5 text-amber-600 dark:text-amber-400" />
              <h2 className="flex-1 text-base font-semibold text-fg">{t('dashboard.attention')}</h2>
              <ButtonLink to="/cockpit" size="sm" icon={<MonitorPlay className="size-3.5" />}>
                {t('dashboard.openCockpit')}
              </ButtonLink>
            </div>
            <div className="space-y-4">
              {blocked.length > 0 && (
                <div>
                  <p className="mb-2 text-sm text-fg-muted">{t('dashboard.blockedText', { count: blocked.length })}</p>
                  <AgentList agents={blocked} sandboxes={sandboxes.data} />
                </div>
              )}
              {review.length > 0 && (
                <div>
                  <p className="mb-2 text-sm text-fg-muted">{t('dashboard.reviewText', { count: review.length })}</p>
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                    {review.slice(0, 8).map((x) => (
                      <li key={x.id}>
                        <button type="button" onClick={() => openTask(x.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/70">
                          <div className="rounded-lg bg-amber-400/15 p-2 text-amber-700 dark:text-amber-300">
                            <ClipboardCheck className="size-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-fg">{x.title}</div>
                            <WorkspaceTag workspaceId={x.workspaceId} />
                          </div>
                          <TaskStatusBadge status={x.status} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {broken.length > 0 && (
                <ul className="space-y-2">
                  {broken.map((s) => (
                    <li key={s.id}>
                      <Link to={`/sandboxes/${s.id}/manage`} className="flex items-start gap-3 rounded-xl border border-red-500/25 bg-surface px-4 py-3 hover:bg-surface-2">
                        <CircleAlert className="mt-0.5 size-4 shrink-0 text-red-500" />
                        <div className="min-w-0">
                          <div className="font-medium text-fg">{t('dashboard.brokenTitle', { name: s.name })}</div>
                          <div className="text-sm text-fg-muted">{s.error ?? (s.status === 'missing' ? t('dashboard.containerMissing') : t('dashboard.unknownError'))}</div>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<Box className="size-5" />} label={t('dashboard.stat.sandboxes')} value={sandboxes.data?.length} sub={t('dashboard.stat.running', { count: running })} to="/sandboxes" />
        <Stat icon={<Bot className="size-5" />} label={t('dashboard.stat.agents')} value={allAgents.length} sub={t('dashboard.stat.working', { count: working })} to="/agents" />
        <Stat
          icon={<Hourglass className="size-5" />}
          label={t('dashboard.stat.waiting')}
          value={blocked.length + review.length}
          sub={blocked.length + review.length ? t('dashboard.stat.pleaseLook') : t('dashboard.stat.allDone')}
          to="/cockpit"
          highlight={blocked.length + review.length > 0}
        />
        <Stat icon={<Activity className="size-5" />} label={t('dashboard.stat.events')} value={activity.data?.length} sub={t('dashboard.stat.inLog')} to="/activity" />
      </div>

      <section className="mb-8">
        <SectionTitle
          action={
            workspaces.data?.length ? (
              <ButtonLink to="/workspaces" variant="ghost" size="sm">
                {t('dashboard.allWorkspaces')}
              </ButtonLink>
            ) : undefined
          }
        >
          {t('dashboard.workspaces')}
        </SectionTitle>
        {workspaces.isLoading ? (
          <LoadingState />
        ) : workspaces.error ? (
          <ErrorState error={workspaces.error} onRetry={() => workspaces.refetch()} />
        ) : !workspaces.data?.length ? (
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-dashed border-line-strong px-5 py-4">
            <Layers className="size-5 text-fg-muted" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-fg">{t('dashboard.noWorkspacesTitle')}</div>
              <p className="text-sm text-fg-muted">{t('dashboard.noWorkspacesText')}</p>
            </div>
            <Button icon={<Plus className="size-4" />} onClick={() => dialogs.workspace()}>
              {t('workspace.new')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {workspaces.data.slice(0, 6).map((w) => {
              const st = workspaceStats(w.id, sandboxes.data, agents.data, tasks.data);
              return (
                <Link
                  key={w.id}
                  to={`/workspaces/${w.id}`}
                  className={cn('flex items-center gap-3 rounded-xl border bg-surface px-4 py-3 transition-colors hover:border-line-strong', st.attention ? 'border-amber-400' : 'border-line')}
                >
                  <WorkspaceDot workspace={w} className="size-3" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-fg">{w.name}</div>
                    <div className="text-xs text-fg-muted">
                      {st.liveAgents.length} {t('workspacesPage.liveAgents')} · {st.openTasks} {t('workspacesPage.openTasks')}
                    </div>
                  </div>
                  {st.attention > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-400 px-2 py-0.5 text-xs font-semibold text-amber-950" title={t('workspacesPage.attention', { count: st.attention })}>
                      <Hand className="size-3" /> {st.attention}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid gap-8 xl:grid-cols-[1fr_420px]">
        <section>
          <SectionTitle
            action={
              <ButtonLink to="/agents" variant="ghost" size="sm">
                {t('dashboard.allAgents')}
              </ButtonLink>
            }
          >
            {t('dashboard.activeAgents')}
          </SectionTitle>
          {agents.isLoading ? (
            <LoadingState />
          ) : agents.error ? (
            <ErrorState error={agents.error} onRetry={() => agents.refetch()} />
          ) : active.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="size-6" />}
              title={t('dashboard.noActiveTitle')}
              action={
                sandboxes.data?.length ? (
                  <ButtonLink to={`/sandboxes/${sandboxes.data[0]!.id}/agents`} variant="primary">
                    {t('dashboard.startAgent')}
                  </ButtonLink>
                ) : setup.data?.steps.find((s) => s.id === 'image')?.done !== false ? (
                  <Button variant="primary" onClick={openCreate}>
                    {t('dashboard.createFirst')}
                  </Button>
                ) : undefined
              }
            >
              {sandboxes.data?.length
                ? t('dashboard.noActiveWithSandbox')
                : t('dashboard.noActiveNoSandbox')}
            </EmptyState>
          ) : (
            <AgentList agents={active.slice(0, 10)} sandboxes={sandboxes.data} />
          )}
        </section>

        <section>
          <Card>
            <CardHeader
              title={t('dashboard.recentActivity')}
              actions={
                <ButtonLink to="/activity" variant="ghost" size="sm">
                  {t('dashboard.all')}
                </ButtonLink>
              }
            />
            {activity.isLoading ? (
              <LoadingState />
            ) : activity.error ? (
              <ErrorState error={activity.error} className="m-4" />
            ) : !activity.data?.length ? (
              <p className="px-5 py-6 text-sm text-fg-muted">{t('dashboard.noActivity')}</p>
            ) : (
              <ActivityList entries={activity.data.slice(0, 8)} sandboxes={sandboxes.data} compact />
            )}
          </Card>
        </section>
      </div>
    </>
  );
}

function Stat({ icon, label, value, sub, to, highlight }: { icon: ReactNode; label: string; value: number | undefined; sub: string; to: string; highlight?: boolean }) {
  return (
    <Link
      to={to}
      className={cn(
        'rounded-xl border bg-surface p-4 transition-colors hover:border-line-strong',
        highlight ? 'border-amber-400 bg-amber-400/10' : 'border-line',
      )}
    >
      <div className={cn('flex items-center gap-2 text-sm', highlight ? 'text-amber-700 dark:text-amber-300' : 'text-fg-muted')}>
        {icon}
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-fg">{value ?? '–'}</div>
      <div className="text-xs text-fg-subtle">{sub}</div>
    </Link>
  );
}
