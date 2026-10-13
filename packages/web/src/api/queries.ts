import { useQuery } from '@tanstack/react-query';
import type { AgentAdapter } from '@cocoon/protocol';
import { qk } from './keys';
import { isNotFound, rpc } from './rpc';

/** Read hooks. Live updates come from the event socket (see events.ts), so polling is rarely needed. */

export const useSystemInfo = () => useQuery({ queryKey: qk.info, queryFn: () => rpc('system.info'), staleTime: 30_000 });

export const useSetupStatus = () =>
  useQuery({ queryKey: qk.setup, queryFn: () => rpc('system.setup_status'), refetchInterval: (q) => (q.state.data?.complete ? false : 15_000) });

export const useActivity = () => useQuery({ queryKey: qk.activity, queryFn: () => rpc('activity.list', { limit: 300 }) });

export const useImages = () =>
  useQuery({
    queryKey: qk.images,
    queryFn: () => rpc('image.status'),
    refetchInterval: (q) => (q.state.data?.some((i) => i.building) ? 5000 : false),
  });

/** Detected and opened ports of a sandbox; live via the ports.updated event. */
export const useSandboxPorts = (sandboxId: string, enabled = true) =>
  useQuery({ queryKey: qk.ports(sandboxId), queryFn: () => rpc('ports.list', { sandboxId }), enabled });

/** Update status; the server checks the remotes itself (daily), refresh via rpc('update.status', { refresh: true }). */
export const useUpdateStatus = () =>
  useQuery({
    queryKey: qk.updates,
    queryFn: () => rpc('update.status', {}),
    staleTime: 5 * 60_000,
    refetchInterval: (q) => (q.state.data?.running ? 10_000 : false),
  });

export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: () => rpc('settings.get') });
export const useSecrets = () => useQuery({ queryKey: qk.secrets, queryFn: () => rpc('secrets.list') });
/** Models an agent CLI offers with its default credentials (vendor listing); empty while loading or if unknown. */
export const useDefaultModels = (adapter: AgentAdapter | undefined, enabled = true) =>
  useQuery({
    queryKey: qk.defaultModels(adapter ?? ''),
    queryFn: () => rpc('models.list', { adapter: adapter! }),
    enabled: enabled && !!adapter,
    staleTime: 5 * 60_000,
    retry: false,
  });
export const useTokens = () => useQuery({ queryKey: qk.tokens, queryFn: () => rpc('tokens.list') });
export const useDenied = () => useQuery({ queryKey: qk.denied, queryFn: () => rpc('egress.denied'), refetchInterval: 10_000 });

export const useSandboxes = () => useQuery({ queryKey: qk.sandboxes, queryFn: () => rpc('sandbox.list') });

export const useSandbox = (sandboxId: string) =>
  useQuery({
    queryKey: qk.sandbox(sandboxId),
    queryFn: () => rpc('sandbox.get', { sandboxId }),
    retry: (n, err) => !isNotFound(err) && n < 2,
  });

/** All agents across sandboxes; per-sandbox views filter this list client-side. */
export const useAgents = () => useQuery({ queryKey: qk.agents, queryFn: () => rpc('agent.list', {}) });

export const useAgent = (agentId: string) =>
  useQuery({
    queryKey: qk.agent(agentId),
    queryFn: () => rpc('agent.get', { agentId }),
    retry: (n, err) => !isNotFound(err) && n < 2,
  });

export const useFiles = (sandboxId: string, path: string, enabled = true) =>
  useQuery({ queryKey: qk.files(sandboxId, path), queryFn: () => rpc('files.list', { sandboxId, path }), enabled });

export const useFile = (sandboxId: string, path: string | null) =>
  useQuery({
    queryKey: qk.file(sandboxId, path ?? ''),
    queryFn: () => rpc('files.read', { sandboxId, path: path! }),
    enabled: !!path,
    // Fresh on open, but never refetched while the user may be editing.
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

/** git.status of one repository; `repo` is required by the server when the sandbox has several. */
export const useGitStatus = (sandboxId: string, repo?: string, enabled = true) =>
  useQuery({ queryKey: qk.gitStatus(sandboxId, repo), queryFn: () => rpc('git.status', { sandboxId, repo }), enabled, retry: false });

/** Overview of all repositories of a sandbox (folder, branch, number of changes, pushed branch). */
export const useGitRepos = (sandboxId: string, enabled = true) =>
  useQuery({ queryKey: qk.gitRepos(sandboxId), queryFn: () => rpc('git.repos', { sandboxId }), enabled, retry: false });

/** Patch of one repository, or (several repositories, no `repo`) the combined patch with folder-prefixed paths. */
export const useDiff = (sandboxId: string, repo?: string, enabled = true) =>
  useQuery({ queryKey: qk.diffOf(sandboxId, repo), queryFn: () => rpc('sandbox.diff', { sandboxId, repo }), enabled, retry: false });

export const useWorkspaces = () => useQuery({ queryKey: qk.workspaces, queryFn: () => rpc('workspace.list') });

/** All tasks across workspaces; boards filter this list client-side. */
export const useTasks = () => useQuery({ queryKey: qk.tasks, queryFn: () => rpc('task.list', {}) });

export const useTask = (taskId: string | null) =>
  useQuery({
    queryKey: qk.task(taskId ?? ''),
    queryFn: () => rpc('task.get', { taskId: taskId! }),
    enabled: !!taskId,
    retry: (n, err) => !isNotFound(err) && n < 2,
  });

/** Saved cockpit layout ('' = global). Never refetched in the background: the cockpit owns the layout once loaded. */
export const useCockpitLayout = (workspaceId: string) =>
  useQuery({
    queryKey: qk.layout(workspaceId),
    queryFn: () => rpc('layout.get', workspaceId ? { workspaceId } : {}),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

export const useServices = () => useQuery({ queryKey: qk.services, queryFn: () => rpc('services.list') });

export const useServiceConnections = (sandboxId: string, enabled = true) =>
  useQuery({ queryKey: qk.serviceConnections(sandboxId), queryFn: () => rpc('services.connections', { sandboxId }), enabled });
