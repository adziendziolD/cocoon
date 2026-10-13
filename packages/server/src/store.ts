import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, CockpitLayout, Sandbox, Settings, SharedService, Task, Workspace } from '@cocoon/protocol';

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
  /** Cockpit layouts by workspace id ("_global" for the overall layout). */
  layouts: Record<string, CockpitLayout>;
  /** Installed agent toolbox (agent CLIs shared by all sandboxes). */
  toolbox?: { tools: string[]; installedAt: string; versions?: Record<string, string> };
  /** Shared services (databases, mocks). */
  services: Record<string, ServiceRecord>;
}

/**
 * Minimal persistent state: one JSON file (mode 0600, contains secrets), rewritten atomically on every change.
 * Good enough for a single control-plane node; swap for SQLite/Postgres when going multi-node.
 */
export class Store {
  private readonly file: string;
  private state: State = { sandboxes: {}, agents: {}, secrets: {}, tokens: {}, workspaces: {}, tasks: {}, layouts: {}, services: {} };

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'state.json');
    try {
      this.state = { ...this.state, ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<State>) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
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
    for (const task of this.tasks()) if (task.workspaceId === id) delete this.state.tasks[task.id];
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

  layout(key: string): CockpitLayout | undefined {
    return this.state.layouts[key];
  }

  putLayout(key: string, layout: CockpitLayout): void {
    this.state.layouts[key] = layout;
    this.flush();
  }

  flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

export const publicSandbox = ({ handle: _h, ip: _ip, proxyToken: _t, pushedBranch: _b, pushedBranches: _pb, grants: _g, serviceDbs: _s, ...sandbox }: SandboxRecord): Sandbox => ({
  ...sandbox,
  services: sandbox.services ?? [],
  repos: sandbox.repos?.length ? sandbox.repos : sandbox.repo ? [{ url: sandbox.repo.url, ref: sandbox.repo.ref, path: '' }] : [],
});
export const publicAgent = (agent: AgentRecord): Agent => ({ ...agent });
