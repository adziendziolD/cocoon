import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, CockpitLayout, EnvTarget, Sandbox, Schedule, Settings, ServiceKind, SharedService, Task, Workspace } from '@cocoon/protocol';

export interface SandboxRecord extends Sandbox {
  /** Driver-specific handle, e.g. Docker container id. */
  handle?: string;
  /** Address on the internal egress network (egress mode only). */
  ip?: string;
  /** Per-sandbox secret the egress proxy uses to identify credential placeholders. */
  proxyToken: string;
  /** Branch most recently pushed via git.push. */
  pushedBranch?: string;
  /** Branch most recently pushed per repository folder (several repositories). */
  pushedBranches?: Record<string, string>;
  /** Credential-proxy routes this sandbox may use (granted when an agent using them is spawned). */
  grants?: string[];
  /** Own database/user per shared service (by service id). */
  serviceDbs?: Record<string, SandboxServiceDb>;
  /** Ports opened to the outside through the port gateway. */
  ports?: OpenPort[];
}

export interface OpenPort {
  port: number;
  mode: 'preview' | 'shared';
  /** Host port the gateway publishes for it. */
  hostPort: number;
  name?: string;
  openedAt: string;
}

/** A managed service that was removed with its data volume kept: the admin password the volume was initialised with. */
export interface RetainedService {
  id: string;
  kind: ServiceKind;
  adminPassword: string;
  removedAt: string;
}

export interface SandboxServiceDb {
  name: string;
  password: string;
  /** Set when provisioning failed (retried when an agent starts). */
  error?: string;
}

export interface ServiceRecord extends SharedService {
  /** managed: generated admin password; external: admin password entered by the user. */
  adminPassword?: string;
  /** managed: whether the user wants it running. */
  desired?: 'running' | 'stopped';
  /** external with container drivers: proxy port relaying to the server. */
  relayPort?: number;
}

export type AgentRecord = Agent;

export interface SecretRecord {
  value: string;
  updatedAt: string;
}

/** One environment variable: the value is encrypted (see EnvVault), the rest is plain metadata. */
export interface EnvVarRecord {
  enc: string;
  target: EnvTarget;
  secret: boolean;
  proxyHost?: string;
  baseUrlEnv?: string;
  updatedAt: string;
}

/** Variables of one level; the store key is "workspace:<id>", "repo:<normalized url>" or "sandbox:<id>". */
export interface EnvScopeRecord {
  filePath?: string;
  vars: Record<string, EnvVarRecord>;
}

