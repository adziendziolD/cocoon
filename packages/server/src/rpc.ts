import { z } from 'zod';
import { isMethodName, methods, type MethodName, type MethodResult, type Methods, type SetupStep } from '@cocoon/protocol';
import type { ActivityLog } from './activity.ts';
import type { AgentManager } from './agents/manager.ts';
import type { EnvService } from './env.ts';
import type { EgressManager } from './egress.ts';
import { CocoonError } from './errors.ts';
import type { IssueService } from './github-issues.ts';
import type { ImageService } from './images.ts';
import type { SandboxDriver } from './sandbox/driver.ts';
import type { SandboxManager } from './sandbox/manager.ts';
import type { ServiceManager } from './services/manager.ts';
import type { WorkspaceService } from './sandbox/workspace.ts';
import type { Notifier } from './notifications.ts';
import type { ProviderService } from './providers.ts';
import type { SecretsService } from './secrets.ts';
import type { SettingsService } from './settings.ts';
import type { Store } from './store.ts';
import type { ScheduleService } from './schedules.ts';
import type { TaskService } from './tasks.ts';
import type { TokenService } from './tokens.ts';
import type { WorkspaceService as WorkspacesService } from './workspaces.ts';
import type { UpdateService } from './updates.ts';
import type { PortService } from './ports.ts';
import { currentLanguage, t } from './i18n.ts';
import { STARTED_AT, VERSION } from './version.ts';

type Handlers = {
  [M in MethodName]: (params: z.output<Methods[M]['params']>) => Promise<MethodResult<M>>;
};

export interface RpcContext {
  driver: SandboxDriver;
  store: Store;
  settings: SettingsService;
  secrets: SecretsService;
  providers: ProviderService;
  tokens: TokenService;
  images: ImageService;
  egress: EgressManager;
  activity: ActivityLog;
  sandboxes: SandboxManager;
  workspace: WorkspaceService;
  agents: AgentManager;
  workspaces: WorkspacesService;
  tasks: TaskService;
  notifier: Notifier;
  services: ServiceManager;
  updates: UpdateService;
  ports: PortService;
  envs: EnvService;
  issues: IssueService;
  schedules: ScheduleService;
}

const CREDENTIAL_SECRETS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];

