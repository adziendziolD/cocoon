import { useNavigate } from 'react-router-dom';
import type { Workspace } from '@cocoon/protocol';
import { ChevronDown, Inbox, Layers, Plus, Settings2 } from 'lucide-react';
import { useWorkspaces } from '../api/queries';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import { useWorkspaceScope, workspaceColor, type WorkspaceScope } from '../lib/workspace';
import { MenuItem, MenuSeparator, Popover } from './Popover';

export function WorkspaceDot({ workspace, className }: { workspace: Pick<Workspace, 'color'> | undefined; className?: string }) {
  return <span className={cn('inline-block size-2.5 shrink-0 rounded-full', className)} style={{ backgroundColor: workspaceColor(workspace) }} />;
}

/** Colour dot + name of a sandbox's/task's workspace ("Unassigned" without one). */
export function WorkspaceTag({ workspaceId, className }: { workspaceId: string | undefined; className?: string }) {
  const t = useT();
  const workspaces = useWorkspaces();
  const ws = workspaceId ? workspaces.data?.find((w) => w.id === workspaceId) : undefined;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs text-fg-muted', className)}>
      {ws ? <WorkspaceDot workspace={ws} className="size-2" /> : <span className="size-2 shrink-0 rounded-full border border-dashed border-fg-subtle" />}
      <span className="truncate">{ws ? ws.name : workspaceId ? workspaceId : t('workspace.unassigned')}</span>
    </span>
  );
}

/**
 * Chooses the workspace scope (all / unassigned / one workspace) used by cockpit, task board and sandbox list.
 * The choice is remembered in this browser.
 */
export function WorkspaceSwitcher({ allowUnassigned = true, onCreate, className }: { allowUnassigned?: boolean; onCreate?: () => void; className?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const [scope, setScope, current] = useWorkspaceScope();
  const list = workspaces.data ?? [];

  const label = current ? current.name : scope === 'unassigned' ? t('workspace.unassigned') : t('workspace.all');
  const pick = (s: WorkspaceScope, close: () => void) => {
    setScope(s);
    close();
  };

  return (
    <Popover
      className={className}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title={t('workspace.switcherHint')}
          className="inline-flex h-9 max-w-64 items-center gap-2 rounded-lg bg-surface px-3 text-sm font-medium text-fg shadow-sm ring-1 ring-line-strong ring-inset hover:bg-surface-2"
        >
          {current ? <WorkspaceDot workspace={current} /> : scope === 'unassigned' ? <Inbox className="size-4 text-fg-muted" /> : <Layers className="size-4 text-fg-muted" />}
          <span className="truncate">{label}</span>
          <ChevronDown className="size-4 shrink-0 text-fg-subtle" />
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-[60vh] w-64 overflow-y-auto">
          <MenuItem icon={<Layers className="size-4 text-fg-muted" />} active={scope === 'all'} onClick={() => pick('all', close)}>
            {t('workspace.all')}
          </MenuItem>
          {allowUnassigned && (
            <MenuItem icon={<Inbox className="size-4 text-fg-muted" />} active={scope === 'unassigned'} onClick={() => pick('unassigned', close)}>
              {t('workspace.unassigned')}
            </MenuItem>
          )}
          {list.length > 0 && <MenuSeparator />}
          {list.map((w) => (
            <MenuItem key={w.id} icon={<WorkspaceDot workspace={w} />} active={scope === w.id} onClick={() => pick(w.id, close)}>
              {w.name}
            </MenuItem>
          ))}
          {workspaces.isLoading && <div className="px-2.5 py-1.5 text-xs text-fg-subtle">{t('common.loading')}</div>}
          {workspaces.error && <div className="px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400">{t('workspace.loadFailed')}</div>}
          <MenuSeparator />
          {onCreate && (
            <MenuItem
              icon={<Plus className="size-4" />}
              onClick={() => {
                close();
                onCreate();
              }}
            >
              {t('workspace.new')}
            </MenuItem>
          )}
          <MenuItem
            icon={<Settings2 className="size-4" />}
            onClick={() => {
              close();
              navigate('/workspaces');
            }}
          >
            {t('workspace.manage')}
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}