export interface TokenRecord {
  id: string;
  name: string;
  hash: string;
  preview: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface State {
  sandboxes: Record<string, SandboxRecord>;
  agents: Record<string, AgentRecord>;
  settings?: Settings;
  secrets: Record<string, SecretRecord>;
  tokens: Record<string, TokenRecord>;
  workspaces: Record<string, Workspace>;
  tasks: Record<string, Task>;
  /** Scheduled agents. */
  schedules: Record<string, Schedule>;
  /** Cockpit layouts by workspace id ("_global" for the overall layout). */
  layouts: Record<string, CockpitLayout>;
  /** Installed agent toolbox (agent CLIs shared by all sandboxes). */
  toolbox?: { tools: string[]; installedAt: string; versions?: Record<string, string>; /** Node.js version in the toolbox. */ runtime?: string };
  /** Shared services (databases, mocks). */
  services: Record<string, ServiceRecord>;
  /** Removed managed services whose data volume was kept, by service id. */
  retainedServices?: Record<string, RetainedService>;
  /** Environment variables (.env injection) by level. */
  envScopes: Record<string, EnvScopeRecord>;
}

/**
 * Minimal persistent state: one JSON file (mode 0600, contains secrets), rewritten atomically on every change.
 * Good enough for a single control-plane node; swap for SQLite/Postgres when going multi-node.
 */
export class Store {
  private readonly file: string;
  private state: State = { sandboxes: {}, agents: {}, secrets: {}, tokens: {}, workspaces: {}, tasks: {}, schedules: {}, layouts: {}, services: {}, envScopes: {} };

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'state.json');
    this.state = { ...this.state, ...this.load() };
  }

  /** Reads state.json; if it is unreadable (e.g. truncated by a power loss), falls back to the previous version, state.json.bak. */
  private load(): Partial<State> {
    let failure: unknown;
    for (const file of [this.file, `${this.file}.bak`]) {
      try {
        const state = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>;
        if (file !== this.file) console.error(`cocoon: ${this.file} is ${failure ? `unreadable (${(failure as Error).message})` : 'missing'}, restored ${file}; changes since the last good write are lost`);
        return state;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        failure ??= err;
      }
    }
    if (failure) throw failure;
    return {};
  }

  sandboxes(): SandboxRecord[] {
    return Object.values(this.state.sandboxes);
  }

  sandbox(id: string): SandboxRecord | undefined {
    return this.state.sandboxes[id];
  }

  putSandbox(record: SandboxRecord): void {
    this.state.sandboxes[record.id] = record;
    this.flush();
  }

  deleteSandbox(id: string): void {
    delete this.state.sandboxes[id];
    for (const agent of this.agents()) if (agent.sandboxId === id) delete this.state.agents[agent.id];
    delete this.state.envScopes[`sandbox:${id}`];
    this.flush();
  }

  agents(): AgentRecord[] {
    return Object.values(this.state.agents);
  }

  agent(id: string): AgentRecord | undefined {
    return this.state.agents[id];
  }

  putAgent(record: AgentRecord): void {
    this.state.agents[record.id] = record;
    this.flush();
  }

  settings(): Settings | undefined {
    return this.state.settings;
  }

  putSettings(settings: Settings): void {
    this.state.settings = settings;
    this.flush();
  }

  secrets(): Record<string, SecretRecord> {
    return this.state.secrets;
  }

  putSecret(name: string, record: SecretRecord | undefined): void {
    if (record) this.state.secrets[name] = record;
    else delete this.state.secrets[name];
    this.flush();
  }

  tokens(): TokenRecord[] {
    return Object.values(this.state.tokens);
  }

  putToken(record: TokenRecord | { id: string; delete: true }): void {
    if ('delete' in record) delete this.state.tokens[record.id];
    else this.state.tokens[record.id] = record;
    this.flush();
  }

  workspaces(): Workspace[] {
    return Object.values(this.state.workspaces);
  }

  workspace(id: string): Workspace | undefined {
    return this.state.workspaces[id];
  }

  putWorkspace(workspace: Workspace): void {
    this.state.workspaces[workspace.id] = workspace;
    this.flush();
  }

  deleteWorkspace(id: string): void {
    delete this.state.workspaces[id];
    delete this.state.layouts[id];
    delete this.state.envScopes[`workspace:${id}`];
    for (const task of this.tasks()) if (task.workspaceId === id) delete this.state.tasks[task.id];
    for (const schedule of this.schedules()) if (schedule.workspaceId === id) delete this.state.schedules[schedule.id];
    this.flush();
  }

  tasks(): Task[] {
    return Object.values(this.state.tasks);
  }

  task(id: string): Task | undefined {
    return this.state.tasks[id];
  }

  putTask(task: Task): void {
    this.state.tasks[task.id] = task;
    this.flush();
  }

  deleteTask(id: string): void {
    delete this.state.tasks[id];
    this.flush();
  }

  schedules(): Schedule[] {
    return Object.values(this.state.schedules);
  }

  schedule(id: string): Schedule | undefined {
    return this.state.schedules[id];
  }

  putSchedule(schedule: Schedule): void {
    this.state.schedules[schedule.id] = schedule;
    this.flush();
  }

  deleteSchedule(id: string): void {
    delete this.state.schedules[id];
    this.flush();
  }

  toolbox(): State['toolbox'] {
    return this.state.toolbox;
  }

  putToolbox(toolbox: NonNullable<State['toolbox']>): void {
    this.state.toolbox = toolbox;
    this.flush();
  }

  services(): ServiceRecord[] {
    return Object.values(this.state.services);
  }

  service(id: string): ServiceRecord | undefined {
    return this.state.services[id];
  }

  putService(record: ServiceRecord): void {
    this.state.services[record.id] = record;
    this.flush();
  }

  deleteService(id: string): void {
    delete this.state.services[id];
    this.flush();
  }
  retainedService(id: string): RetainedService | undefined {
    return this.state.retainedServices?.[id];
  }
  putRetainedService(record: RetainedService): void {
    this.state.retainedServices = { ...this.state.retainedServices, [record.id]: record };
    this.flush();
  }
  deleteRetainedService(id: string): void {
    if (!this.state.retainedServices?.[id]) return;
    delete this.state.retainedServices[id];
    this.flush();
  }

  envScope(key: string): EnvScopeRecord | undefined {
    return this.state.envScopes[key];
  }

  putEnvScope(key: string, record: EnvScopeRecord | undefined): void {
    if (record && (Object.keys(record.vars).length || record.filePath)) this.state.envScopes[key] = record;
    else delete this.state.envScopes[key];
    this.flush();
  }

  layout(key: string): CockpitLayout | undefined {
    return this.state.layouts[key];
  }

  putLayout(key: string, layout: CockpitLayout): void {
    this.state.layouts[key] = layout;
    this.flush();
  }

  flush(): void {
    const tmp = `${this.file}.tmp`;
    // Data reaches the disk before the rename can, so a power loss leaves the old or the new file, never an empty one.
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(this.state, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    try {
      renameSync(this.file, `${this.file}.bak`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    renameSync(tmp, this.file);
    syncDir(this.dataDir);
  }
}

/** Persists directory entries (the rename); not possible on every platform. */
function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best effort
  }
}

export const publicSandbox = ({ handle: _h, ip: _ip, proxyToken: _t, pushedBranch: _b, pushedBranches: _pb, grants: _g, serviceDbs: _s, ...sandbox }: SandboxRecord): Sandbox => ({
  ...sandbox,
  services: sandbox.services ?? [],
  repos: sandbox.repos?.length ? sandbox.repos : sandbox.repo ? [{ url: sandbox.repo.url, ref: sandbox.repo.ref, path: '' }] : [],
});
export const publicAgent = (agent: AgentRecord): Agent => ({ ...agent });
