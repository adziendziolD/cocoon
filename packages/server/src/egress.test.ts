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
