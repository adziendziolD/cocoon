import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { planRepos, type Workspace } from '@cocoon/protocol';
import { Bot, Box, FolderGit2, FolderInput, Hand, KanbanSquare, LayoutDashboard, Layers, MonitorPlay, Plus, Settings2, Trash2 } from 'lucide-react';
import { useAgents, useSandboxes, useSettings, useTasks, useWorkspaces } from '../api/queries';
import { rpc } from '../api/rpc';
import { useAction } from '../api/useAction';
import { qk } from '../api/keys';
import { AgentList, sortAgents } from '../components/AgentList';
import { useAppDialogs } from '../components/AppDialogs';
import { Badge, SandboxStatusBadge } from '../components/Badge';
import { Button, ButtonLink, IconButton } from '../components/Button';
import { Card, CardBody, CardHeader, DetailList, PageHeader } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { SectionTitle } from '../components/Layout';
import { SaveBar } from '../components/SaveBar';
import { ErrorState, LoadingState } from '../components/States';
import { Tabs, type TabDef } from '../components/Tabs';
import { AutomationBar } from '../components/tasks/AutomationBar';
import { TaskBoard } from '../components/tasks/TaskBoard';
import { TaskStatusBadge } from '../components/tasks/TaskBits';
import { useOpenTask } from '../components/tasks/useTaskActions';
import { AddSandboxesDialog, DeleteWorkspaceDialog, MoveSandboxDialog } from '../components/WorkspaceDialogs';
import { toWorkspaceDraft, validateWorkspace, WorkspaceForm, workspaceParams, type WorkspaceDraft } from '../components/WorkspaceForm';
import { WorkspaceDot } from '../components/WorkspaceSwitcher';
import { useLanguage, useT } from '../i18n';
import { profileLabel } from '../lib/profiles';
import { networkModeMeta } from '../lib/status';
import { workflowLabel } from '../lib/tasks';
import { useDraft } from '../lib/useDraft';
import { setWorkspaceScope } from '../lib/workspace';
import { workspaceStats } from './WorkspacesPage';

type TabId = 'overview' | 'tasks' | 'settings';
const TAB_IDS: TabId[] = ['overview', 'tasks', 'settings'];

export function WorkspaceDetailPage() {
  const { workspaceId = '', tab: tabParam } = useParams();
  const t = useT();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const sandboxes = useSandboxes();
  const agents = useAgents();
  const tasks = useTasks();
  const dialogs = useAppDialogs();
  const tab: TabId = TAB_IDS.includes(tabParam as TabId) ? (tabParam as TabId) : 'overview';

  if (workspaces.isLoading) return <LoadingState />;
  if (workspaces.error) return <ErrorState error={workspaces.error} onRetry={() => workspaces.refetch()} />;
  const ws = workspaces.data?.find((w) => w.id === workspaceId);
  if (!ws) {
    return (
      <EmptyState
        icon={<Layers className="size-6" />}
        title={t('workspaceDetail.notFound')}
        action={
          <ButtonLink to="/workspaces" variant="primary">
            {t('workspaceDetail.toAll')}
          </ButtonLink>
        }
      >
        {t('workspaceDetail.notFoundText')}
      </EmptyState>
    );
  }

  const stats = workspaceStats(ws.id, sandboxes.data, agents.data, tasks.data);
  const tabs: TabDef<TabId>[] = [
    { id: 'overview', label: t('workspaceDetail.tab.overview'), icon: <LayoutDashboard className="size-4" />, count: stats.attention, attention: stats.attention > 0 },
    { id: 'tasks', label: t('layout.nav.tasks'), icon: <KanbanSquare className="size-4" />, count: stats.openTasks },
    { id: 'settings', label: t('workspaceDetail.tab.settings'), icon: <Settings2 className="size-4" /> },
  ];

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link to="/workspaces" className="hover:text-fg hover:underline">
            {t('layout.nav.workspaces')}
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            <WorkspaceDot workspace={ws} className="size-3.5" />
            {ws.name}
          </span>
        }
        description={ws.description || undefined}
        actions={
          <>
            <Button
              icon={<MonitorPlay className="size-4" />}
              onClick={() => {
                setWorkspaceScope(ws.id);
                navigate('/cockpit');
              }}
            >
              {t('workspaceDetail.openCockpit')}
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => dialogs.task({ workspaceId: ws.id })}>
              {t('taskDialog.newTitle')}
            </Button>
          </>
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={(id) => navigate(`/workspaces/${ws.id}/${id}`, { replace: true })} />
      {tab === 'overview' && <Overview workspace={ws} />}
      {tab === 'tasks' && (
        <div className="space-y-4">
          <AutomationBar workspace={ws} tasks={stats.tasks} />
          {tasks.isLoading ? (
            <LoadingState />
          ) : tasks.error ? (
            <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />
          ) : (
            <TaskBoard tasks={stats.tasks} allTasks={tasks.data ?? []} workspaceId={ws.id} />
          )}
        </div>
      )}
      {tab === 'settings' && <SettingsTab key={ws.id} workspace={ws} />}
    </>
  );
}

