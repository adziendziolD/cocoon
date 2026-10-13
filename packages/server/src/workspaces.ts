import { Workspace, WORKSPACE_KEY, type MethodParams, type Task } from '@cocoon/protocol';
import type { ActivityLog } from './activity.ts';
import { CocoonError, notFound } from './errors.ts';
import { t } from './i18n.ts';
import type { EventBus } from './events.ts';
import { newId } from './ids.ts';
import type { Store } from './store.ts';

/** Branch for a task: FD-12-add-apple-pay (git-safe, at most ~60 characters). */
export function taskBranch(key: string, number: number, title: string): string {
  const slug = title
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug ? `${key}-${number}-${slug}` : `${key}-${number}`;
}

/** Handle and branch of a task from its workspace key; the branch stays fixed once the task has run. */
export function withHandle(task: Task, key: string | undefined): Task {
  if (!key || task.number === undefined) return task;
  const handle = `${key}-${task.number}`;
  const branch = task.runs.length && task.branch ? task.branch : taskBranch(key, task.number, task.title);
  return handle === task.handle && branch === task.branch ? task : { ...task, handle, branch };
}

/**
 * Key for task handles from a workspace name: capitals of a camel-case or multi-word name ("FocusDigital" → "FD",
 * "Docs site" → "DS"), else the first letters ("cocoon" → "COC"); made unique with a number ("FD2").
 */
export function deriveKey(name: string, taken: Iterable<string>): string {
  const ascii = name.normalize('NFKD').replace(/[^\x00-\x7f]/g, '');
  const words = ascii.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const capitals = (ascii.match(/[A-Z]/g) ?? []).join('');
  let base =
    words.length > 1 ? words.map((w) => w[0]).join('') : capitals.length >= 2 && capitals.length < ascii.replace(/[^A-Za-z]/g, '').length ? capitals : (words[0] ?? '').slice(0, 3);
  base = base.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (!/^[A-Z]/.test(base)) base = `W${base}`.slice(0, 5);
  if (base.length < 2) base = `${base}W`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base.slice(0, 5 - String(n).length)}${n}`)) return `${base.slice(0, 5 - String(n).length)}${n}`;
}

/** Workspaces group sandboxes, agents and tasks. */
export class WorkspaceService {
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly activity: ActivityLog,
  ) {
    // Workspaces from before task numbers: give them a key and number their tasks by creation date.
    for (const workspace of this.list()) {
      if (workspace.key) continue;
      const tasks = this.store.tasks().filter((task) => task.workspaceId === workspace.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let next = workspace.nextTaskNumber ?? 1;
      const key = deriveKey(workspace.name, this.keys());
      for (const task of tasks) this.store.putTask(withHandle(task.number === undefined ? { ...task, number: next++ } : task, key));
      this.store.putWorkspace({ ...workspace, key, nextTaskNumber: next });
    }
  }

  private keys(exceptId?: string): string[] {
    return this.store.workspaces().filter((w) => w.id !== exceptId && w.key).map((w) => w.key!);
  }

  private checkKey(key: string | undefined, exceptId?: string): void {
    if (key && (!WORKSPACE_KEY.test(key) || this.keys(exceptId).includes(key))) throw new CocoonError('conflict', t('error.workspaceKeyTaken', { key }));
  }

  /** Next task number of a workspace (and counts it up). */
  allocateTaskNumber(workspaceId: string): number {
    const workspace = this.get(workspaceId);
    const number = workspace.nextTaskNumber ?? 1;
    this.save({ ...workspace, nextTaskNumber: number + 1 });
    return number;
  }

  list(): Workspace[] {
    return this.store.workspaces().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Workspace {
    const workspace = this.store.workspace(id);
    if (!workspace) throw notFound('Workspace', id);
    return workspace;
  }

  create(params: MethodParams<'workspace.create'>): Workspace {
    this.checkKey(params.key);
    const key = params.key ?? deriveKey(params.name, this.keys());
    const workspace = Workspace.parse(applyPatch({ id: newId('ws'), createdAt: new Date().toISOString(), key }, params));
    this.save(workspace);
    this.activity.add('info', 'activity.workspaceCreated', { name: workspace.name });
    return workspace;
  }

  update({ workspaceId, ...patch }: MethodParams<'workspace.update'> & { sharedSandboxId?: string }): Workspace {
    const current = this.get(workspaceId);
    this.checkKey(patch.key, workspaceId);
    const workspace = Workspace.parse(applyPatch(current, patch));
    this.save(workspace);
    if (workspace.key !== current.key) {
      for (const task of this.store.tasks().filter((x) => x.workspaceId === workspaceId)) {
        const next = withHandle(task, workspace.key);
        if (next === task) continue;
        this.store.putTask(next);
        this.bus.publish({ type: 'task.updated', task: next });
      }
    }
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
