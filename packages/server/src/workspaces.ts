import { Workspace, type MethodParams } from '@cocoon/protocol';
import type { ActivityLog } from './activity.ts';
import { notFound } from './errors.ts';
import type { EventBus } from './events.ts';
import { newId } from './ids.ts';
import type { Store } from './store.ts';

/** Workspaces group sandboxes, agents and tasks. */
export class WorkspaceService {
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly activity: ActivityLog,
  ) {}

  list(): Workspace[] {
    return this.store.workspaces().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Workspace {
    const workspace = this.store.workspace(id);
    if (!workspace) throw notFound('Workspace', id);
    return workspace;
  }

  create(params: MethodParams<'workspace.create'>): Workspace {
    const workspace = Workspace.parse(applyPatch({ id: newId('ws'), createdAt: new Date().toISOString() }, params));
    this.save(workspace);
    this.activity.add('info', 'activity.workspaceCreated', { name: workspace.name });
    return workspace;
  }

  update({ workspaceId, ...patch }: MethodParams<'workspace.update'> & { sharedSandboxId?: string }): Workspace {
    const current = this.get(workspaceId);
    const workspace = Workspace.parse(applyPatch(current, patch));
    this.save(workspace);
    return workspace;
  }

  /** Removes the workspace record (tasks are removed by the store); returns its sandbox ids. */
  remove(workspaceId: string): string[] {
    this.get(workspaceId);
    const sandboxIds = this.store.sandboxes().filter((s) => s.workspaceId === workspaceId).map((s) => s.id);
    this.store.deleteWorkspace(workspaceId);
    this.bus.publish({ type: 'workspace.deleted', workspaceId });
    return sandboxIds;
  }

  private save(workspace: Workspace): void {
    this.store.putWorkspace(workspace);
    this.bus.publish({ type: 'workspace.updated', workspace });
  }
}

/** Applies a patch: undefined = keep, "" or null = clear the field. */
export function applyPatch<T extends object>(target: T, patch: object): T {
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || value === '') delete result[key];
    else result[key] = value;
  }
  return result as T;
}
