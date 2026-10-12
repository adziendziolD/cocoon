import { Link, useNavigate } from 'react-router-dom';
import type { Agent, Sandbox, Task, Workspace } from '@cocoon/protocol';
import { Bot, Box, Hand, Inbox, KanbanSquare, Layers, Plus, Zap } from 'lucide-react';
import { useAgents, useSandboxes, useTasks, useWorkspaces } from '../api/queries';
import { useAppDialogs } from '../components/AppDialogs';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { PageHeader } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Callout } from '../components/HelpText';
import { ErrorState, LoadingState } from '../components/States';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import { setWorkspaceScope, workspaceColor } from '../lib/workspace';

export interface WorkspaceStats {
  sandboxes: Sandbox[];
  tasks: Task[];
  liveAgents: Agent[];
  blocked: Agent[];
  review: Task[];
  attention: number;
  openTasks: number;
}

/** Counts for a workspace (or, with id undefined, for unassigned sandboxes). */
export function workspaceStats(id: string | undefined, sandboxes: Sandbox[] = [], agents: Agent[] = [], tasks: Task[] = []): WorkspaceStats {
  const sbs = sandboxes.filter((s) => (id ? s.workspaceId === id : !s.workspaceId));
  const ids = new Set(sbs.map((s) => s.id));
  const ag = agents.filter((a) => ids.has(a.sandboxId));
  const ts = id ? tasks.filter((x) => x.workspaceId === id) : [];
  const blocked = ag.filter((a) => a.status === 'blocked');
  const review = ts.filter((x) => x.status === 'review');
  // Blocked task agents are already counted as blocked agents.
  return {
    sandboxes: sbs,
    tasks: ts,
    liveAgents: ag.filter((a) => a.status !== 'exited'),
    blocked,
    review,
    attention: blocked.length + review.length,
    openTasks: ts.filter((x) => x.status !== 'done').length,
  };
}

export function WorkspacesPage() {
  const t = useT();
  const workspaces = useWorkspaces();
  const sandboxes = useSandboxes();
  const agents = useAgents();
  const tasks = useTasks();
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
  const unassigned = workspaceStats(undefined, sandboxes.data, agents.data, tasks.data);

  return (
    <>
      <PageHeader
        title={t('workspacesPage.title')}
        description={t('workspacesPage.description')}
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => dialogs.workspace()}>
            {t('workspace.new')}
          </Button>
        }
      />
      {workspaces.isLoading ? (
        <LoadingState />
      ) : workspaces.error ? (
        <ErrorState error={workspaces.error} onRetry={() => workspaces.refetch()} />
      ) : !workspaces.data?.length ? (
        <EmptyState
          icon={<Layers className="size-6" />}
          title={t('workspacesPage.emptyTitle')}
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => dialogs.workspace()}>
              {t('workspacesPage.createFirst')}
            </Button>
          }
        >
          {t('workspacesPage.emptyText')}
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {workspaces.data.map((w) => (
              <WorkspaceCard key={w.id} workspace={w} stats={workspaceStats(w.id, sandboxes.data, agents.data, tasks.data)} />
            ))}
            {unassigned.sandboxes.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setWorkspaceScope('unassigned');
                  navigate('/sandboxes');
                }}
                className="flex flex-col items-start rounded-xl border border-dashed border-line-strong p-5 text-left transition-colors hover:bg-surface-2/60"
              >
                <div className="flex items-center gap-2 font-semibold text-fg">
                  <Inbox className="size-4 text-fg-muted" /> {t('workspace.unassigned')}
                </div>
                <p className="mt-1 text-sm text-fg-muted">{t('workspacesPage.unassignedText', { count: unassigned.sandboxes.length })}</p>
              </button>
            )}
          </div>
          <Callout tone="tip" className="mt-6">
            {t('workspacesPage.tip')}
          </Callout>
        </>
      )}
    </>
  );
}

function WorkspaceCard({ workspace: w, stats }: { workspace: Workspace; stats: WorkspaceStats }) {
  const t = useT();
  return (
    <Link
      to={`/workspaces/${w.id}`}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-xl border bg-surface p-5 pl-6 transition-all hover:border-line-strong hover:shadow-sm',
        stats.attention ? 'border-amber-400' : 'border-line',
      )}
    >
      <span className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: workspaceColor(w) }} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-fg group-hover:text-accent">{w.name}</div>
          {w.description && <p className="mt-0.5 line-clamp-2 text-sm text-fg-muted">{w.description}</p>}
        </div>
        {w.autoRun && (
          <Badge tone="accent" title={t('workspaceForm.autoRunHint')}>
            <Zap className="size-3" /> {t('automation.autoRun')}
          </Badge>
        )}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
        <Stat icon={<Box className="size-4" />} value={stats.sandboxes.length} label={t('workspacesPage.sandboxes')} />
        <Stat icon={<KanbanSquare className="size-4" />} value={stats.openTasks} label={t('workspacesPage.openTasks')} />
        <Stat icon={<Bot className="size-4" />} value={stats.liveAgents.length} label={t('workspacesPage.liveAgents')} />
      </div>
      {stats.attention > 0 && (
        <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-amber-400/15 px-2.5 py-1.5 text-sm font-medium text-amber-800 dark:text-amber-300">
          <Hand className="size-4" />
          {t('workspacesPage.attention', { count: stats.attention })}
        </div>
      )}
    </Link>
  );
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="rounded-lg bg-surface-2/60 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-fg-subtle">
        {icon}
        <span className="text-base font-semibold text-fg">{value}</span>
      </div>
      <div className="truncate text-xs text-fg-muted">{label}</div>
    </div>
  );
}
