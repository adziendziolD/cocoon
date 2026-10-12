import { useEffect, useSyncExternalStore } from 'react';
import type { Agent, Sandbox, Task, Workspace } from '@cocoon/protocol';
import { useWorkspaces } from '../api/queries';

/**
 * The workspace scope chosen in the switcher (shared by cockpit, task board and sandboxes list):
 * 'all' = everything, 'unassigned' = sandboxes without a workspace, otherwise a workspace id.
 */
export type WorkspaceScope = 'all' | 'unassigned' | (string & {});

const STORAGE_KEY = 'cocoon.workspace';
let current: WorkspaceScope = read();
const listeners = new Set<() => void>();

function read(): WorkspaceScope {
  try {
    return localStorage.getItem(STORAGE_KEY) || 'all';
  } catch {
    return 'all';
  }
}

export function getWorkspaceScope(): WorkspaceScope {
  return current;
}

export function setWorkspaceScope(scope: WorkspaceScope): void {
  if (scope === current) return;
  current = scope;
  try {
    localStorage.setItem(STORAGE_KEY, scope);
  } catch {
    // ignore (privacy mode)
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The remembered workspace scope. Falls back to 'all' when the stored workspace no longer exists.
 * Returns [scope, setScope, selected workspace (if a specific one is chosen)].
 */
export function useWorkspaceScope(): [WorkspaceScope, (s: WorkspaceScope) => void, Workspace | undefined] {
  const scope = useSyncExternalStore(subscribe, getWorkspaceScope);
  const workspaces = useWorkspaces();
  const ws = isSpecific(scope) ? workspaces.data?.find((w) => w.id === scope) : undefined;
  const stale = isSpecific(scope) && workspaces.isSuccess && !ws;
  useEffect(() => {
    if (stale) setWorkspaceScope('all');
  }, [stale]);
  return [stale ? 'all' : scope, setWorkspaceScope, ws];
}

export const isSpecific = (scope: WorkspaceScope): boolean => scope !== 'all' && scope !== 'unassigned';

export function sandboxInScope(s: Sandbox, scope: WorkspaceScope): boolean {
  if (scope === 'all') return true;
  if (scope === 'unassigned') return !s.workspaceId;
  return s.workspaceId === scope;
}

export function agentInScope(a: Agent, sandboxes: Sandbox[] | undefined, scope: WorkspaceScope): boolean {
  if (scope === 'all') return true;
  const sb = sandboxes?.find((s) => s.id === a.sandboxId);
  return sb ? sandboxInScope(sb, scope) : scope === 'unassigned';
}

/** Tasks always belong to a workspace, so "unassigned" shows none. */
export function taskInScope(t: Task, scope: WorkspaceScope): boolean {
  if (scope === 'all') return true;
  if (scope === 'unassigned') return false;
  return t.workspaceId === scope;
}

/** Accent colours offered for workspaces. */
export const WORKSPACE_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'] as const;

export const workspaceColor = (w: Pick<Workspace, 'color'> | undefined): string => w?.color || '#94a3b8';
