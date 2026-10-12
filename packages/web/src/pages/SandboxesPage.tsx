import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Agent, Sandbox } from '@cocoon/protocol';
import { Bot, Box, Cpu, FolderGit2, FolderInput, Globe, Plus, ShieldCheck, WifiOff } from 'lucide-react';
import { useAgents, useSandboxes } from '../api/queries';
import { useAppDialogs } from '../components/AppDialogs';
import { Badge, SandboxStatusBadge } from '../components/Badge';
import { Button, IconButton } from '../components/Button';
import { PageHeader } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Callout } from '../components/HelpText';
import { ErrorState, LoadingState } from '../components/States';
import { MoveSandboxDialog } from '../components/WorkspaceDialogs';
import { WorkspaceSwitcher, WorkspaceTag } from '../components/WorkspaceSwitcher';
import { useT } from '../i18n';
import { sandboxInScope, useWorkspaceScope } from '../lib/workspace';
import { cn } from '../lib/cn';
import { formatMemory, formatRelative } from '../lib/format';
import { networkModeMeta } from '../lib/status';

const NET_ICON = { egress: ShieldCheck, open: Globe, none: WifiOff };

export function SandboxesPage() {
  const t = useT();
  const sandboxes = useSandboxes();
  const agents = useAgents();
  const dialogs = useAppDialogs();
  const [scope, setScope, workspace] = useWorkspaceScope();
  const [moving, setMoving] = useState<Sandbox | null>(null);
  const openCreate = () => dialogs.createSandbox({ workspaceId: workspace?.id });

  const all = sandboxes.data ?? [];
  const list = all.filter((s) => sandboxInScope(s, scope)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <>
      <PageHeader
        title={t('sandboxesPage.title')}
        description={t('sandboxesPage.description')}
        actions={
          <>
            <WorkspaceSwitcher onCreate={() => dialogs.workspace()} />
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
              {t('sandboxesPage.newSandbox')}
            </Button>
          </>
        }
      />
      {sandboxes.isLoading ? (
        <LoadingState />
      ) : sandboxes.error ? (
        <ErrorState error={sandboxes.error} onRetry={() => sandboxes.refetch()} />
      ) : list.length === 0 && all.length > 0 ? (
        <EmptyState
          icon={<Box className="size-6" />}
          title={t('sandboxesPage.filteredEmpty')}
          action={
            <>
              <Button onClick={() => setScope('all')}>{t('sandboxesPage.showAll')}</Button>
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
                {t('sandboxesPage.newSandbox')}
              </Button>
            </>
          }
        />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Box className="size-6" />}
          title={t('sandboxesPage.emptyTitle')}
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
              {t('sandboxesPage.createFirst')}
            </Button>
          }
        >
          {t('sandboxesPage.emptyText')}
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {list.map((s) => (
              <SandboxCard key={s.id} sandbox={s} agents={(agents.data ?? []).filter((a) => a.sandboxId === s.id)} onMove={() => setMoving(s)} />
            ))}
          </div>
          <Callout tone="tip" className="mt-6">
            {t('sandboxesPage.tip')}
          </Callout>
        </>
      )}
      <MoveSandboxDialog sandbox={moving} open={!!moving} onClose={() => setMoving(null)} />
    </>
  );
}

function SandboxCard({ sandbox: s, agents, onMove }: { sandbox: Sandbox; agents: Agent[]; onMove: () => void }) {
  const t = useT();
  const blocked = agents.filter((a) => a.status === 'blocked').length;
  const working = agents.filter((a) => a.status === 'working').length;
  const live = agents.filter((a) => a.status !== 'exited').length;
  const NetIcon = NET_ICON[s.network] ?? Globe;
  return (
    <Link
      to={`/sandboxes/${s.id}`}
      className={cn(
        'group flex flex-col rounded-xl border bg-surface p-5 transition-all hover:border-line-strong hover:shadow-sm',
        blocked ? 'border-amber-400' : s.status === 'error' ? 'border-red-500/40' : 'border-line',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-fg group-hover:text-accent">{s.name}</div>
          <div className="text-xs text-fg-subtle">{t('sandboxesPage.created', { time: formatRelative(s.createdAt) })}</div>
        </div>
        <SandboxStatusBadge status={s.status} />
      </div>
      <div className="mt-2 flex items-center gap-1">
        <WorkspaceTag workspaceId={s.workspaceId} />
        <IconButton
          label={t('sandboxesPage.move')}
          icon={<FolderInput className="size-3.5" />}
          className="h-6 opacity-60 hover:opacity-100"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onMove();
          }}
        />
      </div>

      <div className="mt-4 space-y-1.5 text-sm text-fg-muted">
        <div className="flex items-center gap-2 truncate">
          <FolderGit2 className="size-4 shrink-0 text-fg-subtle" />
          <span className="truncate">{s.repo ? `${s.repo.url.replace(/^https?:\/\//, '')}${s.repos.length > 1 ? ` +${s.repos.length - 1}` : ''}` : t('sandboxesPage.emptyFolder')}</span>
        </div>
        <div className="flex items-center gap-2">
          <NetIcon className="size-4 shrink-0 text-fg-subtle" />
          {t('sandboxesPage.internet', { mode: s.network in NET_ICON ? networkModeMeta(t, s.network).short : s.network })}
        </div>
        <div className="flex items-center gap-2">
          <Cpu className="size-4 shrink-0 text-fg-subtle" />
          {t('sandboxesPage.cpu', { cpus: s.resources.cpus ?? '–', memory: formatMemory(s.resources.memoryMb) })}
        </div>
      </div>

      {s.status === 'error' && s.error && <p className="mt-3 line-clamp-2 text-sm text-red-600 dark:text-red-400">{s.error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm">
        <Bot className="size-4 text-fg-subtle" />
        <span className="text-fg-muted">{t('sandboxesPage.liveAgents', { count: live })}</span>
        {working > 0 && <Badge tone="blue">{t('sandboxesPage.working', { count: working })}</Badge>}
        {blocked > 0 && <Badge tone="amber">{t('sandboxesPage.waiting', { count: blocked })}</Badge>}
      </div>
    </Link>
  );
}
