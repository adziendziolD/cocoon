import type { CocoonEvent, MethodName, SecretInfo, Settings, UserRole } from '@cocoon/protocol';
import type { Principal } from './principal.ts';

/**
 * admin: sees and changes how CoCoon itself is set up (credentials, settings, services, users, updates).
 * member: works with it: sandboxes, agents, tasks, files, git. Members cannot read or change the stored credentials
 * through the API. What reaches a sandbox (the GitHub token, and unless COCOON_PROXY_EXTRA_SECRETS=1 the Claude
 * subscription token and the Gemini key) can still be read from a terminal there, and a member has one.
 */
export type Access = 'admin' | 'member';

/**
 * Who may call which method. Complete on purpose: a method added to the registry without an entry here does not
 * compile, so no method becomes available to members by accident.
 */
export const METHOD_ACCESS: Record<MethodName, Access> = {
  // system
  'system.info': 'member',
  'system.setup_status': 'member',
  'activity.list': 'member',
  'image.status': 'member',
  'image.build': 'admin',
  'update.status': 'admin',
  'update.apply': 'admin',
  'system.restart': 'admin',

  // ports
  'ports.list': 'member',
  'ports.open': 'member',
  'ports.close': 'member',
  'ports.preview_link': 'member',

  // settings, credentials, access. Members read settings and the list of credential names to fill in forms; both are
  // reduced for them (see redactResult). Some parameters of open methods are admin-only (see mayUseParams).
  'settings.get': 'member',
  'settings.update': 'admin',
  'settings.reset': 'admin',
  'secrets.list': 'member',
  'secrets.set': 'admin',
  'secrets.delete': 'admin',
  'tokens.list': 'admin',
  'tokens.create': 'admin',
  'tokens.revoke': 'admin',
  'providers.test': 'admin',
  'models.list': 'member',
  'notifications.test': 'admin',
  'egress.denied': 'admin',

  // own account
  'auth.me': 'member',
  'auth.logout': 'member',
  'auth.change_password': 'member',

  // users
  'users.list': 'admin',
  'users.create': 'admin',
  'users.update': 'admin',
  'users.reset_password': 'admin',
  'users.delete': 'admin',

  // shared services: members attach them to their sandboxes, admins run them
  'services.list': 'member',
  'services.add': 'admin',
  'services.update': 'admin',
  'services.remove': 'admin',
  'services.start': 'admin',
  'services.stop': 'admin',
  'services.test': 'admin',
  'services.credentials': 'admin',
  'services.connections': 'member',
  'services.attach': 'member',
  'services.detach': 'member',
  'services.reset': 'member',

  // sandboxes, files, git
  'sandbox.create': 'member',
  'sandbox.list': 'member',
  'sandbox.get': 'member',
  'sandbox.update': 'member',
  'sandbox.start': 'member',
  'sandbox.stop': 'member',
  'sandbox.delete': 'member',
  'sandbox.exec': 'member',
  'sandbox.diff': 'member',
  'sandbox.apply_patch': 'member',
  'sandbox.add_repo': 'member',
  'sandbox.remove_repo': 'member',
  'files.list': 'member',
  'files.read': 'member',
  'files.write': 'member',
  'files.mkdir': 'member',
  'files.delete': 'member',
  'git.repos': 'member',
  'git.status': 'member',
  'git.commit': 'member',
  'git.push': 'member',
  'git.create_pr': 'member',

  // agents
  'agent.spawn': 'member',
  'agent.list': 'member',
  'agent.get': 'member',
  'agent.send_input': 'member',
  'agent.send_keys': 'member',
  'agent.read': 'member',
  'agent.wait': 'member',
  'agent.kill': 'member',
  'agent.switch': 'member',

  // workspaces, tasks, schedules
  'workspace.list': 'member',
  'workspace.get': 'member',
  'workspace.create': 'member',
  'workspace.update': 'member',
  'workspace.delete': 'member',
  'task.list': 'member',
  'task.get': 'member',
  'task.create': 'member',
  'task.update': 'member',
  'task.delete': 'member',
  'task.start': 'member',
  'task.approve': 'member',
  'task.reject': 'member',
  'task.mark_finished': 'member',
  'task.stop': 'member',
  'github.issues': 'member',
  'github.import_issues': 'member',
  'schedule.list': 'member',
  'schedule.get': 'member',
  'schedule.create': 'member',
  'schedule.update': 'member',
  'schedule.delete': 'member',
  'schedule.run': 'member',
  'schedule.preview': 'member',

  // environment variables (secret values are never returned), cockpit
  'env.get': 'member',
  'env.set': 'member',
  'env.unset': 'member',
  'env.import': 'member',
  'env.resolve': 'member',
  'env.apply': 'member',
  'layout.get': 'member',
  'layout.save': 'member',
};

export const mayCall = (role: UserRole, method: MethodName): boolean => role === 'admin' || METHOD_ACCESS[method] === 'member';

/**
 * Parameters only admins may set, although the method is open to members. The name of a GitHub token chooses which stored
 * token a sandbox gets, and a member can read what reaches their sandbox, so members stay with the default token (or the one
 * an admin set on the workspace).
 */
export function mayUseParams(role: UserRole, method: MethodName, params: unknown): boolean {
  if (role === 'admin') return true;
  if (method !== 'sandbox.create' && method !== 'sandbox.update' && method !== 'workspace.create' && method !== 'workspace.update') return true;
  const token = (params as { githubToken?: string | null } | undefined)?.githubToken;
  return token === undefined || token === null || token === DEFAULT_GITHUB_TOKEN;
}

const DEFAULT_GITHUB_TOKEN = 'GITHUB_TOKEN';

/** The address of a provider without credentials in it (user:password@ or a key in the query). */
const bareUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
};

/**
 * Settings as members see them. Everything stays except what works as a credential: the webhook URL (a password for the
 * channel behind it), the values of agent environment variables (the names stay) and credentials inside provider URLs.
 * Members never write settings, so what is hidden here cannot be overwritten with the hidden version.
 */
export const redactSettings = (settings: Settings): Settings => ({
  ...settings,
  notifications: { ...settings.notifications, webhookUrl: undefined },
  agents: Object.fromEntries(
    Object.entries(settings.agents).map(([id, profile]) => [id, { ...profile, env: Object.fromEntries(Object.keys(profile.env).map((name) => [name, ''])) }]),
  ),
  providers: Object.fromEntries(Object.entries(settings.providers).map(([id, provider]) => [id, { ...provider, baseUrl: bareUrl(provider.baseUrl) }])),
});

/** Members get the names of the stored credentials (to pick one in a form), not their masked values. */
const redactSecrets = (secrets: SecretInfo[]): SecretInfo[] => secrets.map(({ name, set, source }) => ({ name, set, source }));

/** The result of a method as the caller may see it. */
export function redactResult(method: MethodName, result: unknown, caller: Principal): unknown {
  if (caller.role === 'admin') return result;
  switch (method) {
    case 'secrets.list':
      return redactSecrets(result as SecretInfo[]);
    case 'settings.get':
      return redactSettings(result as Settings);
    default:
      return result;
  }
}

/** An event as the caller may see it: undefined hides it (administration), settings lose the webhook URL. */
export function eventFor(event: CocoonEvent, caller: Principal): CocoonEvent | undefined {
  if (caller.role === 'admin') return event;
  switch (event.type) {
    case 'update.progress':
    case 'update.status':
    case 'image.build':
      return undefined;
    case 'settings.updated':
      return { ...event, settings: redactSettings(event.settings) };
    default:
      return event;
  }
}
