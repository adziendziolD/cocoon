import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EgressManager } from './egress.ts';
import { EventBus } from './events.ts';
import { SecretsService } from './secrets.ts';
import { SettingsService } from './settings.ts';
import { Store, type SandboxRecord } from './store.ts';
import type { ImageService } from './images.ts';
import type { ProviderService } from './providers.ts';
import type { SandboxDriver } from './sandbox/driver.ts';
import { DockerDriver } from './sandbox/docker.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-egress-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(credentialProxy = true) {
  const store = new Store(dir);
  const bus = new EventBus();
  const settings = new SettingsService(store, bus, { egress: { credentialProxy } });
  const record = (id: string, token: string): SandboxRecord =>
    ({ id, name: id, image: 'i', status: 'running', network: 'egress', runtime: null, resources: {}, repos: [], workdir: '/workspace', createdAt: '', proxyToken: token, ip: `10.0.0.${id.length}`, grants: ['anthropic'], services: [] }) as SandboxRecord;
  store.putSandbox(record('sb_a', 'aaaa'));
  store.putSandbox(record('sb_bb', 'bbbb'));
  const egress = new EgressManager(
    {} as SandboxDriver, store, settings, new SecretsService(store), { all: () => ({}) } as unknown as ProviderService,
    { onFinished() {} } as unknown as ImageService, bus, { proxyScript: 'x', processPort: 0 }, () => undefined,
  );
  const policy = () => JSON.parse(readFileSync(join(dir, 'egress', 'policy.json'), 'utf8')) as { tokens: Record<string, { routes: string[] }>; routes: Record<string, { upstream: string; secrets: Record<string, string> }> };
  return { egress, policy };
}

describe('policy with environment routes', () => {
  it('grants an env route only to its own sandbox and keeps existing grants', () => {
    const { egress, policy } = setup();
    egress.setEnvRoutes((id) => (id === 'sb_a' ? [{ name: 'env-sb_a-api.stripe.com', upstream: 'https://api.stripe.com', secrets: { STRIPE_API_KEY: 'real' } }] : []));
    const p = policy();
    expect(p.routes['env-sb_a-api.stripe.com']).toEqual({ upstream: 'https://api.stripe.com', secrets: { STRIPE_API_KEY: 'real' } });
    expect(p.tokens.aaaa!.routes).toEqual(['anthropic', 'env-sb_a-api.stripe.com']);
    expect(p.tokens.bbbb!.routes).toEqual(['anthropic']);
  });

  it('adds no env routes when the credential proxy is switched off', () => {
    const { egress, policy } = setup(false);
    egress.setEnvRoutes(() => [{ name: 'env-x', upstream: 'https://x.dev', secrets: { A: 'real' } }]);
    expect(Object.keys(policy().routes)).toEqual([]);
    expect(JSON.stringify(policy())).not.toContain('real');
  });
});

/** Minimal Docker API: networks and the proxy container, enough for the proxy runner. Podman reports "bridge" as "podman". */
function fakeDocker(kind: 'docker' | 'podman', proxyNetworks?: string[]) {
  const ips: Record<string, string> = { podman: '10.88.0.5', bridge: '172.17.0.5', 'cocoon-egress': '10.89.1.2', 'cocoon-internal': '10.89.0.2' };
  const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 });
  const networks = new Set(proxyNetworks ? ['cocoon-internal'] : []);
  let proxy: { networks: string[] } | undefined = proxyNetworks ? { networks: [...proxyNetworks] } : undefined;
  const calls = { createdNetworks: [] as { Name: string; Internal: boolean }[], created: [] as any[], connected: [] as string[], removed: 0 };
  const name = (network: string) => (kind === 'podman' && network === 'bridge' ? 'podman' : network);
  const docker = {
    getNetwork: (network: string) => ({
      inspect: async () => {
        if (!networks.has(network) && network !== 'bridge') throw notFound();
      },
      connect: async () => {
        calls.connected.push(name(network));
        proxy!.networks.push(name(network));
      },
    }),
    createNetwork: async (opts: { Name: string; Internal: boolean }) => {
      calls.createdNetworks.push({ Name: opts.Name, Internal: opts.Internal });
      networks.add(opts.Name);
    },
    getContainer: () => ({
      inspect: async () => {
        if (!proxy) throw notFound();
        return { State: { Running: true }, NetworkSettings: { Networks: Object.fromEntries(proxy.networks.map((n) => [n, { IPAddress: ips[n] }])) } };
      },
      remove: async () => {
        calls.removed += 1;
        proxy = undefined;
      },
    }),
    createContainer: async (opts: any) => {
      calls.created.push(opts);
      proxy = { networks: [name(opts.HostConfig.NetworkMode)] };
      return { id: 'proxy', start: async () => undefined };
    },
  };
  const driver = new DockerDriver(kind);
  Object.defineProperty(driver, 'docker', { value: docker });
  return { driver, calls };
}

function proxyManager(driver: SandboxDriver) {
  const store = new Store(dir);
  const bus = new EventBus();
  return new EgressManager(
    driver, store, new SettingsService(store, bus, {}), new SecretsService(store), { all: () => ({}) } as unknown as ProviderService,
    { onFinished() {}, exists: async () => true } as unknown as ImageService, bus, { proxyScript: 'x', processPort: 0 }, () => undefined,
  );
}

describe('egress proxy container', () => {
  it('gives the proxy a network with external DNS under Podman, ahead of the internal network', async () => {
    const { driver, calls } = fakeDocker('podman');
    const egress = proxyManager(driver);
    await egress.ensure();
    expect(calls.createdNetworks).toEqual([
      { Name: 'cocoon-internal', Internal: true },
      { Name: 'cocoon-egress', Internal: false },
    ]);
    expect(calls.created[0].HostConfig.NetworkMode).toBe('cocoon-egress');
    expect(calls.connected).toEqual(['podman', 'cocoon-internal']);
    // Sandboxes with full internet reach the credential proxy on the default bridge, not on the egress network.
    expect(egress.credentialUrl({ proxyToken: 't', network: 'open' }, 'anthropic')).toBe('http://10.88.0.5:8080/t/t/anthropic');
  });

  it('recreates a Podman proxy that was created without the egress network', async () => {
    const { driver, calls } = fakeDocker('podman', ['podman', 'cocoon-internal']);
    await proxyManager(driver).ensure();
    expect(calls.removed).toBe(1);
    expect(calls.created[0].HostConfig.NetworkMode).toBe('cocoon-egress');
  });

  it('keeps a Podman proxy that already has the egress network', async () => {
    const { driver, calls } = fakeDocker('podman', ['cocoon-egress', 'podman', 'cocoon-internal']);
    await proxyManager(driver).ensure();
    expect(calls.removed).toBe(0);
    expect(calls.created).toEqual([]);
  });

  it('leaves Docker on the default bridge, whose DNS forwards external names', async () => {
    const { driver, calls } = fakeDocker('docker');
    await proxyManager(driver).ensure();
    expect(calls.createdNetworks).toEqual([{ Name: 'cocoon-internal', Internal: true }]);
    expect(calls.created[0].HostConfig.NetworkMode).toBe('bridge');
    expect(calls.connected).toEqual(['cocoon-internal']);
  });
});
