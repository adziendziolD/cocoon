import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Sandbox } from '@cocoon/protocol';
import { Bot, Box, Database, FileDiff, FolderInput, FolderOpen, Loader2, Play, Settings2, Square, SquareTerminal } from 'lucide-react';
import { useAgents, useSandbox } from '../../api/queries';
import { isNotFound } from '../../api/rpc';
import { Badge, SandboxStatusBadge } from '../../components/Badge';
import { Button, ButtonLink } from '../../components/Button';
import { PageHeader } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Callout } from '../../components/HelpText';
import { SpawnAgentDialog } from '../../components/SpawnAgentDialog';
import { ErrorState, LoadingState } from '../../components/States';
import { Tabs, type TabDef } from '../../components/Tabs';
import { networkModeMeta, sandboxStatusMeta } from '../../lib/status';
import { useT } from '../../i18n';
import { StartStopButton } from '../../components/StartStopButton';
import { MoveSandboxDialog } from '../../components/WorkspaceDialogs';
import { WorkspaceTag } from '../../components/WorkspaceSwitcher';
import { AgentsTab } from './AgentsTab';
import { ChangesTab } from './ChangesTab';
import { ConsoleTab } from './ConsoleTab';
import { FilesTab } from './FilesTab';
import { ManageTab } from './ManageTab';
import { ServicesTab } from './ServicesTab';

type TabId = 'agents' | 'files' | 'changes' | 'console' | 'services' | 'manage';
const TAB_IDS: TabId[] = ['agents', 'files', 'changes', 'console', 'services', 'manage'];

