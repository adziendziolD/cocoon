import { KanbanSquare, Layers, MonitorPlay, Plus } from 'lucide-react';
import { useTasks, useWorkspaces } from '../api/queries';
import { useAppDialogs } from '../components/AppDialogs';
import { Button, ButtonLink } from '../components/Button';
import { PageHeader } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Callout } from '../components/HelpText';
import { ErrorState, LoadingState } from '../components/States';
import { IssueBadges } from '../components/tasks/IssueImport';
import { AutomationBar } from '../components/tasks/AutomationBar';
import { TaskBoard } from '../components/tasks/TaskBoard';
import { WorkspaceSwitcher } from '../components/WorkspaceSwitcher';
import { useT } from '../i18n';
import { taskInScope, useWorkspaceScope } from '../lib/workspace';

export function TasksPage() {
  const t = useT();
  const tasks = useTasks();
  const workspaces = useWorkspaces();
  const dialogs = useAppDialogs();
  const [rawScope, , workspace] = useWorkspaceScope();
  // Tasks always belong to a workspace: "unassigned" means "all" here.
  const scope = rawScope === 'unassigned' ? 'all' : rawScope;
  const list = (tasks.data ?? []).filter((x) => taskInScope(x, scope));

  return (
    <>
      <PageHeader
        title={t('tasksPage.title')}
        description={t('tasksPage.description')}
        actions={
          <>
            <WorkspaceSwitcher allowUnassigned={false} onCreate={() => dialogs.workspace()} />
            <ButtonLink to="/cockpit" icon={<MonitorPlay className="size-4" />}>
              {t('layout.nav.cockpit')}
            </ButtonLink>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => dialogs.task({ workspaceId: workspace?.id })} disabled={workspaces.data?.length === 0}>
              {t('taskDialog.newTitle')}
            </Button>
          </>
        }
      />

      {tasks.isLoading || workspaces.isLoading ? (
        <LoadingState />
      ) : tasks.error || workspaces.error ? (
        <ErrorState error={tasks.error ?? workspaces.error} onRetry={() => (void tasks.refetch(), void workspaces.refetch())} />
      ) : workspaces.data?.length === 0 ? (
        <EmptyState
          icon={<Layers className="size-6" />}
          title={t('tasksPage.noWorkspaceTitle')}
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => dialogs.workspace()}>
              {t('workspace.new')}
            </Button>
          }
        >
          {t('tasksPage.noWorkspaceText')}
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {workspace ? (
            <>
              <AutomationBar workspace={workspace} tasks={list} />
              <IssueBadges workspace={workspace} />
            </>
          ) : (
            <Callout tone="tip">{t('tasksPage.allHint')}</Callout>
          )}
          {list.length === 0 ? (
            <EmptyState
              icon={<KanbanSquare className="size-6" />}
              title={t('tasksPage.emptyTitle')}
              action={
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => dialogs.task({ workspaceId: workspace?.id })}>
                  {t('tasksPage.createFirst')}
                </Button>
              }
            >
              {t('tasksPage.emptyText')}
            </EmptyState>
          ) : (
            <TaskBoard tasks={list} allTasks={tasks.data ?? []} workspaceId={workspace?.id} showWorkspace={!workspace} />
          )}
        </div>
      )}
    </>
  );
}
