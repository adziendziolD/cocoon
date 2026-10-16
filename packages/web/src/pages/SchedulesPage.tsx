import { Layers, Plus } from 'lucide-react';
import { useSchedules, useWorkspaces } from '../api/queries';
import { useAppDialogs } from '../components/AppDialogs';
import { Button } from '../components/Button';
import { PageHeader } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Callout } from '../components/HelpText';
import { NewScheduleButton, ScheduleList } from '../components/schedules/ScheduleList';
import { ErrorState, LoadingState } from '../components/States';
import { WorkspaceSwitcher } from '../components/WorkspaceSwitcher';
import { useT } from '../i18n';
import { isSpecific, useWorkspaceScope } from '../lib/workspace';

export function SchedulesPage() {
  const t = useT();
  const schedules = useSchedules();
  const workspaces = useWorkspaces();
  const dialogs = useAppDialogs();
  const [scope, , workspace] = useWorkspaceScope();
  const list = (schedules.data ?? []).filter((s) => !isSpecific(scope) || s.workspaceId === scope);

  return (
    <>
      <PageHeader
        title={t('schedulesPage.title')}
        description={t('schedulesPage.description')}
        actions={
          <>
            <WorkspaceSwitcher allowUnassigned={false} onCreate={() => dialogs.workspace()} />
            <NewScheduleButton workspaceId={workspace?.id} disabled={workspaces.data?.length === 0} />
          </>
        }
      />
      {schedules.isLoading || workspaces.isLoading ? (
        <LoadingState />
      ) : schedules.error || workspaces.error ? (
        <ErrorState error={schedules.error ?? workspaces.error} onRetry={() => (void schedules.refetch(), void workspaces.refetch())} />
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
          {t('schedulesPage.noWorkspaceText')}
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <Callout tone="tip" title={t('schedulesPage.howTitle')}>
            {t('schedulesPage.howText')}
          </Callout>
          <ScheduleList schedules={list} workspaceId={workspace?.id} showWorkspace={!workspace} />
        </div>
      )}
    </>
  );
}
