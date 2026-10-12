#!/usr/bin/env -S npx tsx
import { ActivityLog } from './activity.ts';
import { AgentManager } from './agents/manager.ts';
import { loadConfig } from './config.ts';
import { setFallbackLanguage, t } from './i18n.ts';
import { EgressManager } from './egress.ts';
import { EventBus } from './events.ts';
import { buildHttpServer } from './http.ts';
import { ImageService } from './images.ts';
import { Notifier } from './notifications.ts';
import { ProviderService } from './providers.ts';
import { createRpc } from './rpc.ts';
import { join } from 'node:path';
import { selectDriver } from './sandbox/select.ts';
import { SandboxManager } from './sandbox/manager.ts';
import { WorkspaceService } from './sandbox/workspace.ts';
import { SecretsService } from './secrets.ts';
import { ServiceManager } from './services/manager.ts';
import { SettingsService } from './settings.ts';
import { Store } from './store.ts';
import { TaskService } from './tasks.ts';
import { TokenService } from './tokens.ts';
import { RESTART_EXIT_CODE, UpdateService } from './updates.ts';
import { WorkspaceService as WorkspacesService } from './workspaces.ts';

const config = loadConfig();
let driver: Awaited<ReturnType<typeof selectDriver>>;
try {
  driver = await selectDriver(config.driver, { socket: config.dockerSocket, dataDir: config.dataDir });
} catch (err) {
  console.error(t('console.driverDown', { error: (err as Error).message }));
  process.exit(1);
}

// Logger is created with the HTTP server; route early logs through console until then.
let log: (msg: string, err?: unknown) => void = (msg, err) => console.error(msg, err ?? '');
const logProxy = (msg: string, err?: unknown) => log(msg, err);

const store = new Store(config.dataDir);
const bus = new EventBus();
const activity = new ActivityLog(bus);
const settings = new SettingsService(store, bus, config.seedSettings);
setFallbackLanguage(() => settings.get().general.language);
const secrets = new SecretsService(store);
const providers = new ProviderService(settings, secrets);
const tokens = new TokenService(store, config.token);
const images = new ImageService(driver, config, settings, store, bus);
const egress = new EgressManager(driver, store, settings, secrets, providers, images, bus, {
  proxyScript: join(config.imagesDir, 'egress-proxy', 'proxy.mjs'),
  processPort: config.proxyPort,
}, logProxy);
const sandboxes = new SandboxManager(settings, secrets, driver, store, bus, egress);
const workspace = new WorkspaceService(sandboxes, driver, secrets);
const services = new ServiceManager(driver, store, bus, sandboxes, egress, logProxy);
const agents = new AgentManager(settings, secrets, providers, driver, sandboxes, store, bus, egress, services, logProxy);

const notifier = new Notifier(settings, store, bus, config.publicUrl, logProxy);
const workspaces = new WorkspacesService(store, bus, activity);
const tasks = new TaskService(store, bus, settings, workspaces, sandboxes, workspace, agents, notifier, logProxy);

const updates = new UpdateService(config, driver, images, store, bus, activity, () => void shutdown(RESTART_EXIT_CODE), logProxy);

const rpc = createRpc({ driver, store, settings, secrets, providers, tokens, images, egress, activity, sandboxes, workspace, agents, workspaces, tasks, notifier, services, updates });
const app = await buildHttpServer({ config, rpc, bus, tokens, agents, workspace });
log = (msg, err) => app.log.warn({ err }, msg);

await sandboxes.reconcile();
agents.start();
tasks.startEngine();
updates.start();
await app.listen({ host: config.host, port: config.port });

const baseUrl = config.publicUrl ?? `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
const adminToken = tokens.ensureAdminToken();
console.log(`\n  ${t('console.running')}: ${baseUrl}`);
console.log(`  ${t('console.driver')}: ${driver.name}`);
if (adminToken) {
  console.log(`  ${t('console.login')}: ${baseUrl}/?token=${adminToken}`);
  console.log(`  (${t('console.tokenFile', { file: `${config.dataDir}/admin-token.txt` })})\n`);
} else console.log(`  ${t('console.envToken')}\n`);

// Background setup so the UI is usable immediately: egress network/proxy, and the sandbox image on first start.
void (async () => {
  try {
    await egress.ensure();
  } catch (err) {
    activity.add('error', 'activity.proxyFailed', { error: (err as Error).message });
  }
  // Shared services need the internal network (created by egress.ensure()).
  void services.start();
  if (driver.capabilities.images) {
    const sandboxImage = settings.get().sandbox.image;
    if (!(await images.exists(sandboxImage))) {
      if (sandboxImage !== 'cocoon/sandbox:latest') return;
      activity.add('info', 'activity.imageAutoBuild');
      if (!(await images.build('sandbox').done)) return;
    }
  }
  // The agent CLIs (Claude Code, Codex) live in a shared toolbox, installed once.
  if (!images.toolboxReady() && process.env.COCOON_TOOLBOX_AUTOINSTALL !== '0') {
    activity.add('info', 'activity.toolboxAutoInstall');
    images.build('agents');
  }
})();

// Sandboxes and agents keep running (tmux in the sandbox); the next start picks them up again.
let stopping = false;
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  agents.stop();
  tasks.stopEngine();
  updates.stop();
  await app.close();
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown(0));
