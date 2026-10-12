import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultMaxOutput, type DeniedConnection, type NetworkMode } from '@cocoon/protocol';
import type { EventBus } from './events.ts';
import { PROXY_IMAGE, type ImageService } from './images.ts';
import { authHeaderFor, providerRoute, providerUrls, translatedRoute, type ProviderService } from './providers.ts';
import { DockerDriver, ignoreStatus, INTERNAL_NETWORK, statusOf } from './sandbox/docker.ts';
import type { SandboxDriver } from './sandbox/driver.ts';
import type { SecretsService } from './secrets.ts';
import type { SettingsService } from './settings.ts';
import type { SandboxRecord, Store } from './store.ts';
import { scoped } from './instance.ts';

export const PROXY_HOST = 'cocoon-proxy';
const PROXY_CONTAINER = scoped('cocoon-egress-proxy');

/** Secrets that are never handed to sandboxes in egress mode; agents get a placeholder + base URL instead. */
export const PROXIED_SECRETS: Record<string, { route: string; upstream: string; baseUrlEnv: string; basePath: string }> = {
  ANTHROPIC_API_KEY: { route: 'anthropic', upstream: 'https://api.anthropic.com', baseUrlEnv: 'ANTHROPIC_BASE_URL', basePath: '' },
  OPENAI_API_KEY: { route: 'openai', upstream: 'https://api.openai.com', baseUrlEnv: 'OPENAI_BASE_URL', basePath: '/v1' },
};

export const placeholderFor = (proxyToken: string, secret: string) => `cocoon_${proxyToken}_${secret}`;

/** How a sandbox reaches the egress proxy. */
export interface ProxyEndpoints {
  /** HTTP(S)_PROXY value including the sandbox token as credentials. */
  forward: string;
  /** Prefix for credential-proxy routes: `${credentialBase}/<route>/...`. */
  credentialBase: string;
  noProxy: string;
}

/** Runs the egress proxy: as a container next to container sandboxes, or as a local process for bubblewrap. */
interface ProxyRunner {
  ensure(): Promise<void>;
  recreate(): Promise<void>;
  running(): Promise<boolean>;
  /** `network`: sandboxes with full internet reach the proxy differently than those on the internal network. */
  endpoints(token: string, network?: NetworkMode): ProxyEndpoints;
  /** URL under which the proxy reaches a provider base URL ("localhost" means the host). */
  reachableUrl(url: string): string;
  /** Address TCP relays bind to (the proxy's internal-network IP), if relays are supported. */
  relayBind(): string | undefined;
}

/** TCP relay in the proxy: sandboxes on the internal network reach an external server (e.g. a database). */
export interface Relay {
  listen: number;
  host: string;
  port: number;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function rewriteLocalhost(url: string, host: string): string {
  const parsed = new URL(url);
  if (LOCAL_HOSTS.has(parsed.hostname)) parsed.hostname = host;
  return parsed.toString().replace(/\/$/, '');
}

class ContainerProxyRunner implements ProxyRunner {
  /** Proxy address on the default bridge network (for sandboxes with full internet; no DNS there). */
  private bridgeIp?: string;
  /** Proxy address on the internal network (TCP relays bind here only). */
  private internalIp?: string;

  constructor(
    private readonly driver: DockerDriver,
    private readonly dir: string,
    private readonly images: ImageService,
  ) {}

  async ensure(): Promise<void> {
    const docker = this.driver.docker;
    try {
      await docker.getNetwork(INTERNAL_NETWORK).inspect();
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
      await docker.createNetwork({ Name: INTERNAL_NETWORK, Internal: true, Labels: { 'cocoon.managed': 'true' } });
    }
    if (!(await this.images.exists(PROXY_IMAGE))) {
      const ok = await this.images.build('proxy').done;
      if (!ok) throw new Error('egress proxy image build failed');
      return; // the finished build recreates the container
    }
    await this.start();
  }

  async recreate(): Promise<void> {
    await ignoreStatus(404, () => this.driver.docker.getContainer(PROXY_CONTAINER).remove({ force: true }));
    await this.start();
  }

  async running(): Promise<boolean> {
    try {
      return (await this.driver.docker.getContainer(PROXY_CONTAINER).inspect()).State.Running;
    } catch {
      return false;
    }
  }

  endpoints(token: string, network?: NetworkMode): ProxyEndpoints {
    const host = network === 'open' && this.bridgeIp ? this.bridgeIp : PROXY_HOST;
    return {
      forward: `http://cocoon:${token}@${PROXY_HOST}:3128`,
      credentialBase: `http://${host}:8080/t/${token}`,
      noProxy: `localhost,127.0.0.1,${PROXY_HOST}`,
    };
  }

  private async refreshBridgeIp(): Promise<void> {
    try {
      const networks = (await this.driver.docker.getContainer(PROXY_CONTAINER).inspect()).NetworkSettings.Networks;
      this.bridgeIp = Object.entries(networks).find(([name]) => name !== INTERNAL_NETWORK)?.[1]?.IPAddress || undefined;
      this.internalIp = networks[INTERNAL_NETWORK]?.IPAddress || undefined;
    } catch {
      this.bridgeIp = undefined;
      this.internalIp = undefined;
    }
  }

