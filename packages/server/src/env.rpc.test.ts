import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityLog } from './activity.ts';
import type { Principal } from './auth/principal.ts';
import { EnvService } from './env.ts';
import { EventBus } from './events.ts';
import { createRpc, type RpcContext } from './rpc.ts';
import { SandboxManager } from './sandbox/manager.ts';
import type { SandboxDriver } from './sandbox/driver.ts';
import { SecretsService } from './secrets.ts';
import { SettingsService } from './settings.ts';
import { Store, type SandboxRecord } from './store.ts';
import type { EgressManager } from './egress.ts';
import { WorkspaceService } from './workspaces.ts';

const REAL = 'sk_live_RPCSECRET999';
const admin: Principal = { kind: 'token', role: 'admin', credentialId: 'token:test', name: 'test' };
const member: Principal = { kind: 'user', role: 'member', credentialId: 'session:test', userId: 'us_1', username: 'alice' };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-env-rpc-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
  const store = new Store(dir);
  const bus = new EventBus();
  const activity = new ActivityLog(bus);
  const settings = new SettingsService(store, bus, undefined);
  const secrets = new SecretsService(store);
  const egress = { setEnvRoutes() {}, writePolicy() {}, awaitPolicy: async () => undefined, credentialUrl: (sb: { proxyToken: string }, r: string) => `http://p/t/${sb.proxyToken}/${r}` } as unknown as EgressManager;
  const driver = {} as SandboxDriver;
  const sandboxes = new SandboxManager(settings, secrets, driver, store, bus, egress);
  const envs = new EnvService(store, settings, sandboxes, driver, egress, activity, () => undefined);
  const workspaces = new WorkspaceService(store, bus, activity);
  store.putSandbox({
    id: 'sb_1', name: 'dev', image: 'i', status: 'stopped', network: 'egress', runtime: null, resources: {}, repos: [], workdir: '/workspace',
    createdAt: new Date().toISOString(), proxyToken: 'abcd1234', handle: 'h', services: [],
  } as SandboxRecord);
  const rpc = createRpc({ store, settings, secrets, sandboxes, envs, workspaces, activity, egress, driver } as unknown as RpcContext);
  return { rpc, workspaces };
}

