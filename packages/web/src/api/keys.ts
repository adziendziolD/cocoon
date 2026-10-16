/** Central react-query keys so event handlers and hooks agree on cache entries. */
export const qk = {
  info: ['system.info'] as const,
  setup: ['system.setup_status'] as const,
  activity: ['activity'] as const,
  images: ['images'] as const,
  updates: ['update.status'] as const,
  ports: (sandboxId: string) => ['ports', sandboxId] as const,
  settings: ['settings'] as const,
  secrets: ['secrets'] as const,
  defaultModels: (adapter: string) => ['models.list', adapter] as const,
  tokens: ['tokens'] as const,
  denied: ['egress.denied'] as const,
  sandboxes: ['sandboxes'] as const,
  sandbox: (id: string) => ['sandbox', id] as const,
  agents: ['agents'] as const,
  agent: (id: string) => ['agent', id] as const,
  files: (sandboxId: string, path: string) => ['files', sandboxId, path] as const,
  filesAll: (sandboxId: string) => ['files', sandboxId] as const,
  file: (sandboxId: string, path: string) => ['file', sandboxId, path] as const,
  /** Prefix of all git queries of a sandbox (status per repository and the repository overview). */
  git: (sandboxId: string) => ['git', sandboxId] as const,
  /** git.status of one repository (undefined = the only repository). */
  gitStatus: (sandboxId: string, repo?: string) => ['git', sandboxId, 'status', repo ?? null] as const,
  gitRepos: (sandboxId: string) => ['git', sandboxId, 'repos'] as const,
  /** Prefix of all diffs of a sandbox. */
  diff: (sandboxId: string) => ['diff', sandboxId] as const,
  /** sandbox.diff of one repository (undefined = the only one, or the combined patch of all). */
  diffOf: (sandboxId: string, repo?: string) => ['diff', sandboxId, repo ?? null] as const,
  services: ['services'] as const,
  serviceConnectionsAll: ['service.connections'] as const,
  serviceConnections: (sandboxId: string) => ['service.connections', sandboxId] as const,
  serviceCredentials: (serviceId: string) => ['service.credentials', serviceId] as const,
  /** Prefix of all environment queries (levels and merged views). */
  envAll: ['env'] as const,
  envScope: (scope: string, id: string) => ['env', 'scope', scope, id] as const,
  envResolved: (sandboxId: string) => ['env', 'resolved', sandboxId] as const,
  workspaces: ['workspaces'] as const,
  workspace: (id: string) => ['workspace', id] as const,
  /** All tasks of all workspaces; views filter client-side (like agents). */
  tasks: ['tasks'] as const,
  githubIssues: (workspaceId: string) => ['github.issues', workspaceId] as const,
  task: (id: string) => ['task', id] as const,
  /** All scheduled agents; views filter by workspace client-side. */
  schedules: ['schedules'] as const,
  /** Cockpit layout of a workspace; '' = the global layout. */
  layout: (workspaceId: string) => ['layout', workspaceId] as const,
};
