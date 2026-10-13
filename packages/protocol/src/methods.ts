import { z } from 'zod';
import { CockpitLayout, Task, TaskPriority, TaskStatus, Workspace } from './orchestration.ts';
import {
  ActivityEntry,
  Agent,
  AgentStatus,
  DeniedConnection,
  FileEntry,
  GitFileStatus,
  ImageInfo,
  ImageKind,
  NetworkMode,
  RepoSource,
  Resources,
  Sandbox,
  SandboxPort,
  PortMode,
  AgentAdapter,
  AgentTool,
  ApiProvider,
  ApiStyle,
  ModelInfo,
  DriverCapabilities,
  DriverKind,
  PROVIDER_ID,
  SECRET_NAME,
  SecretInfo,
  SetupStep,
  Settings,
  TokenInfo,
  UpdateStatus,
  UpdateTarget,
} from './models.ts';
import { EnvFileStatus, EnvScopeInfo, EnvScopeRef, EnvTarget, EnvVarInput, ResolvedEnv } from './env.ts';
import { SERVICE_ID, ServiceAdminCredentials, ServiceConnection, ServiceInfo, ServiceKind, SharedService } from './services.ts';

/**
 * Partial schema for settings updates. Unlike `.partial()`, it strips field defaults – otherwise every omitted
 * field would be filled with its default and silently overwrite the stored value.
 */
function patchOf<T extends z.ZodObject>(section: z.ZodPrefault<T> | z.ZodDefault<T>) {
  const shape = Object.fromEntries(
    Object.entries(section.unwrap().shape).map(([key, field]) => {
      const inner = field instanceof z.ZodDefault || field instanceof z.ZodPrefault ? field.unwrap() : field;
      return [key, (inner as z.ZodType).optional()];
    }),
  );
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T['shape']]: z.ZodOptional<T['shape'][K]> }>;
}

const SandboxRef = z.object({ sandboxId: z.string() });
/** Which repository of the sandbox (its folder, e.g. "api"). Optional when the sandbox has only one. */
const RepoRef = z.string().optional();
const RepoSummary = z.object({
  path: z.string(),
  url: z.string().optional(),
  branch: z.string(),
  head: z.string(),
  changes: z.number(),
  pushedBranch: z.string().optional(),
  error: z.string().optional(),
});
const WorkspaceRef = z.object({ workspaceId: z.string() });
const TaskRef = z.object({ taskId: z.string() });

/** Optional workspace/task fields accept "" or null to clear them. */
const WorkspaceInput = z.object({
  name: Workspace.shape.name,
  description: z.string().nullable().optional(),
  color: z.string().optional(),
  repo: RepoSource.nullable().optional(),
  repos: z.array(RepoSource).max(20).nullable().optional(),
  network: NetworkMode.optional(),
  sandboxMode: z.enum(['per-task', 'shared']).optional(),
  defaultAgentKind: z.string().optional(),
  defaultWorkflowId: z.string().nullable().optional(),
  autoRun: z.boolean().optional(),
  maxParallel: z.number().int().min(1).max(20).optional(),
});

const TaskInput = z.object({
  title: Task.shape.title,
  description: z.string().optional(),
  priority: TaskPriority.optional(),
  agentKind: z.string().optional(),
  workflowId: z.string().nullable().optional(),
  providers: z.array(z.string()).optional(),
  model: z.string().nullable().optional(),
  dependsOn: z.array(z.string()).optional(),
  sandboxId: z.string().nullable().optional(),
});
const AgentRef = z.object({ agentId: z.string() });
const Ok = z.object({ ok: z.literal(true) });
const Empty = z.object({}).default({});

interface MethodDef {
  description: string;
  params: z.ZodType;
  result: z.ZodType;
  /** Exposed as MCP tool (agent-facing). Admin methods (secrets, tokens, settings) are not. */
  mcp?: boolean;
}

/**
 * Every control-plane operation is a named method with a params and result schema.
 * The same registry is served over HTTP (POST /v1/rpc/:method), WebSocket (/v1/ws) and MCP (/mcp).
 */