export function createRpc(ctx: RpcContext) {
  const { driver, store, settings, secrets, providers, tokens, images, egress, activity, sandboxes, workspace, agents, workspaces, tasks, notifier, services, updates, ports, envs, issues, schedules } = ctx;
  const ok = { ok: true as const };

  const handlers: Handlers = {
    'system.info': async () => {
      const info = await driver.info();
      return {
        version: VERSION,
        driver: driver.name,
        driverKind: driver.kind,
        capabilities: driver.capabilities,
        dockerVersion: info.version,
        runtimes: info.runtimes,
        agentKinds: agents.kinds(),
        sandboxes: sandboxes.list().length,
        agents: agents.list().filter((a) => a.status !== 'exited').length,
        proxyRunning: await egress.running(),
        commit: updates.commit(),
        startedAt: STARTED_AT,
        ports: { enabled: ports.enabled, share: ports.shareEnabled },
      };
    },
    'system.setup_status': async () => {
      const [info, imageInfo, proxyRunning] = await Promise.all([
        driver.info().catch(() => undefined),
        images.status(),
        egress.running(),
      ]);
      const sandboxImage = imageInfo.find((i) => i.kind === 'sandbox');
      const toolbox = imageInfo.find((i) => i.kind === 'agents');
      const imageReady = !driver.capabilities.images || Boolean(sandboxImage?.exists);
      const building = Boolean(sandboxImage?.building || toolbox?.building);
      const credentials = [
        ...CREDENTIAL_SECRETS.filter((name) => secrets.resolve(name)),
        ...Object.entries(providers.all())
          .filter(([, p]) => p.kind !== 'http' && (p.auth === 'none' || providers.key(p)))
          .map(([, p]) => p.label),
      ];
      const steps: SetupStep[] = [
        { id: 'docker', title: t('setup.docker', { name: driver.name }), done: Boolean(info), detail: info?.version && `${driver.name} ${info.version}` },
        {
          id: 'image',
          title: t('setup.image'),
          done: imageReady && Boolean(toolbox?.exists),
          detail: building
            ? t('setup.imageBuilding')
            : !imageReady
              ? sandboxImage?.ref
              : toolbox?.exists
                ? [sandboxImage?.ref, toolbox.tools?.join(', ')].filter(Boolean).join(' · ')
                : t('setup.toolboxMissing'),
        },
        { id: 'proxy', title: t('setup.proxy'), done: proxyRunning },
        {
          id: 'credentials',
          title: t('setup.credentials'),
          done: credentials.length > 0,
          detail: credentials.length ? credentials.join(', ') : t('setup.credentialsHint'),
        },
        { id: 'sandbox', title: t('setup.sandbox'), done: store.sandboxes().length > 0 },
        { id: 'agent', title: t('setup.agent'), done: store.agents().length > 0 },
      ];
      return { complete: steps.every((s) => s.done), steps };
    },
    'activity.list': async (p) => activity.list(p.limit, currentLanguage()),

    'image.status': () => images.status(),
    'image.build': async (p) => ({ buildId: images.build(p.kind, { variant: p.variant, tools: p.tools }).buildId }),

    'ports.list': async (p) => ports.list(p.sandboxId),
    'ports.open': (p) => ports.open(p.sandboxId, p.port, p.mode, p.name),
    'ports.close': async (p) => (await ports.close(p.sandboxId, p.port), ok),
    'ports.preview_link': async (p) => ports.previewLink(p.sandboxId, p.port, p.origin),

    'update.status': (p) => updates.status(p.refresh),
    'update.apply': async (p) => ({ targets: await updates.apply(p.targets) }),
    'system.restart': async () => (updates.restart(), ok),

    'settings.get': async () => settings.get(),
    'settings.update': async (p) => settings.update(p),
    'settings.reset': async (p) => settings.reset(p.section),
    'secrets.list': async () => secrets.list(),
    'secrets.set': async (p) => {
      const info = secrets.set(p.name, p.value);
      activity.add('info', 'activity.secretSaved', { name: p.name });
      return info;
    },
    'secrets.delete': async (p) => {
      secrets.delete(p.name);
      activity.add('info', 'activity.secretDeleted', { name: p.name });
      return ok;
    },
    'tokens.list': async () => tokens.list(),
    'tokens.create': async (p) => {
      const created = tokens.create(p.name);
      activity.add('info', 'activity.tokenCreated', { name: p.name });
      return created;
    },
    'tokens.revoke': async (p) => (tokens.revoke(p.id), ok),
    'providers.test': (p) => ('id' in p ? providers.testAndRemember(p.id) : providers.test(p.provider)),
    'models.list': async (p) => providers.defaultModels(p.adapter),
    'egress.denied': async () => egress.denied(),
    'notifications.test': (p) => notifier.test(p.webhookUrl),

    'sandbox.create': (p) => sandboxes.create(p),
    'sandbox.list': async () => sandboxes.list(),
    'sandbox.get': async (p) => sandboxes.get(p.sandboxId),
    'sandbox.update': async (p) => sandboxes.rename(p),
    'sandbox.start': (p) => sandboxes.start(p.sandboxId),
    'sandbox.stop': (p) => sandboxes.stop(p.sandboxId),
    'sandbox.delete': async (p) => (await sandboxes.delete(p.sandboxId), ok),
    'sandbox.exec': (p) => sandboxes.exec(p.sandboxId, p.command, { timeoutMs: p.timeoutMs, env: envs.injectedEnv(sandboxes.record(p.sandboxId)) }),
    'sandbox.diff': (p) => workspace.diff(p.sandboxId, p.repo),
    'sandbox.apply_patch': (p) => workspace.applyPatch(p.sandboxId, p.patch, p.repo),
    'sandbox.add_repo': async (p) => {
      const sandbox = await sandboxes.addRepo(p);
      await envs.applyFiles(p.sandboxId).catch(() => undefined); // the new repository's own variables
      return sandbox;
    },
    'sandbox.remove_repo': (p) => sandboxes.removeRepo(p.sandboxId, p.repo),

    'files.list': (p) => workspace.list(p.sandboxId, p.path),
    'files.read': (p) => workspace.read(p.sandboxId, p.path, p.maxBytes),
    'files.write': async (p) => (await workspace.write(p), ok),
    'files.mkdir': async (p) => (await workspace.mkdir(p.sandboxId, p.path), ok),
    'files.delete': async (p) => (await workspace.delete(p.sandboxId, p.path), ok),

    'git.repos': (p) => workspace.repos(p.sandboxId),
    'git.status': (p) => workspace.gitStatus(p.sandboxId, p.repo),
    'git.commit': async (p) => ({ sha: await workspace.commit(p.sandboxId, p.message, p.repo) }),
    'git.push': (p) => workspace.push(p.sandboxId, p.branch, p.repo),
    'git.create_pr': (p) => workspace.createPullRequest(p),

    'agent.spawn': (p) => agents.spawn(p),
    'agent.list': async (p) => agents.list(p.sandboxId),
    'agent.get': async (p) => agents.get(p.agentId),
    'agent.send_input': async (p) => (await agents.sendInput(p), ok),
    'agent.send_keys': async (p) => (await agents.sendKeys(p.agentId, p.keys), ok),
    'agent.read': async (p) => ({ text: await agents.read(p.agentId, p.lines) }),
    'agent.wait': (p) => agents.wait(p),
    'agent.kill': async (p) => (await agents.kill(p.agentId), ok),
    'agent.switch': (p) => agents.switchAgent(p, (previous, next) => tasks.adoptAgent(previous.id, next)),

    'workspace.list': async () => workspaces.list(),
    'workspace.get': async (p) => workspaces.get(p.workspaceId),
    'workspace.create': async (p) => workspaces.create(p),
    'workspace.update': async (p) => workspaces.update(p),
    'workspace.delete': async (p) => {
      tasks.stopWorkspace(p.workspaceId);
      const sandboxIds = workspaces.remove(p.workspaceId);
      for (const sandboxId of sandboxIds) {
        if (p.deleteSandboxes) await sandboxes.delete(sandboxId);
        else sandboxes.rename({ sandboxId, workspaceId: null });
      }
      return ok;
    },

    'task.list': async (p) => tasks.list(p.workspaceId),
    'task.get': async (p) => tasks.get(p.taskId),
    'task.create': async (p) => tasks.create(p),
    'task.update': async (p) => tasks.update(p),
    'github.issues': async (p) => issues.list(p),
    'github.import_issues': async (p) => issues.import(p),
    'task.delete': async (p) => (await tasks.delete(p.taskId), ok),
    'task.start': async (p) => tasks.start(p.taskId),
    'task.approve': async (p) => tasks.approve(p.taskId),
    'task.reject': (p) => tasks.reject(p.taskId, p.feedback),
    'task.mark_finished': async (p) => tasks.markFinished(p.taskId),
    'task.stop': async (p) => tasks.stop(p.taskId),

    'schedule.list': async (p) => schedules.list(p.workspaceId),
    'schedule.get': async (p) => schedules.get(p.scheduleId),
    'schedule.create': async (p) => schedules.create(p),
    'schedule.update': async (p) => schedules.update(p),
    'schedule.delete': async (p) => (await schedules.delete(p.scheduleId, p.deleteTasks), ok),
    'schedule.run': (p) => schedules.run(p.scheduleId, p.force),
    'schedule.preview': async (p) => schedules.preview(p.cron, p.timezone, p.count),

    'services.list': async () => services.list(),
    'services.add': (p) => services.add(p),
    'services.update': (p) => services.update(p),
    'services.remove': async (p) => (await services.remove(p.serviceId, p.deleteData), ok),
    'services.start': (p) => services.startService(p.serviceId),
    'services.stop': (p) => services.stopService(p.serviceId),
    'services.test': (p) => services.check(p.serviceId),
    'services.credentials': async (p) => services.credentials(p.serviceId),
    'services.connections': async (p) => services.connections(p.sandboxId),
    'services.attach': (p) => services.attach(p.sandboxId, p.serviceId),
    'services.detach': async (p) => (await services.detach(p.sandboxId, p.serviceId), ok),
    'services.reset': (p) => services.reset(p.sandboxId, p.serviceId),

    'env.get': async (p) => envs.get(p),
    'env.set': async (p) => envs.set(p, p.vars, p.filePath),
    'env.unset': async (p) => envs.unset(p, p.names),
    'env.import': async (p) => envs.import(p),
    'env.resolve': async (p) => envs.resolve(p.sandboxId, p.agentKind),
    'env.apply': async (p) => ({ files: await envs.applyFiles(p.sandboxId) }),

    'layout.get': async (p) => store.layout(p.workspaceId ?? '_global') ?? null,
    'layout.save': async (p) => (store.putLayout(p.workspaceId ?? '_global', { ...p.layout, updatedAt: new Date().toISOString() }), ok),
  };

  return async function call(method: string, rawParams: unknown): Promise<unknown> {
    if (!isMethodName(method)) throw new CocoonError('not_found', t('error.unknownMethod', { method }));
    const schema: z.ZodType = methods[method].params;
    const parsed = schema.safeParse(rawParams ?? {});
    if (!parsed.success) throw new CocoonError('bad_request', t('error.invalidParams', { details: z.prettifyError(parsed.error) }), z.treeifyError(parsed.error));
    const handler = handlers[method] as (params: unknown) => Promise<unknown>;
    return handler(parsed.data);
  };
}

export type Rpc = ReturnType<typeof createRpc>;
