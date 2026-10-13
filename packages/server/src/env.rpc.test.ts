import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityLog } from './activity.ts';
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
    const set = (await rpc('env.set', { scope: 'workspace', id: ws.id, vars: [{ name: 'STRIPE_KEY', value: REAL }, { name: 'MODE', value: 'test', secret: false, target: 'both' }], filePath: 'config/.env' })) as { vars: { name: string; value?: string }[]; filePath?: string };
    expect(set.filePath).toBe('config/.env');
    expect(set.vars.map((v) => [v.name, v.value])).toEqual([['MODE', 'test'], ['STRIPE_KEY', undefined]]);

    await rpc('env.import', { scope: 'sandbox', id: 'sb_1', content: `A=1\nB="${REAL}"\n` });
    await rpc('env.import', { scope: 'repo', id: 'git@github.com:acme/app.git', content: `C=${REAL}\n` });
    const all = JSON.stringify(await Promise.all([
      rpc('env.get', { scope: 'workspace', id: ws.id }),
      rpc('env.get', { scope: 'sandbox', id: 'sb_1' }),
      rpc('env.get', { scope: 'repo', id: 'https://github.com/acme/app' }),
      rpc('env.resolve', { sandboxId: 'sb_1' }),
      rpc('sandbox.get', { sandboxId: 'sb_1' }),
      rpc('sandbox.list', {}),
      rpc('settings.get', {}),
      rpc('secrets.list', {}),
      rpc('activity.list', {}),
    ]));
    expect(all).not.toContain(REAL);
    expect(all).toContain('github.com/acme/app');

    const left = (await rpc('env.unset', { scope: 'sandbox', id: 'sb_1', names: ['A'] })) as { vars: { name: string }[] };
    expect(left.vars.map((v) => v.name)).toEqual(['B']);
    expect(((await rpc('env.set', { scope: 'workspace', id: ws.id, vars: [], filePath: null })) as { filePath?: string }).filePath).toBeUndefined();
  });

  it('validates input at the API boundary', async () => {
    const { rpc } = setup();
    await expect(rpc('env.set', { scope: 'sandbox', id: 'sb_1', vars: [{ name: 'bad name', value: 'x' }] })).rejects.toThrow(/Invalid input/);
    await expect(rpc('env.set', { scope: 'nowhere', id: 'x', vars: [] })).rejects.toThrow(/Invalid input/);
    await expect(rpc('env.set', { scope: 'sandbox', id: 'sb_1', vars: [{ name: 'COCOON_X', value: 'x' }] })).rejects.toThrow(/CoCoon itself/);
    await expect(rpc('env.get', { scope: 'sandbox', id: 'missing' })).rejects.toThrow(/not found/);
    await expect(rpc('env.apply', { sandboxId: 'sb_1' })).rejects.toThrow(/not running|stopped/i);
  });

  it('keeps the env methods out of MCP (an orchestrating agent must not read or change secrets)', async () => {
    const { methods } = await import('@cocoon/protocol');
    for (const name of Object.keys(methods).filter((n) => n.startsWith('env.'))) expect((methods as Record<string, { mcp?: boolean }>)[name]!.mcp, name).toBeFalsy();
  });
});