  relayBind(): string | undefined {
    return this.internalIp;
  }

  reachableUrl(url: string): string {
    return rewriteLocalhost(url, this.driver.hostAlias);
  }

  private async start(): Promise<void> {
    const docker = this.driver.docker;
    const container = docker.getContainer(PROXY_CONTAINER);
    try {
      const info = await container.inspect();
      if (!info.State.Running) await container.start();
      await this.refreshBridgeIp();
      return;
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
    const podman = this.driver.kind === 'podman';
    const created = await docker.createContainer({
      name: PROXY_CONTAINER,
      Image: PROXY_IMAGE,
      // Must be able to read the policy file (0600) and write denied.json: Docker → same uid as cocoond;
      // rootless Podman → container root, which is mapped to the user running cocoond.
      User: podman ? '0:0' : `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      Labels: { 'cocoon.managed': 'true' },
      HostConfig: {
        NetworkMode: 'bridge',
        Binds: [`${this.dir}:/policy`],
        // Providers on the server itself (e.g. Ollama on localhost) are reached via the host alias.
        ExtraHosts: podman ? undefined : ['host.docker.internal:host-gateway'],
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        Memory: 256 * 1024 * 1024,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    await docker.getNetwork(INTERNAL_NETWORK).connect({ Container: created.id, EndpointConfig: { Aliases: [PROXY_HOST] } });
    await created.start();
    await this.refreshBridgeIp();
  }
}

/** bubblewrap sandboxes share the host network: the proxy is a local process bound to 127.0.0.1. */
class ProcessProxyRunner implements ProxyRunner {
  private child?: ChildProcess;
  private stopped = false;

  constructor(
    private readonly script: string,
    private readonly dir: string,
    private readonly port: number,
    private readonly log: (msg: string, err?: unknown) => void,
  ) {
    process.once('exit', () => {
      this.stopped = true;
      this.child?.kill();
    });
  }

  async ensure(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) this.spawn();
  }

  async recreate(): Promise<void> {
    this.child?.kill();
    this.spawn();
  }

  async running(): Promise<boolean> {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  endpoints(token: string): ProxyEndpoints {
    return {
      forward: `http://cocoon:${token}@127.0.0.1:${this.port}`,
      credentialBase: `http://127.0.0.1:${this.port + 1}/t/${token}`,
      noProxy: 'localhost,127.0.0.1',
    };
  }

  reachableUrl(url: string): string {
    return url.replace(/\/$/, '');
  }

  relayBind(): undefined {
    return undefined; // bubblewrap sandboxes share the host network and need no relays
  }

  private spawn(): void {
    const child = spawn(process.execPath, [this.script], {
      env: { POLICY_DIR: this.dir, FORWARD_PORT: String(this.port), CREDENTIAL_PORT: String(this.port + 1), BIND_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => this.log(`egress proxy: ${chunk.toString().trim()}`));
    child.on('exit', (code) => {
      if (this.stopped || child !== this.child) return;
      this.log(`egress proxy exited (${code}), restarting`);
      setTimeout(() => this.spawn(), 1000);
    });
    this.child = child;
  }
}

/**
 * Runs the egress proxy and keeps its policy file (allowlist, sandboxes, credentials) in sync with settings,
 * secrets and sandboxes.
 */
export class EgressManager {
  private readonly dir: string;
  private readonly runner: ProxyRunner;
  private version = Date.now();
  private relays: () => Relay[] = () => [];

  constructor(
    driver: SandboxDriver,
    private readonly store: Store,
    private readonly settings: SettingsService,
    private readonly secrets: SecretsService,
    private readonly providers: ProviderService,
    images: ImageService,
    bus: EventBus,
    opts: { proxyScript: string; processPort: number },
    private readonly log: (msg: string, err?: unknown) => void,
  ) {
    this.dir = join(store.dataDir, 'egress');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.runner =
      driver instanceof DockerDriver
        ? new ContainerProxyRunner(driver, this.dir, images)
        : new ProcessProxyRunner(opts.proxyScript, this.dir, opts.processPort, log);
    bus.subscribe((event) => {
      if (event.type === 'sandbox.updated' || event.type === 'sandbox.deleted' || event.type === 'settings.updated') this.writePolicy();
    });
    secrets.onChange(() => this.writePolicy());
    images.onFinished((kind, ok) => {
      if (kind === 'proxy' && ok) void this.runner.recreate().catch((err) => this.log('egress proxy restart failed', err));
    });
  }

  async ensure(): Promise<void> {
    this.writePolicy();
    await this.runner.ensure();
  }

  running(): Promise<boolean> {
    return this.runner.running();
  }

  /** Environment for a sandbox in egress mode (set when the sandbox is created). */
  sandboxEnv(record: Pick<SandboxRecord, 'proxyToken'>): Record<string, string> {
    const { forward, noProxy } = this.runner.endpoints(record.proxyToken);
    return {
      HTTP_PROXY: forward, HTTPS_PROXY: forward, http_proxy: forward, https_proxy: forward,
      NO_PROXY: noProxy, no_proxy: noProxy,
    };
  }

  /** NO_PROXY value for a sandbox, plus extra hosts (shared services are reached directly, not via the proxy). */
  noProxy(record: Pick<SandboxRecord, 'proxyToken'>, extraHosts: string[] = []): string {
    return [...new Set([...this.runner.endpoints(record.proxyToken).noProxy.split(','), ...extraHosts])].join(',');
  }

  /** Base URL of a credential-proxy route for this sandbox. */
  credentialUrl(record: Pick<SandboxRecord, 'proxyToken' | 'network'>, route: string): string {
    return `${this.runner.endpoints(record.proxyToken, record.network).credentialBase}/${route}`;
  }

  /** Supplies the TCP relays for the policy (shared services on external servers). */
  setRelaySource(source: () => Relay[]): void {
    this.relays = source;
    this.writePolicy();
  }

  /** Host under which the proxy reaches a server address ("localhost" means the CoCoon server). */
  reachableHost(host: string): string {
    return new URL(this.runner.reachableUrl(`tcp://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}`)).hostname;
  }

  /** Whether the proxy can relay TCP connections (container drivers, once the proxy runs). */
  relaysSupported(): boolean {
    return Boolean(this.runner.relayBind());
  }

  denied(): DeniedConnection[] {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'denied.json'), 'utf8')) as DeniedConnection[];
    } catch {
      return [];
    }
  }