describe('env.* over the RPC layer', () => {
  it('sets, lists, imports and removes variables without ever returning secret values', async () => {
    const { rpc, workspaces } = setup();
    const ws = workspaces.create({ name: 'Platform' });
    const set = (await rpc(admin, 'env.set', { scope: 'workspace', id: ws.id, vars: [{ name: 'STRIPE_KEY', value: REAL }, { name: 'MODE', value: 'test', secret: false, target: 'both' }], filePath: 'config/.env' })) as { vars: { name: string; value?: string }[]; filePath?: string };
    expect(set.filePath).toBe('config/.env');
    expect(set.vars.map((v) => [v.name, v.value])).toEqual([['MODE', 'test'], ['STRIPE_KEY', undefined]]);

    await rpc(admin, 'env.import', { scope: 'sandbox', id: 'sb_1', content: `A=1\nB="${REAL}"\n` });
    await rpc(admin, 'env.import', { scope: 'repo', id: 'git@github.com:acme/app.git', content: `C=${REAL}\n` });
    const all = JSON.stringify(await Promise.all([
      rpc(admin, 'env.get', { scope: 'workspace', id: ws.id }),
      rpc(admin, 'env.get', { scope: 'sandbox', id: 'sb_1' }),
      rpc(admin, 'env.get', { scope: 'repo', id: 'https://github.com/acme/app' }),
      rpc(admin, 'env.resolve', { sandboxId: 'sb_1' }),
      rpc(admin, 'sandbox.get', { sandboxId: 'sb_1' }),
      rpc(admin, 'sandbox.list', {}),
      rpc(admin, 'settings.get', {}),
      rpc(admin, 'secrets.list', {}),
      rpc(admin, 'activity.list', {}),
    ]));
    expect(all).not.toContain(REAL);
    expect(all).toContain('github.com/acme/app');

    const left = (await rpc(admin, 'env.unset', { scope: 'sandbox', id: 'sb_1', names: ['A'] })) as { vars: { name: string }[] };
    expect(left.vars.map((v) => v.name)).toEqual(['B']);
    expect(((await rpc(admin, 'env.set', { scope: 'workspace', id: ws.id, vars: [], filePath: null })) as { filePath?: string }).filePath).toBeUndefined();
  });

  it('validates input at the API boundary', async () => {
    const { rpc } = setup();
    await expect(rpc(admin, 'env.set', { scope: 'sandbox', id: 'sb_1', vars: [{ name: 'bad name', value: 'x' }] })).rejects.toThrow(/Invalid input/);
    await expect(rpc(admin, 'env.set', { scope: 'nowhere', id: 'x', vars: [] })).rejects.toThrow(/Invalid input/);
    await expect(rpc(admin, 'env.set', { scope: 'sandbox', id: 'sb_1', vars: [{ name: 'COCOON_X', value: 'x' }] })).rejects.toThrow(/CoCoon itself/);
    await expect(rpc(admin, 'env.get', { scope: 'sandbox', id: 'missing' })).rejects.toThrow(/not found/);
    await expect(rpc(admin, 'env.apply', { sandboxId: 'sb_1' })).rejects.toThrow(/not running|stopped/i);
  });

  describe('for members', () => {
    type Scope = { vars: { name: string; value?: string; secret: boolean; proxyHost?: string }[] };
    const WS = (id: string) => ({ scope: 'workspace' as const, id });

    /** A credential an admin stored for the credential proxy: the real value never reaches a sandbox. */
    async function adminStoresProxiedKey() {
      const { rpc, workspaces } = setup();
      const ws = workspaces.create({ name: 'Platform' });
      await rpc(admin, 'env.set', { ...WS(ws.id), vars: [{ name: 'STRIPE_API_KEY', value: REAL, proxyHost: 'api.stripe.com' }, { name: 'OTHER_SECRET', value: REAL }] });
      return { rpc, ws };
    }

    it('cannot get a stored value back by switching it to visible or by clearing its proxy host', async () => {
      const { rpc, ws } = await adminStoresProxiedKey();
      const attempts: Array<Record<string, unknown>> = [
        { name: 'STRIPE_API_KEY', secret: false, proxyHost: null },
        { name: 'STRIPE_API_KEY', secret: false },
        { name: 'STRIPE_API_KEY', proxyHost: null },
        { name: 'OTHER_SECRET', secret: false },
      ];
      for (const attempt of attempts) {
        await expect(rpc(member, 'env.set', { ...WS(ws.id), vars: [attempt] }), JSON.stringify(attempt)).rejects.toMatchObject({ code: 'forbidden' });
      }
      // Nothing changed, and no response ever carried the value.
      const after = (await rpc(admin, 'env.get', WS(ws.id))) as Scope;
      expect(after.vars.map((v) => [v.name, v.secret, v.proxyHost, v.value])).toEqual([
        ['OTHER_SECRET', true, undefined, undefined],
        ['STRIPE_API_KEY', true, 'api.stripe.com', undefined],
      ]);
    });

    it('cannot send a stored secret to a host of their choosing', async () => {
      const { rpc, ws } = await adminStoresProxiedKey();
      for (const attempt of [{ name: 'STRIPE_API_KEY', proxyHost: 'attacker.example.com' }, { name: 'OTHER_SECRET', proxyHost: 'attacker.example.com' }, { name: 'STRIPE_API_KEY', baseUrlEnv: 'EVIL_BASE_URL' }]) {
        await expect(rpc(member, 'env.set', { ...WS(ws.id), vars: [attempt] }), JSON.stringify(attempt)).rejects.toMatchObject({ code: 'forbidden' });
      }
      const after = (await rpc(admin, 'env.get', WS(ws.id))) as Scope;
      expect(after.vars.find((v) => v.name === 'STRIPE_API_KEY')?.proxyHost).toBe('api.stripe.com');
      expect(after.vars.find((v) => v.name === 'OTHER_SECRET')?.proxyHost).toBeUndefined();
    });

    it('cannot turn a secret into a visible value with env.import either', async () => {
      const { rpc, ws } = await adminStoresProxiedKey();
      // The file has to bring its own value: the old one is replaced, not shown.
      const result = (await rpc(member, 'env.import', { ...WS(ws.id), content: 'STRIPE_API_KEY=member-own-value\n', secret: false })) as { scope: Scope };
      expect(JSON.stringify(result)).not.toContain(REAL);
      expect(result.scope.vars.find((v) => v.name === 'OTHER_SECRET')).toMatchObject({ secret: true, value: undefined });
    });

    it('can still work with variables: write new ones, replace a value, keep the settings, hide a visible one', async () => {
      const { rpc, ws } = await adminStoresProxiedKey();
      const created = (await rpc(member, 'env.set', { ...WS(ws.id), vars: [{ name: 'MODE', value: 'test', secret: false }, { name: 'DB_PASSWORD', value: 'local-only' }] })) as Scope;
      expect(created.vars.find((v) => v.name === 'MODE')?.value).toBe('test');
      expect(created.vars.find((v) => v.name === 'DB_PASSWORD')).toMatchObject({ secret: true, value: undefined });
      // Entering a new value may also change the settings: the old value is gone, nothing is revealed.
      const replaced = (await rpc(member, 'env.set', { ...WS(ws.id), vars: [{ name: 'OTHER_SECRET', value: 'mine', secret: false, proxyHost: null }] })) as Scope;
      expect(replaced.vars.find((v) => v.name === 'OTHER_SECRET')?.value).toBe('mine');
      // Settings that stay as they are are no change; hiding a visible value is allowed.
      await expect(rpc(member, 'env.set', { ...WS(ws.id), vars: [{ name: 'STRIPE_API_KEY', secret: true, proxyHost: 'api.stripe.com' }] })).resolves.toBeDefined();
      const hidden = (await rpc(member, 'env.set', { ...WS(ws.id), vars: [{ name: 'MODE', secret: true }] })) as Scope;
      expect(hidden.vars.find((v) => v.name === 'MODE')).toMatchObject({ secret: true, value: undefined });
      await expect(rpc(member, 'env.unset', { ...WS(ws.id), names: ['DB_PASSWORD'] })).resolves.toBeDefined();
    });

    it('lets admins do what members cannot', async () => {
      const { rpc, ws } = await adminStoresProxiedKey();
      const revealed = (await rpc(admin, 'env.set', { ...WS(ws.id), vars: [{ name: 'OTHER_SECRET', secret: false }] })) as Scope;
      expect(revealed.vars.find((v) => v.name === 'OTHER_SECRET')?.value).toBe(REAL);
    });
  });

  it('keeps the env methods out of MCP (an orchestrating agent must not read or change secrets)', async () => {
    const { methods } = await import('@cocoon/protocol');
    for (const name of Object.keys(methods).filter((n) => n.startsWith('env.'))) expect((methods as Record<string, { mcp?: boolean }>)[name]!.mcp, name).toBeFalsy();
  });
});