function Overview({ workspace: ws }: { workspace: Workspace }) {
  const t = useT();
  const { lang } = useLanguage();
  const settings = useSettings();
  const sandboxes = useSandboxes();
  const agents = useAgents();
  const tasks = useTasks();
  const dialogs = useAppDialogs();
  const openTask = useOpenTask();
  const [addOpen, setAddOpen] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const stats = workspaceStats(ws.id, sandboxes.data, agents.data, tasks.data);
  const movingSandbox = moving ? (sandboxes.data?.find((s) => s.id === moving) ?? null) : null;
  const net = ws.network ? networkModeMeta(t, ws.network) : undefined;
  const wsRepos = planRepos(ws.repos?.length ? ws.repos : ws.repo ? [ws.repo] : []);

  return (
    <div className="space-y-8">
      {stats.attention > 0 && (
        <section className="rounded-2xl border-2 border-amber-400/70 bg-amber-400/10 p-5">
          <div className="mb-3 flex items-center gap-2 font-semibold text-fg">
            <Hand className="size-5 text-amber-600 dark:text-amber-400" /> {t('dashboard.attention')}
          </div>
          <div className="space-y-3">
            {stats.blocked.length > 0 && <AgentList agents={sortAgents(stats.blocked)} sandboxes={sandboxes.data} />}
            {stats.review.length > 0 && (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {stats.review.map((x) => (
                  <li key={x.id}>
                    <button type="button" onClick={() => openTask(x.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/70">
                      <KanbanSquare className="size-4 text-fg-muted" />
                      <span className="min-w-0 flex-1 truncate font-medium text-fg">{x.title}</span>
                      <TaskStatusBadge status={x.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <section>
          <SectionTitle
            action={
              <div className="flex gap-2">
                <Button size="sm" icon={<FolderInput className="size-3.5" />} onClick={() => setAddOpen(true)}>
                  {t('workspaceDetail.addExisting')}
                </Button>
                <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => dialogs.createSandbox({ workspaceId: ws.id })}>
                  {t('sandboxesPage.newSandbox')}
                </Button>
              </div>
            }
          >
            {t('workspaceDetail.sandboxes')}
          </SectionTitle>
          {sandboxes.isLoading ? (
            <LoadingState />
          ) : stats.sandboxes.length === 0 ? (
            <EmptyState icon={<Box className="size-6" />} title={t('workspaceDetail.noSandboxes')}>
              {ws.sandboxMode === 'per-task' ? t('workspaceDetail.noSandboxesPerTask') : t('workspaceDetail.noSandboxesShared')}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {stats.sandboxes.map((s) => {
                const live = (agents.data ?? []).filter((a) => a.sandboxId === s.id && a.status !== 'exited');
                const blocked = live.filter((a) => a.status === 'blocked').length;
                const task = s.taskId ? tasks.data?.find((x) => x.id === s.taskId) : undefined;
                return (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <Box className="size-4 shrink-0 text-fg-subtle" />
                    <div className="min-w-0 flex-1">
                      <Link to={`/sandboxes/${s.id}`} className="font-medium text-fg hover:text-accent hover:underline">
                        {s.name}
                      </Link>
                      <div className="flex flex-wrap items-center gap-x-3 text-xs text-fg-muted">
                        <span className="inline-flex items-center gap-1">
                          <Bot className="size-3.5" /> {t('sandboxesPage.liveAgents', { count: live.length })}
                        </span>
                        {task && (
                          <button type="button" onClick={() => openTask(task.id)} className="truncate hover:text-fg hover:underline">
                            {t('workspaceDetail.forTask', { title: task.title })}
                          </button>
                        )}
                      </div>
                    </div>
                    {blocked > 0 && <Badge tone="amber">{t('sandboxesPage.waiting', { count: blocked })}</Badge>}
                    <SandboxStatusBadge status={s.status} />
                    <IconButton label={t('moveSandbox.title')} icon={<FolderInput className="size-4" />} onClick={() => setMoving(s.id)} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <Card>
          <CardHeader title={t('workspaceDetail.setup')} actions={<ButtonLink to={`/workspaces/${ws.id}/settings`} size="sm" variant="ghost">{t('common.edit')}</ButtonLink>} />
          <CardBody className="py-1">
            <DetailList
              items={[
                {
                  label: t('workspaceForm.repoSection'),
                  value: wsRepos.length ? (
                    <span className="flex flex-col gap-1">
                      {wsRepos.map((r, i) => (
                        <span key={i} className="inline-flex items-center gap-1.5 font-mono text-xs break-all">
                          <FolderGit2 className="size-3.5 shrink-0" />
                          {r.path && <span className="text-fg">{r.path}/ ←</span>}
                          <span>
                            {r.url}
                            {r.ref ? ` @ ${r.ref}` : ''}
                          </span>
                        </span>
                      ))}
                    </span>
                  ) : (
                    t('sandboxesPage.emptyFolder')
                  ),
                },
                { label: t('workspaceForm.sandboxMode'), value: ws.sandboxMode === 'shared' ? t('workspaceForm.shared') : t('workspaceForm.perTask') },
                { label: t('workspaceForm.network'), value: net ? net.label : t('workspaceForm.networkDefault') },
                {
                  label: t('workspaceForm.runWith'),
                  value: ws.defaultWorkflowId
                    ? workflowLabel(ws.defaultWorkflowId, settings.data?.workflows[ws.defaultWorkflowId], lang)
                    : profileLabel(ws.defaultAgentKind, settings.data?.agents[ws.defaultAgentKind], lang),
                },
                { label: t('automation.autoRun'), value: ws.autoRun ? t('workspaceDetail.autoRunOn', { count: ws.maxParallel }) : t('workspaceDetail.autoRunOff') },
              ]}
            />
          </CardBody>
        </Card>
      </div>

      <AddSandboxesDialog workspace={ws} open={addOpen} onClose={() => setAddOpen(false)} />
      <MoveSandboxDialog sandbox={movingSandbox} open={!!movingSandbox} onClose={() => setMoving(null)} />
    </div>
  );
}

function SettingsTab({ workspace: ws }: { workspace: Workspace }) {
  const t = useT();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { draft, setDraft, dirty, reset } = useDraft<WorkspaceDraft>(toWorkspaceDraft(ws));
  const save = useAction((d: WorkspaceDraft) => rpc('workspace.update', { workspaceId: ws.id, ...workspaceParams(d) }), {
    success: t('workspaceForm.saved'),
    error: t('common.saveFailed'),
    invalidate: [qk.workspaces],
    onSuccess: (w) => reset(toWorkspaceDraft(w)),
  });
  if (!draft) return <LoadingState />;
  const invalid = Object.keys(validateWorkspace(t, draft)).length > 0;

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardBody className="py-5">
          <WorkspaceForm value={draft} onChange={(p) => setDraft((d) => (d ? { ...d, ...p } : d))} />
        </CardBody>
      </Card>
      <Card className="border-red-500/30">
        <CardHeader title={t('workspaceDetail.dangerZone')} description={t('workspaceDetail.deleteText')} />
        <CardBody>
          <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>
            {t('workspaceDelete.confirm')}
          </Button>
        </CardBody>
      </Card>
      <SaveBar visible={dirty} saving={save.isPending} disabled={invalid} onDiscard={() => reset()} onSave={() => save.mutate(draft)} />
      <DeleteWorkspaceDialog workspace={ws} open={confirmDelete} onClose={() => setConfirmDelete(false)} />
    </div>
  );
}