  writePolicy(): void {
    const settings = this.settings.get();
    type Entry = { sandboxId: string; token: string; routes: string[] };
    const sandboxes: Record<string, Entry> = {};
    const tokens: Record<string, Entry> = {};
    for (const sb of this.store.sandboxes()) {
      if (sb.network === 'none' || (sb.status !== 'running' && sb.status !== 'creating')) continue;
      const entry = { sandboxId: sb.id, token: sb.proxyToken, routes: sb.grants ?? [] };
      // Credential routes work for every sandbox with network access (identified by token);
      // the forward proxy (by IP) only matters for "restricted" sandboxes on the internal network.
      tokens[sb.proxyToken] = entry;
      if (sb.ip && sb.network === 'egress') sandboxes[sb.ip] = entry;
    }
    type Route = {
      upstream: string;
      secrets: Record<string, string>;
      inject?: { header: string; value: string };
      /** Translate requests in this API style to the upstream's Chat Completions endpoint. */
      translate?: { from: 'messages' | 'responses'; chatPath: string; maxTokens?: Record<string, number> };
    };
    const routes: Record<string, Route> = {};
    if (settings.egress.credentialProxy) {
      for (const [name, def] of Object.entries(PROXIED_SECRETS)) {
        const value = this.secrets.resolve(name);
        if (value) routes[def.route] = { upstream: def.upstream, secrets: { [name]: value } };
      }
      for (const [id, provider] of Object.entries(this.providers.all())) {
        const key = this.providers.key(provider);
        const header = key ? authHeaderFor(provider, key) : undefined;
        const secrets = key && provider.secret ? { [provider.secret]: key } : {};
        const inject = header && { header: header.name, value: header.value };
        if (provider.kind === 'http') {
          routes[providerRoute(id)] = { upstream: this.runner.reachableUrl(provider.baseUrl), secrets, inject };
          continue;
        }
        // Model providers: the route forwards to the API root; agents add /v1/... themselves.
        const { root, v1Suffix } = providerUrls(provider);
        const upstream = this.runner.reachableUrl(root);
        routes[providerRoute(id)] = { upstream, secrets, inject };
        // Answer-length caps per model, so a translated request never asks for more than the model can return.
        const maxTokens = Object.fromEntries(
          Object.entries(provider.modelInfo ?? {})
            .map(([model, info]) => [model, info.maxOutputTokens ?? (info.contextWindow ? defaultMaxOutput(info.contextWindow) : undefined)] as const)
            .filter((entry): entry is readonly [string, number] => entry[1] !== undefined),
        );
        for (const from of ['messages', 'responses'] as const) {
          routes[translatedRoute(id, from)] = { upstream, secrets, inject, translate: { from, chatPath: `${v1Suffix}/chat/completions`, maxTokens } };
        }
      }
    }
    // Provider hosts are always reachable (needed when the credential proxy is off).
    const providerHosts = Object.values(this.providers.all()).map((p) => new URL(this.runner.reachableUrl(p.baseUrl)).hostname);
    const allowlist = [...new Set([...settings.egress.allowlist, ...providerHosts])];
    const file = join(this.dir, 'policy.json');
    this.version++;
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: this.version, allowlist, sandboxes, tokens, routes, relays: this.relays(), relayBind: this.runner.relayBind() }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  /** Resolves once the proxy has loaded the latest policy (or after a timeout). */
  async awaitPolicy(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (Number(readFileSync(join(this.dir, 'ack'), 'utf8')) >= this.version) return;
      } catch {
        // proxy not up yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.log('egress proxy did not confirm the policy in time');
  }
}