export const methods = {
  // ── system ────────────────────────────────────────────────────────────────
  'system.info': {
    description: 'Server version, isolation driver, available runtimes and counts.',
    mcp: true,
    params: Empty,
    result: z.object({
      version: z.string(),
      driver: z.string(),
      driverKind: DriverKind,
      capabilities: DriverCapabilities,
      /** Version of the isolation backend (Docker, Podman or bubblewrap). */
      dockerVersion: z.string().optional(),
      runtimes: z.array(z.string()),
      agentKinds: z.array(z.string()),
      sandboxes: z.number(),
      agents: z.number(),
      proxyRunning: z.boolean(),
      /** Installed git commit of CoCoon (short hash), if installed from a git clone. */
      commit: z.string().optional(),
      /** When this server process started (changes after a restart). */
      startedAt: z.string().optional(),
      /** Port forwarding: available (Docker/Podman) and whether ports may be shared on the network. */
      ports: z.object({ enabled: z.boolean(), share: z.boolean() }).optional(),
    }),
  },
  'system.setup_status': {
    description: 'Checklist of first-time setup steps for the UI.',
    params: Empty,
    result: z.object({ complete: z.boolean(), steps: z.array(SetupStep) }),
  },
  'activity.list': {
    description: 'Recent human-readable activity log entries, newest first.',
    params: z.object({ limit: z.number().int().positive().max(1000).default(200) }).default({ limit: 200 }),
    result: z.array(ActivityEntry),
  },

  // ── images ────────────────────────────────────────────────────────────────
  'image.status': {
    description: 'Whether the sandbox and egress-proxy images exist locally.',
    params: Empty,
    result: z.array(ImageInfo),
  },
  'image.build': {
    description: 'Builds an image in the background; progress arrives as "image.build" events.',
    params: z.object({
      kind: ImageKind,
      /** sandbox: "slim" (default) or "full" (adds compilers and Python). */
      variant: z.enum(['slim', 'full']).default('slim'),
      /** agents: which agent CLIs to install into the toolbox (default: all). */
      tools: z.array(AgentTool).optional(),
      /** @deprecated kept for older clients; agent CLIs now live in the toolbox. */
      installAgents: z.boolean().optional(),
    }),
    result: z.object({ buildId: z.string() }),
  },

  // ── ports ─────────────────────────────────────────────────────────────────
  'ports.list': {
    description: 'Ports of a sandbox: detected listening ports and ports opened to the outside (preview or shared).',
    mcp: true,
    params: SandboxRef,
    result: z.array(SandboxPort),
  },
  'ports.open': {
    description:
      'Opens a sandbox port to the outside. preview: only for people logged in to CoCoon (get a link with ports.preview_link). shared: reachable on the host network.',
    mcp: true,
    params: SandboxRef.extend({ port: z.number().int().min(1).max(65535), mode: PortMode.default('preview'), name: z.string().max(60).optional() }),
    result: SandboxPort,
  },
  'ports.close': {
    description: 'Closes an opened sandbox port again.',
    mcp: true,
    params: SandboxRef.extend({ port: z.number().int() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'ports.preview_link': {
    description: 'Link to the preview of an opened port. Contains a one-time token that logs the browser in to this preview only.',
    params: SandboxRef.extend({ port: z.number().int() }),
    result: z.object({ url: z.string(), expiresAt: z.string() }),
  },

  // ── updates ───────────────────────────────────────────────────────────────
  'update.status': {
    description: 'Whether CoCoon, the agent CLIs and the images are up to date. refresh=true checks the remotes again (git fetch, npm, registry).',
    mcp: true,
    params: z.object({ refresh: z.boolean().default(false) }).default({ refresh: false }),
    result: UpdateStatus,
  },
  'update.apply': {
    description:
      'Updates the given parts in the background (default: everything outdated): CoCoon via git + pnpm (then restarts), images by rebuilding, agent CLIs by reinstalling. Progress arrives as "update.progress" / "image.build" events.',
    params: z.object({ targets: z.array(UpdateTarget).optional() }).default({}),
    result: z.object({ targets: z.array(UpdateTarget) }),
  },
  'system.restart': {
    description: 'Restarts the server (only when it runs under CoCoon\'s supervisor, see update.status canRestart).',
    params: Empty,
    result: z.object({ ok: z.literal(true) }),
  },

  // ── settings / secrets / tokens ───────────────────────────────────────────
  'settings.get': { description: 'Current server settings.', params: Empty, result: Settings },
  'settings.update': {
    description: 'Updates settings. Each given section is merged shallowly; "agents", "providers" and "workflows" replace the whole map.',
    params: z.object({
      general: patchOf(Settings.shape.general).optional(),
      providers: Settings.shape.providers.unwrap().optional(),
      sandbox: patchOf(Settings.shape.sandbox).optional(),
      egress: patchOf(Settings.shape.egress).optional(),
      agents: Settings.shape.agents.unwrap().optional(),
      status: patchOf(Settings.shape.status).optional(),
      git: patchOf(Settings.shape.git).optional(),
      workflows: Settings.shape.workflows.unwrap().optional(),
      notifications: patchOf(Settings.shape.notifications).optional(),
    }),
    result: Settings,
  },
  'settings.reset': {
    description: 'Resets one settings section (or all) to defaults.',
    params: z.object({
      section: z.enum(['general', 'providers', 'sandbox', 'egress', 'agents', 'status', 'git', 'workflows', 'notifications']).optional(),
    }),
    result: Settings,
  },
  'secrets.list': { description: 'Known and stored secrets (values masked).', params: Empty, result: z.array(SecretInfo) },
  'secrets.set': {
    description: 'Stores a secret such as an API key.',
    params: z.object({ name: z.string().regex(SECRET_NAME), value: z.string().min(1) }),
    result: SecretInfo,
  },
  'secrets.delete': { description: 'Deletes a stored secret.', params: z.object({ name: z.string() }), result: Ok },
  'tokens.list': { description: 'API access tokens (values masked).', params: Empty, result: z.array(TokenInfo) },
  'tokens.create': {
    description: 'Creates an API token. The token value is only returned once.',
    params: z.object({ name: z.string().min(1).max(64) }),
    result: z.object({ token: z.string(), info: TokenInfo }),
  },
  'tokens.revoke': { description: 'Revokes an API token.', params: z.object({ id: z.string() }), result: Ok },
  'providers.test': {
    description: 'Tests an API provider from the server: reachability, authentication, and available models.',
    params: z.union([z.object({ id: z.string().regex(PROVIDER_ID) }), z.object({ provider: ApiProvider })]),
    result: z.object({
      ok: z.boolean(),
      status: z.number().optional(),
      message: z.string(),
      models: z.array(z.string()).default([]),
      /** Supported API styles (probed with a minimal request against the first/default model). */
      apis: z.array(ApiStyle).default([]),
      /** Model limits the server reports (context window, max output), by model id. */
      modelInfo: z.record(z.string(), ModelInfo).default({}),
    }),
  },
  'models.list': {
    description:
      "Models an agent type offers with its default credentials (Anthropic/OpenAI/Gemini key): listed from the vendor's API, plus built-in aliases. Empty if nothing is known.",
    params: z.object({ adapter: AgentAdapter }),
    result: z.object({ models: z.array(z.string()).default([]), source: z.enum(['api', 'builtin', 'none']).default('none') }),
  },
  'notifications.test': {
    description: 'Sends a test message to the configured notification webhook.',
    params: z.object({ webhookUrl: z.url().optional() }).default({}),
    result: z.object({ ok: z.boolean(), status: z.number().optional(), message: z.string() }),
  },
  'egress.denied': {
    description: 'Recently blocked outgoing connections from sandboxes (egress mode).',
    params: Empty,
    result: z.array(DeniedConnection),
  },


  // ── shared services (databases, mocks) ───────────────────────────────────
  'services.list': {
    description: 'Shared services (databases such as PostgreSQL/MySQL/MongoDB/Redis, mocks such as WireMock/Mailpit) and their status.',
    mcp: true,
    params: Empty,
    result: z.array(ServiceInfo),
  },
  'services.add': {
    description: 'Adds a shared service: "managed" starts a container on the server, "external" connects to an existing server.',
    params: z.object({
      kind: ServiceKind,
      id: z.string().regex(SERVICE_ID).optional(),
      label: SharedService.shape.label,
      mode: SharedService.shape.mode.default('managed'),
      image: z.string().optional(),
      memoryMb: SharedService.shape.memoryMb,
      host: z.string().optional(),
      port: SharedService.shape.port,
      adminUser: z.string().optional(),
      adminPassword: z.string().optional(),
      tls: z.boolean().optional(),
      attach: z.enum(['all', 'manual']).default('all'),
      autoStop: z.boolean().optional(),
      /** Also attach to existing sandboxes now (only with attach "all"). */
      attachExisting: z.boolean().default(true),
    }),
    result: ServiceInfo,
  },
  'services.update': {
    description: 'Changes a shared service (label, automatic attachment, external connection data).',
    params: z.object({
      serviceId: z.string(),
      label: z.string().max(80).nullable().optional(),
      attach: z.enum(['all', 'manual']).optional(),
      autoStop: z.boolean().optional(),
      host: z.string().optional(),
      port: SharedService.shape.port,
      adminUser: z.string().optional(),
      adminPassword: z.string().optional(),
      tls: z.boolean().optional(),
    }),
    result: ServiceInfo,
  },
  'services.remove': {
    description: 'Removes a shared service. Sandbox databases are dropped; deleteData also deletes the data volume of a managed service.',
    params: z.object({ serviceId: z.string(), deleteData: z.boolean().default(false) }),
    result: Ok,
  },
  'services.start': { description: 'Starts a managed service.', params: z.object({ serviceId: z.string() }), result: ServiceInfo },
  'services.stop': { description: 'Stops a managed service (data is kept).', params: z.object({ serviceId: z.string() }), result: ServiceInfo },
  'services.test': {
    description: 'Checks the admin connection to a service.',
    params: z.object({ serviceId: z.string() }),
    result: z.object({ ok: z.boolean(), version: z.string().optional(), error: z.string().optional() }),
  },
  'services.credentials': {
    description: 'Admin connection data of a service as seen from the CoCoon server (for database tools).',
    params: z.object({ serviceId: z.string() }),
    result: ServiceAdminCredentials,
  },
  'services.connections': {
    description: 'Connection data (host, database, user, password, env vars) of the shared services attached to a sandbox.',
    mcp: true,
    params: SandboxRef,
    result: z.array(ServiceConnection),
  },
  'services.attach': {
    description: 'Attaches a shared service to a sandbox: creates its own database/user and returns the connection. Running agents need a restart to get the env vars.',
    mcp: true,
    params: z.object({ sandboxId: z.string(), serviceId: z.string() }),
    result: ServiceConnection,
  },
  'services.detach': {
    description: 'Detaches a shared service from a sandbox and drops its database/user (or mock stubs).',
    mcp: true,
    params: z.object({ sandboxId: z.string(), serviceId: z.string() }),
    result: Ok,
  },
  'services.reset': {
    description: 'Empties the sandbox database of a service (drop and recreate) – a clean slate for tests. Same credentials.',
    mcp: true,
    params: z.object({ sandboxId: z.string(), serviceId: z.string() }),
    result: ServiceConnection,
  },

  // ── sandboxes ─────────────────────────────────────────────────────────────
  'sandbox.create': {
    description: 'Creates an isolated sandbox, optionally cloning a git repository into /workspace.',
    mcp: true,
    params: z.object({
      name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/).optional(),
      image: z.string().optional(),
      repo: RepoSource.optional(),
      /** Several repositories, each in its own folder (e.g. the services of one platform). */
      repos: z.array(RepoSource).max(20).optional(),
      network: NetworkMode.optional(),
      runtime: z.string().nullable().optional(),
      resources: Resources.optional(),
      workspaceId: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      /** Shared services to attach (default: all services set to "every sandbox"). */
      services: z.array(z.string()).optional(),
    }),
    result: Sandbox,
  },
  'sandbox.list': { description: 'Lists all sandboxes.', mcp: true, params: Empty, result: z.array(Sandbox) },
  'sandbox.get': { description: 'Gets one sandbox.', mcp: true, params: SandboxRef, result: Sandbox },
  'sandbox.update': {
    description: 'Renames a sandbox or moves it to another workspace (workspaceId null = unassigned).',
    mcp: true,
    params: SandboxRef.extend({
      name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/).optional(),
      workspaceId: z.string().nullable().optional(),
    }),
    result: Sandbox,
  },
  'sandbox.start': { description: 'Starts a stopped sandbox.', mcp: true, params: SandboxRef, result: Sandbox },
  'sandbox.stop': { description: 'Stops a sandbox (files are kept, running agents end).', mcp: true, params: SandboxRef, result: Sandbox },
  'sandbox.delete': { description: 'Deletes a sandbox and all its files.', mcp: true, params: SandboxRef, result: Ok },
  'sandbox.exec': {
    description: 'Runs a command in the sandbox workspace and returns its output.',
    mcp: true,
    params: SandboxRef.extend({
      command: z.array(z.string()).min(1),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
    }),
    result: z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() }),
  },
  'sandbox.diff': {
    description:
      'Binary git patch of all changes since the sandbox was created. With several repositories and no "repo", one combined patch whose paths start with the repository folder.',
    mcp: true,
    params: SandboxRef.extend({ repo: RepoRef }),
    result: z.object({
      patch: z.string(),
      files: z.array(z.string()),
      /** Changed files per repository (several repositories only). */
      repos: z.array(z.object({ path: z.string(), files: z.array(z.string()) })).optional(),
    }),
  },
  'sandbox.apply_patch': {
    description: 'Applies a git patch to a repository of the sandbox.',
    mcp: true,
    params: SandboxRef.extend({ patch: z.string().min(1), repo: RepoRef }),
    result: z.object({ applied: z.boolean(), output: z.string() }),
  },

  // ── files ─────────────────────────────────────────────────────────────────
  'files.list': {
    description: 'Lists a directory in the sandbox (relative paths are resolved against /workspace).',
    mcp: true,
    params: SandboxRef.extend({ path: z.string().default('.') }),
    result: z.object({ path: z.string(), entries: z.array(FileEntry) }),
  },
  'files.read': {
    description: 'Reads a file from the sandbox. Binary files are returned base64-encoded.',
    mcp: true,
    params: SandboxRef.extend({ path: z.string(), maxBytes: z.number().int().positive().max(20_000_000).default(2_000_000) }),
    result: z.object({
      path: z.string(),
      content: z.string(),
      encoding: z.enum(['utf8', 'base64']),
      size: z.number(),
      truncated: z.boolean(),
    }),
  },
  'files.write': {
    description: 'Writes (creates or overwrites) a file in the sandbox.',
    mcp: true,
    params: SandboxRef.extend({ path: z.string(), content: z.string(), encoding: z.enum(['utf8', 'base64']).default('utf8') }),
    result: Ok,
  },
  'files.mkdir': {
    description: 'Creates a directory (including parents) in the sandbox.',
    mcp: true,
    params: SandboxRef.extend({ path: z.string() }),
    result: Ok,
  },
  'files.delete': {
    description: 'Deletes a file or directory in the sandbox.',
    mcp: true,
    params: SandboxRef.extend({ path: z.string() }),
    result: Ok,
  },

  // ── git ───────────────────────────────────────────────────────────────────
  'sandbox.add_repo': {
    description: 'Clones another git repository into the sandbox (into its own folder, default: derived from the URL).',
    mcp: true,
    params: SandboxRef.extend({ url: z.string().min(1), ref: z.string().optional(), path: RepoSource.shape.path }),
    result: Sandbox,
  },
  'sandbox.remove_repo': {
    description: 'Removes a repository folder from the sandbox (unpushed changes are lost).',
    mcp: true,
    params: SandboxRef.extend({ repo: z.string() }),
    result: Sandbox,
  },
  'git.repos': {
    description: 'Overview of all repositories in the sandbox: folder, remote, branch, number of changed files.',
    mcp: true,
    params: SandboxRef,
    result: z.array(RepoSummary),
  },
  'git.status': {
    description: 'Current branch, HEAD and changed files of a repository in the sandbox.',
    mcp: true,
    params: SandboxRef.extend({ repo: RepoRef }),
    result: z.object({
      branch: z.string(),
      head: z.string(),
      remoteUrl: z.string().optional(),
      /** Branch most recently pushed via git.push (for pre-filling pull requests). */
      pushedBranch: z.string().optional(),
      files: z.array(GitFileStatus),
    }),
  },
  'git.commit': {
    description: 'Commits all changes of a repository in the sandbox.',
    mcp: true,
    params: SandboxRef.extend({ message: z.string().min(1), repo: RepoRef }),
    result: z.object({ sha: z.string() }),
  },
  'git.push': {
    description: 'Pushes the current HEAD to a branch on the origin remote (uses GITHUB_TOKEN).',
    mcp: true,
    params: SandboxRef.extend({ branch: z.string().regex(/^[\w./-]+$/), repo: RepoRef }),
    result: z.object({ branch: z.string(), remoteUrl: z.string() }),
  },
  'git.create_pr': {
    description: 'Opens a GitHub pull request for a pushed branch (uses GITHUB_TOKEN).',
    mcp: true,
    params: SandboxRef.extend({
      branch: z.string(),
      title: z.string().min(1),
      body: z.string().optional(),
      base: z.string().optional(),
      repo: RepoRef,
    }),
    result: z.object({ url: z.string(), number: z.number() }),
  },

  // ── agents ────────────────────────────────────────────────────────────────
  'agent.spawn': {
    description: 'Starts an agent (e.g. claude-code, codex, shell) in a sandbox, optionally with an initial task.',
    mcp: true,
    params: SandboxRef.extend({
      kind: z.string(),
      prompt: z.string().optional(),
      /** Overrides the profile's API providers. */
      providers: z.array(z.string()).optional(),
      /** Overrides the profile's / provider's model. */
      model: z.string().optional(),
      /** Override the model's context window / answer length (tokens). */
      contextWindow: z.number().int().min(1024).optional(),
      maxOutputTokens: z.number().int().min(256).optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
    result: Agent,
  },
  'agent.list': {
    description: 'Lists agents, optionally for one sandbox.',
    mcp: true,
    params: z.object({ sandboxId: z.string().optional() }).default({}),
    result: z.array(Agent),
  },
  'agent.get': { description: 'Gets one agent.', mcp: true, params: AgentRef, result: Agent },
  'agent.send_input': {
    description: "Types text into the agent's terminal; submit presses Enter afterwards.",
    mcp: true,
    params: AgentRef.extend({ text: z.string(), submit: z.boolean().default(true) }),
    result: Ok,
  },
  'agent.send_keys': {
    description: 'Sends tmux key names, e.g. ["Escape"], ["C-c"], ["Down", "Enter"].',
    mcp: true,
    params: AgentRef.extend({ keys: z.array(z.string()).min(1) }),
    result: Ok,
  },
  'agent.read': {
    description: "Reads the agent's terminal (visible screen plus scrollback).",
    mcp: true,
    params: AgentRef.extend({ lines: z.number().int().positive().max(10_000).default(200) }),
    result: z.object({ text: z.string() }),
  },
  'agent.wait': {
    description: 'Waits until the agent reaches one of the given statuses (default: done, blocked, exited).',
    mcp: true,
    params: AgentRef.extend({
      until: z.array(AgentStatus).default(['done', 'blocked', 'exited']),
      timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
    }),
    result: z.object({ agent: Agent, timedOut: z.boolean() }),
  },
  'agent.kill': { description: 'Stops an agent.', mcp: true, params: AgentRef, result: Ok },
  'agent.switch': {
    description:
      'Starts another agent (type, provider, model) in the same sandbox, optionally handing over the previous task, changes and last output, and stops the previous agent.',
    mcp: true,
    params: AgentRef.extend({
      kind: z.string(),
      providers: z.array(z.string()).optional(),
      model: z.string().optional(),
      contextWindow: z.number().int().min(1024).optional(),
      maxOutputTokens: z.number().int().min(256).optional(),
      handover: z.boolean().default(true),
      /** Extra instruction for the new agent. */
      prompt: z.string().optional(),
      stopPrevious: z.boolean().default(true),
    }),
    result: Agent,
  },

  // ── workspaces ────────────────────────────────────────────────────────────
  'workspace.list': { description: 'Lists workspaces.', mcp: true, params: Empty, result: z.array(Workspace) },
  'workspace.get': { description: 'Gets one workspace.', mcp: true, params: WorkspaceRef, result: Workspace },
  'workspace.create': {
    description: 'Creates a workspace that groups sandboxes, agents and tasks.',
    mcp: true,
    params: WorkspaceInput,
    result: Workspace,
  },
  'workspace.update': {
    description: 'Updates a workspace.',
    mcp: true,
    params: WorkspaceRef.extend(WorkspaceInput.partial().shape),
    result: Workspace,
  },
  'workspace.delete': {
    description: 'Deletes a workspace and its tasks. Its sandboxes are kept (unassigned) unless deleteSandboxes is set.',
    mcp: true,
    params: WorkspaceRef.extend({ deleteSandboxes: z.boolean().default(false) }),
    result: Ok,
  },

  // ── tasks ─────────────────────────────────────────────────────────────────
  'task.list': {
    description: 'Lists tasks, optionally of one workspace.',
    mcp: true,
    params: z.object({ workspaceId: z.string().optional() }).default({}),
    result: z.array(Task),
  },
  'task.get': { description: 'Gets one task.', mcp: true, params: TaskRef, result: Task },
  'task.create': {
    description: 'Creates a task in a workspace (status backlog by default; "queued" lets auto-run start it).',
    mcp: true,
    params: TaskInput.extend({ workspaceId: z.string(), status: z.enum(['backlog', 'queued']).default('backlog') }),
    result: Task,
  },
  'task.update': {
    description: 'Edits a task or moves it on the board (status, order).',
    mcp: true,
    params: TaskRef.extend(TaskInput.partial().shape).extend({ status: TaskStatus.optional(), order: z.number().optional() }),
    result: Task,
  },
  'task.delete': { description: 'Deletes a task (stops its agent).', mcp: true, params: TaskRef, result: Ok },
  'task.start': {
    description: 'Starts a task now: creates/uses its sandbox and spawns the agent of the first (or current) stage.',
    mcp: true,
    params: TaskRef,
    result: Task,
  },
  'task.approve': {
    description: 'Approves a task in review: continues with the next workflow stage, or marks it done.',
    mcp: true,
    params: TaskRef,
    result: Task,
  },
  'task.reject': {
    description: 'Sends review feedback: the current agent (or a new one for the same stage) continues with it.',
    mcp: true,
    params: TaskRef.extend({ feedback: z.string().min(1) }),
    result: Task,
  },
  'task.stop': { description: 'Stops the running agent of a task and moves it back to the backlog.', mcp: true, params: TaskRef, result: Task },

  // ── environment (.env injection) ──────────────────────────────────────────
  // Admin methods (no MCP): an orchestrating agent must not read or change the secrets of other sandboxes.
  'env.get': {
    description: 'Variables defined on one level (workspace, repository or sandbox). Secret values are never returned.',
    params: EnvScopeRef,
    result: EnvScopeInfo,
  },
  'env.set': {
    description:
      'Creates or updates variables on one level. A variable without value keeps its stored value. filePath sets the .env file path inside the repository folders ("" resets it).',
    params: EnvScopeRef.extend({ vars: z.array(EnvVarInput).max(500).default([]), filePath: z.string().nullable().optional() }),
    result: EnvScopeInfo,
  },
  'env.unset': {
    description: 'Removes variables from one level.',
    params: EnvScopeRef.extend({ names: z.array(z.string()).min(1).max(500) }),
    result: EnvScopeInfo,
  },
  'env.import': {
    description: 'Imports the content of a .env file into one level. With replace, variables missing from the file are removed.',
    params: EnvScopeRef.extend({
      content: z.string().max(1_000_000),
      target: EnvTarget.optional(),
      secret: z.boolean().optional(),
      replace: z.boolean().default(false),
    }),
    result: z.object({ scope: EnvScopeInfo, imported: z.array(z.string()), errors: z.array(z.object({ line: z.number(), message: z.string() })) }),
  },
  'env.resolve': {
    description:
      'The variables a sandbox (and an agent of the given type) gets: levels merged (workspace → repository → sandbox → agent type) with the origin of every value. Values of secrets are not returned.',
    params: SandboxRef.extend({ agentKind: z.string().optional() }),
    result: ResolvedEnv,
  },
  'env.apply': {
    description: 'Writes the .env files of a running sandbox now (otherwise done when the next agent starts).',
    params: SandboxRef,
    result: z.object({ files: z.array(EnvFileStatus) }),
  },

  // ── cockpit ───────────────────────────────────────────────────────────────
  'layout.get': {
    description: 'Cockpit layout of a workspace (or the global one).',
    params: z.object({ workspaceId: z.string().optional() }).default({}),
    result: CockpitLayout.nullable(),
  },
  'layout.save': {
    description: 'Saves the cockpit layout of a workspace (or the global one).',
    params: z.object({ workspaceId: z.string().optional(), layout: CockpitLayout }),
    result: Ok,
  },
} as const satisfies Record<string, MethodDef>;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type MethodParams<M extends MethodName> = z.input<Methods[M]['params']>;
export type MethodResult<M extends MethodName> = z.infer<Methods[M]['result']>;

export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(methods, name);
}