export function SandboxDetailPage() {
  const { sandboxId = '', tab: tabParam } = useParams();
  const navigate = useNavigate();
  const tab: TabId = TAB_IDS.includes(tabParam as TabId) ? (tabParam as TabId) : 'agents';
  const sandbox = useSandbox(sandboxId);
  const agents = useAgents();
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const t = useT();

  if (sandbox.isLoading) return <LoadingState />;
  if (isNotFound(sandbox.error) || (!sandbox.data && !sandbox.error)) {
    return (
      <EmptyState
        icon={<Box className="size-6" />}
        title={t('sandboxDetail.notFound.title')}
        action={<ButtonLink to="/sandboxes" variant="primary">{t('sandboxDetail.notFound.action')}</ButtonLink>}
      >
        {t('sandboxDetail.notFound.text')}
      </EmptyState>
    );
  }
  if (sandbox.error || !sandbox.data) return <ErrorState error={sandbox.error} onRetry={() => sandbox.refetch()} />;

  const s = sandbox.data;
  const myAgents = (agents.data ?? []).filter((a) => a.sandboxId === s.id);
  const net = networkModeMeta(t, s.network);
  const blocked = myAgents.filter((a) => a.status === 'blocked').length;

  const tabs: TabDef<TabId>[] = [
    { id: 'agents', label: t('sandboxDetail.tab.agents'), icon: <Bot className="size-4" />, count: blocked || myAgents.filter((a) => a.status !== 'exited').length, attention: blocked > 0 },
    { id: 'files', label: t('sandboxDetail.tab.files'), icon: <FolderOpen className="size-4" /> },
    { id: 'changes', label: t('sandboxDetail.tab.changes'), icon: <FileDiff className="size-4" /> },
    { id: 'console', label: t('sandboxDetail.tab.console'), icon: <SquareTerminal className="size-4" /> },
    { id: 'services', label: t('sandboxDetail.tab.services'), icon: <Database className="size-4" />, count: s.services?.length ?? 0 },
    { id: 'manage', label: t('sandboxDetail.tab.manage'), icon: <Settings2 className="size-4" /> },
  ];

  return (
    <>
      <PageHeader
        breadcrumb={
          <span className="flex flex-wrap items-center gap-2">
            <Link to="/sandboxes" className="hover:text-fg hover:underline">
              {t('sandboxDetail.breadcrumb')}
            </Link>
            <span>·</span>
            {s.workspaceId ? (
              <Link to={`/workspaces/${s.workspaceId}`} className="hover:underline">
                <WorkspaceTag workspaceId={s.workspaceId} className="text-sm" />
              </Link>
            ) : (
              <WorkspaceTag workspaceId={undefined} className="text-sm" />
            )}
            <button type="button" onClick={() => setMoveOpen(true)} className="inline-flex items-center gap-1 text-xs text-fg-subtle hover:text-fg hover:underline">
              <FolderInput className="size-3.5" /> {t('moveSandbox.move')}
            </button>
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {s.name}
            <SandboxStatusBadge status={s.status} />
            <Badge tone="gray" title={net.description}>
              {t('sandboxDetail.internet', { mode: net.short })}
            </Badge>
          </span>
        }
        description={
          s.repos.length > 1 ? (
            <span className="text-sm">
              {t('sandboxDetail.repoCount', { count: s.repos.length, folders: s.repos.map((r) => r.path || '.').join(', ') })}
            </span>
          ) : s.repo ? (
            <span className="font-mono text-sm">{s.repo.url}{s.repo.ref ? ` @ ${s.repo.ref}` : ''}</span>
          ) : (
            t('sandboxDetail.noRepo')
          )
        }
        actions={
          <>
            <StartStopButton sandbox={s} />
            <Button variant="primary" icon={<Play className="size-4" />} onClick={() => setSpawnOpen(true)} disabled={s.status !== 'running'}>
              {t('sandboxDetail.startAgent')}
            </Button>
          </>
        }
      />

      {s.status === 'creating' && (
        <Callout tone="info" className="mb-5" title={t('sandboxDetail.creating.title')}>
          {sandboxStatusMeta(t, 'creating').explanation} {t('sandboxDetail.creating.autoRefresh')}
        </Callout>
      )}
      {(s.status === 'error' || s.status === 'missing') && (
        <Callout tone="danger" className="mb-5" title={sandboxStatusMeta(t, s.status).label}>
          {s.error ?? sandboxStatusMeta(t, s.status).explanation}
        </Callout>
      )}
      {s.status === 'stopped' && (
        <Callout tone="info" className="mb-5" title={t('sandboxDetail.stopped.title')}>
          {sandboxStatusMeta(t, 'stopped').explanation}
        </Callout>
      )}

      <Tabs tabs={tabs} value={tab} onChange={(id) => navigate(`/sandboxes/${s.id}/${id}`, { replace: true })} />

      {tab === 'agents' && <AgentsTab sandbox={s} agents={myAgents} onSpawn={() => setSpawnOpen(true)} loading={agents.isLoading} />}
      {tab === 'files' && <RequireRunning sandbox={s}>{<FilesTab sandbox={s} />}</RequireRunning>}
      {tab === 'changes' && <RequireRunning sandbox={s}>{<ChangesTab sandbox={s} />}</RequireRunning>}
      {tab === 'console' && <RequireRunning sandbox={s}>{<ConsoleTab sandbox={s} />}</RequireRunning>}
      {tab === 'services' && <ServicesTab sandbox={s} />}
      {tab === 'manage' && <ManageTab sandbox={s} />}

      <SpawnAgentDialog sandbox={s} open={spawnOpen} onClose={() => setSpawnOpen(false)} />
      <MoveSandboxDialog sandbox={s} open={moveOpen} onClose={() => setMoveOpen(false)} />
    </>
  );
}

function RequireRunning({ sandbox, children }: { sandbox: Sandbox; children: ReactNode }) {
  const t = useT();
  if (sandbox.status === 'running') return <>{children}</>;
  return (
    <EmptyState
      icon={sandbox.status === 'creating' ? <Loader2 className="size-6 animate-spin" /> : <Square className="size-6" />}
      title={sandbox.status === 'creating' ? t('sandboxDetail.requireRunning.creatingTitle') : t('sandboxDetail.requireRunning.stoppedTitle')}
      action={sandbox.status === 'stopped' ? <StartStopButton sandbox={sandbox} /> : undefined}
    >
      {sandbox.status === 'creating' ? t('sandboxDetail.requireRunning.creatingText') : t('sandboxDetail.requireRunning.stoppedText')}
    </EmptyState>
  );
}
