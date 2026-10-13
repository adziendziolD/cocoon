import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityLog } from './activity.ts';
import { ENV_FILE_MARKER, EnvService, WRITE_ENV_FILE_SCRIPT, type EnvRoute } from './env.ts';
import { EnvVault } from './env-vault.ts';
import { EventBus } from './events.ts';
import type { EgressManager } from './egress.ts';
import type { ExecOptions, SandboxDriver } from './sandbox/driver.ts';
import type { SandboxManager } from './sandbox/manager.ts';
import { SettingsService } from './settings.ts';
import { Store, type SandboxRecord } from './store.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
const initRepo = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'tag', 'cocoon-baseline');
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cocoon-env-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('EnvVault', () => {
  it('encrypts, binds values to their place and keeps plaintext out of the blob', () => {
    const vault = EnvVault.in(root);
    const blob = vault.encrypt('workspace:ws_1/KEY', 'sk_live_topsecret');
    expect(blob).not.toContain('topsecret');
    expect(Buffer.from(blob.split(':')[3]!, 'base64').toString('latin1')).not.toContain('topsecret');
    expect(vault.decrypt('workspace:ws_1/KEY', blob)).toBe('sk_live_topsecret');
    expect(vault.decrypt('workspace:ws_1/OTHER', blob)).toBeUndefined();
    expect(vault.decrypt('sandbox:sb_1/KEY', blob)).toBeUndefined();
    expect(vault.decrypt('workspace:ws_1/KEY', blob.slice(0, -4) + 'AAAA')).toBeUndefined();
  });

  it('uses a fresh IV per value and a private key file shared across instances', () => {
    const vault = EnvVault.in(root);
    expect(vault.encrypt('c', 'same')).not.toBe(vault.encrypt('c', 'same'));
    expect(statSync(join(root, 'env.key')).mode & 0o777).toBe(0o600);
    expect(EnvVault.in(root).decrypt('c', vault.encrypt('c', 'x'))).toBe('x');
  });

  it('cannot decrypt without the key file or with a different one', () => {
    const blob = EnvVault.in(root).encrypt('c', 'x');
    const other = mkdtempSync(join(tmpdir(), 'cocoon-env-other-'));
    try {
      expect(EnvVault.in(other).decrypt('c', blob)).toBeUndefined(); // no key there
      EnvVault.in(other).encrypt('c', 'y'); // creates a different key
      expect(EnvVault.in(other).decrypt('c', blob)).toBeUndefined();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

// ── EnvService ───────────────────────────────────────────────────────────────

const REAL = 'sk_test_REALSECRET123';

interface Rig {
  base: string;
  store: Store;
  envs: EnvService;
  routes: () => EnvRoute[];
  workdir: string;
  sandbox: SandboxRecord;
  /** Runs commands the way the sandbox would, but locally. */
  setRunning(running: boolean): void;
  policyWrites: number;
  settings: SettingsService;
  logs: string[];
}

function rig(opts: { network?: 'egress' | 'none' | 'open'; repos?: { url: string; path: string }[]; credentialProxy?: boolean } = {}): Rig {
  const base = mkdtempSync(join(root, 'rig-'));
  const store = new Store(join(base, 'data'));
  const bus = new EventBus();
  const settings = new SettingsService(store, bus, { egress: { credentialProxy: opts.credentialProxy ?? true } });
  const workdir = join(base, 'workspace');
  mkdirSync(workdir, { recursive: true });
  const repos = opts.repos ?? [{ url: 'https://github.com/acme/app.git', path: '' }];
  const sandbox: SandboxRecord = {
    id: 'sb_1', name: 'dev', image: 'img', status: 'running', network: opts.network ?? 'egress', runtime: null, resources: {},
    repos, workdir, createdAt: new Date().toISOString(), proxyToken: 'abcdef0123456789', handle: 'h1', workspaceId: 'ws_1', services: [],
  } as SandboxRecord;
  store.putSandbox(sandbox);
  store.putWorkspace({ id: 'ws_1', name: 'Platform', sandboxMode: 'per-task', defaultAgentKind: 'claude-code', autoRun: false, maxParallel: 2, createdAt: new Date().toISOString() });
  for (const r of repos) initRepo(r.path ? join(workdir, r.path) : workdir);

  const state = { running: true, policyWrites: 0, routesFn: (() => []) as (id: string) => EnvRoute[], logs: [] as string[] };
  const staging = join(base, 'staging');
  mkdirSync(staging, { recursive: true });
  const driver = {
    async putArchive(_h: string, _dir: string, tar: Buffer) {
      const name = tar.subarray(0, 100).toString().replace(/\0.*$/, '');
      const size = Number.parseInt(tar.subarray(124, 135).toString(), 8);
      writeFileSync(join(staging, name), tar.subarray(512, 512 + size), { mode: 0o600 });
    },
    async exec(_h: string, command: string[], o: ExecOptions = {}) {
      const env = { ...process.env, ...o.env } as Record<string, string>;
      if (env.STAGED) env.STAGED = env.STAGED.replace('/opt/cocoon/tmp', staging);
      const res = spawnSync(command[0]!, command.slice(1), { env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' });
      return { exitCode: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
    },
  } as unknown as SandboxDriver;
  const sandboxes = {
    record: (id: string) => store.sandbox(id)!,
    runningHandle: () => {
      if (!state.running) throw new Error('not running');
      return 'h1';
    },
  } as unknown as SandboxManager;
  const egress = {
    setEnvRoutes: (fn: (id: string) => EnvRoute[]) => (state.routesFn = fn),
    writePolicy: () => state.policyWrites++,
    awaitPolicy: async () => undefined,
    credentialUrl: (sb: { proxyToken: string }, route: string) => `http://cocoon-proxy:8080/t/${sb.proxyToken}/${route}`,
  } as unknown as EgressManager;
  const envs = new EnvService(store, settings, sandboxes, driver, egress, new ActivityLog(bus), (msg) => state.logs.push(msg));
  return {
    base, store, envs, workdir, sandbox, settings, logs: state.logs,
    routes: () => state.routesFn('sb_1'),
    setRunning: (v) => (state.running = v),
    get policyWrites() { return state.policyWrites; },
  };
}

const ws = { scope: 'workspace', id: 'ws_1' } as const;
const repo = { scope: 'repo', id: 'git@github.com:acme/app.git' } as const;
const sb = { scope: 'sandbox', id: 'sb_1' } as const;

describe('EnvService – levels', () => {
  it('merges workspace → repository → sandbox → agent type with origins', () => {
    const r = rig();
    r.envs.set(ws, [{ name: 'A', value: 'ws' }, { name: 'B', value: 'ws' }, { name: 'C', value: 'ws' }, { name: 'D', value: 'ws' }]);
    r.envs.set(repo, [{ name: 'B', value: 'repo' }, { name: 'C', value: 'repo' }, { name: 'D', value: 'repo' }]);
    r.envs.set(sb, [{ name: 'C', value: 'sandbox' }, { name: 'D', value: 'sandbox' }]);
    r.settings.update({ agents: { ...r.settings.get().agents, probe: { command: ['bash'], env: { D: 'agent', E: 'agent' } } } });

    const injected = r.envs.injectedEnv(r.sandbox);
    expect(injected).toMatchObject({ A: 'ws', B: 'repo', C: 'sandbox', D: 'sandbox' });

    const resolved = r.envs.resolve('sb_1', 'probe');
    const by = Object.fromEntries(resolved.vars.map((v) => [v.name, v]));
    expect(by.A!.origin).toMatchObject({ scope: 'workspace', label: 'Platform' });
    expect(by.B!.origin).toMatchObject({ scope: 'repo', id: 'github.com/acme/app' });
    expect(by.B!.overrides.map((o) => o.scope)).toEqual(['workspace']);
    expect(by.C!.origin.scope).toBe('sandbox');
    expect(by.C!.overrides.map((o) => o.scope)).toEqual(['workspace', 'repo']);
    expect(by.D!.origin).toMatchObject({ scope: 'agent', id: 'probe' });
    expect(by.D!.overrides.map((o) => o.scope)).toEqual(['workspace', 'repo', 'sandbox']);
    expect(by.E!.origin.scope).toBe('agent');
  });

  it('applies repository variables to any spelling of the same URL and ignores other repositories', () => {
    const r = rig({ repos: [{ url: 'https://GitHub.com/acme/app', path: '' }] });
    r.envs.set({ scope: 'repo', id: 'ssh://git@github.com/acme/app.git' }, [{ name: 'MINE', value: '1' }]);
    r.envs.set({ scope: 'repo', id: 'https://github.com/acme/other' }, [{ name: 'OTHER', value: '1' }]);
    expect(Object.keys(r.envs.injectedEnv(r.sandbox))).toEqual(['MINE']);
  });

  it('rejects unknown scopes, reserved names and bad input', () => {
    const r = rig();
    expect(() => r.envs.get({ scope: 'workspace', id: 'nope' })).toThrow(/not found/i);
    expect(() => r.envs.get({ scope: 'sandbox', id: 'nope' })).toThrow(/not found/i);
    expect(() => r.envs.get({ scope: 'repo', id: 'justaword' })).toThrow();
    for (const name of ['COCOON_AGENT_ID', 'HTTPS_PROXY']) expect(() => r.envs.set(sb, [{ name, value: 'x' }])).toThrow(/CoCoon itself/);
    expect(() => r.envs.set(sb, [{ name: 'NEW' }])).toThrow(/missing/);
    expect(() => r.envs.set(sb, [{ name: 'A', value: 'x', proxyHost: 'not a host' }])).toThrow(/host name/);
    expect(() => r.envs.set(sb, [{ name: 'lower_case', value: 'x', proxyHost: 'api.example.com' }])).toThrow(/capital/);
    expect(() => r.envs.set(sb, [], '../escape')).toThrow(/Invalid .env file path/);
    expect(() => r.envs.set(sb, [{ name: 'A', value: 'x\0y' }])).toThrow();
  });

  it('changes only the settings of a variable when no value is given', () => {
    const r = rig();
    r.envs.set(sb, [{ name: 'KEEP', value: 'v1' }]);
    r.envs.set(sb, [{ name: 'KEEP', target: 'both', secret: false }]);
    expect(r.envs.get(sb).vars[0]).toMatchObject({ name: 'KEEP', target: 'both', secret: false, value: 'v1' });
  });

  it('removes variables and the scope when empty; deleting the sandbox or workspace drops its variables', () => {
    const r = rig();
    r.envs.set(sb, [{ name: 'A', value: '1' }, { name: 'B', value: '2' }]);
    expect(r.envs.unset(sb, ['A', 'MISSING']).vars.map((v) => v.name)).toEqual(['B']);
    r.envs.unset(sb, ['B']);
    expect(r.store.envScope('sandbox:sb_1')).toBeUndefined();
    r.envs.set(sb, [{ name: 'A', value: '1' }]);
    r.envs.set(ws, [{ name: 'W', value: '1' }]);
    r.store.deleteSandbox('sb_1');
    r.store.deleteWorkspace('ws_1');
    expect(r.store.envScope('sandbox:sb_1')).toBeUndefined();
    expect(r.store.envScope('workspace:ws_1')).toBeUndefined();
  });

  it('imports a .env file, optionally replacing, and skips reserved names', () => {
    const r = rig();
    r.envs.set(ws, [{ name: 'OLD', value: 'x' }]);
    const result = r.envs.import({ ...ws, content: 'A=1\nB="two words"\nHTTPS_PROXY=http://evil\nbroken line\n', replace: true });
    expect(result.imported).toEqual(['A', 'B']);
    expect(result.errors).toHaveLength(2);
    expect(result.scope.vars.map((v) => v.name)).toEqual(['A', 'B']);
    expect(r.envs.injectedEnv(r.sandbox)).toMatchObject({ A: '1', B: 'two words' });
  });
});

describe('EnvService – secrets stay secret', () => {
  it('stores values encrypted and never returns them for secret variables', () => {
    const r = rig();
    r.envs.set(ws, [{ name: 'DB_URL', value: `postgres://u:${REAL}@db/app` }, { name: 'FLAG', value: 'on', secret: false }]);
    r.envs.set(sb, [{ name: 'SB_SECRET', value: REAL, target: 'both' }]);

    const state = readFileSync(join(r.base, 'data', 'state.json'), 'utf8');
    expect(state).not.toContain(REAL);
    expect(state).not.toContain('postgres://');
    expect(readFileSync(join(r.base, 'data', 'state.json')).length).toBeGreaterThan(0);
    expect(statSync(join(r.base, 'data', 'env.key')).mode & 0o777).toBe(0o600);

    const api = JSON.stringify([r.envs.get(ws), r.envs.get(sb), r.envs.resolve('sb_1', 'claude-code')]);
    expect(api).not.toContain(REAL);
    expect(r.envs.get(ws).vars.find((v) => v.name === 'FLAG')?.value).toBe('on');
    expect(r.envs.get(ws).vars.find((v) => v.name === 'DB_URL')?.value).toBeUndefined();
  });

  it('survives a restart (same data directory)', () => {
    const r = rig();
    r.envs.set(sb, [{ name: 'KEEP', value: REAL }]);
    const again = new EnvService(new Store(join(r.base, 'data')), r.settings, { record: () => r.sandbox } as unknown as SandboxManager, {} as SandboxDriver,
      { setEnvRoutes() {}, writePolicy() {}, credentialUrl: () => '' } as unknown as EgressManager, new ActivityLog(new EventBus()), () => undefined);
    expect(again.injectedEnv(r.sandbox)).toEqual({ KEEP: REAL });
  });

  it('skips values it cannot decrypt instead of failing', () => {
    const r = rig();
    r.envs.set(sb, [{ name: 'GOOD', value: 'g' }, { name: 'BAD', value: 'b' }]);
    rmSync(join(r.base, 'data', 'env.key'));
    const fresh = new EnvService(r.store, r.settings, { record: () => r.sandbox } as unknown as SandboxManager, {} as SandboxDriver,
      { setEnvRoutes() {}, writePolicy() {}, credentialUrl: () => '' } as unknown as EgressManager, new ActivityLog(new EventBus()), () => undefined);
    expect(fresh.injectedEnv(r.sandbox)).toEqual({});
  });

  it('keeps values out of the activity log', () => {
    const r = rig();
    const bus = new EventBus();
    const activity = new ActivityLog(bus);
    const envs = new EnvService(r.store, r.settings, { record: () => r.sandbox } as unknown as SandboxManager, {} as SandboxDriver,
      { setEnvRoutes() {}, writePolicy() {}, credentialUrl: () => '' } as unknown as EgressManager, activity, () => undefined);
    envs.set(sb, [{ name: 'TOKEN_X', value: REAL }]);
    expect(JSON.stringify(activity.list(100, 'en'))).not.toContain(REAL);
    expect(JSON.stringify(activity.list(100, 'en'))).toContain('changed');
  });
});

describe('EnvService – credential proxy', () => {
  it('injects a placeholder and base URL, and keeps the real value for the proxy route only', () => {
    const r = rig();
    r.envs.set(ws, [{ name: 'STRIPE_API_KEY', value: REAL, proxyHost: 'https://API.stripe.com/' }]);
    const env = r.envs.injectedEnv(r.sandbox);
    expect(env.STRIPE_API_KEY).toBe('cocoon_abcdef0123456789_STRIPE_API_KEY');
    expect(env.STRIPE_BASE_URL).toBe('http://cocoon-proxy:8080/t/abcdef0123456789/env-sb_1-api.stripe.com');
    expect(JSON.stringify(env)).not.toContain(REAL);
    expect(r.routes()).toEqual([{ name: 'env-sb_1-api.stripe.com', upstream: 'https://api.stripe.com', secrets: { STRIPE_API_KEY: REAL } }]);
    expect(r.envs.get(ws).vars[0]).toMatchObject({ secret: true, proxyHost: 'api.stripe.com' });
  });

  it('supports internal http hosts and ports with path-safe route names', () => {
    const r = rig();
    r.envs.set(sb, [{ name: 'LOCAL_KEY', value: REAL, proxyHost: 'HTTP://localhost:9000/' }, { name: 'PORT_KEY', value: REAL, proxyHost: 'api.internal:8443' }]);
    expect(r.routes().map((x) => [x.name, x.upstream])).toEqual([
      ['env-sb_1-http-localhost-port-9000', 'http://localhost:9000'],
      ['env-sb_1-api.internal-port-8443', 'https://api.internal:8443'],
    ]);
    expect(r.envs.injectedEnv(r.sandbox).LOCAL_BASE_URL).toMatch(/\/env-sb_1-http-localhost-port-9000$/);
    for (const route of r.routes()) expect(route.name).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('forces proxied variables to be secret and honors a custom base-URL variable', () => {
    const r = rig();
    r.envs.set(sb, [{ name: 'SENTRY_AUTH_TOKEN', value: REAL, secret: false, proxyHost: 'sentry.io', baseUrlEnv: 'SENTRY_URL' }]);
    expect(r.envs.get(sb).vars[0]).toMatchObject({ secret: true });
    expect(r.envs.get(sb).vars[0]!.value).toBeUndefined();
    expect(r.envs.injectedEnv(r.sandbox)).toHaveProperty('SENTRY_URL');
  });

  it('groups several variables of one host in one route', () => {
    const r = rig();
    r.envs.set(sb, [{ name: 'A_KEY', value: 'a', proxyHost: 'api.example.com' }, { name: 'B_KEY', value: 'b', proxyHost: 'api.example.com' }, { name: 'C_KEY', value: 'c', proxyHost: 'other.example.com' }]);
    expect(r.routes().map((x) => [x.name, Object.keys(x.secrets)])).toEqual([
      ['env-sb_1-api.example.com', ['A_KEY', 'B_KEY']],
      ['env-sb_1-other.example.com', ['C_KEY']],
    ]);
  });

  it('never injects a proxied value in plain text when there is no proxy', () => {
    for (const r of [rig({ network: 'none' }), rig({ credentialProxy: false })]) {
      r.envs.set(sb, [{ name: 'STRIPE_API_KEY', value: REAL, proxyHost: 'api.stripe.com', target: 'both' }, { name: 'PLAIN', value: 'p' }]);
      expect(r.envs.injectedEnv(r.sandbox)).toEqual({ PLAIN: 'p' });
      expect(r.routes()).toEqual([]);
      expect(r.envs.resolve('sb_1').vars.find((v) => v.name === 'STRIPE_API_KEY')?.skipped).toMatch(/not injected/i);
    }
  });

  it('lets a sandbox-level plain variable replace a proxied workspace one', () => {
    const r = rig();
    r.envs.set(ws, [{ name: 'API_KEY', value: REAL, proxyHost: 'api.example.com' }]);
    r.envs.set(sb, [{ name: 'API_KEY', value: 'local-dummy', secret: false }]);
    expect(r.envs.injectedEnv(r.sandbox)).toEqual({ API_KEY: 'local-dummy' });
    expect(r.routes()).toEqual([]);
  });

  it('refreshes the proxy policy when variables change', () => {
    const r = rig();
    const before = r.policyWrites;
    r.envs.set(sb, [{ name: 'A_KEY', value: 'a', proxyHost: 'api.example.com' }]);
    r.envs.unset(sb, ['A_KEY']);
    expect(r.policyWrites).toBe(before + 2);
  });
});

describe('EnvService – .env files', () => {
  const status = (r: Rig) => r.envs.resolve('sb_1').files;

  it('writes the file into the repository, excluded from git, mode 0600 and never in diffs or commits', async () => {
    const r = rig();
    r.envs.set(ws, [{ name: 'DB_URL', value: `postgres://u:${REAL}@db/app`, target: 'file' }, { name: 'ENV_ONLY', value: 'e' }]);
    r.envs.set(sb, [{ name: 'BOTH', value: 'it has spaces', target: 'both' }]);
    expect(await r.envs.applyFiles('sb_1')).toEqual([{ folder: '', path: '.env', status: 'written', vars: 2 }]);

    const file = join(r.workdir, '.env');
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n')[0]).toBe(ENV_FILE_MARKER);
    expect(text).toContain(`DB_URL=postgres://u:${REAL}@db/app\n`);
    expect(text).toContain("BOTH='it has spaces'");
    expect(text).not.toContain('ENV_ONLY');
    expect(statSync(file).mode & 0o777).toBe(0o600);

    expect(readFileSync(join(r.workdir, '.git/info/exclude'), 'utf8')).toContain('/.env');
    expect(git(r.workdir, 'status', '--porcelain')).toBe('');
    git(r.workdir, 'add', '-A');
    expect(git(r.workdir, 'diff', '--cached', '--binary', 'cocoon-baseline')).toBe('');
    expect(git(r.workdir, 'ls-files')).toBe('');
    // The same commands CoCoon uses for commit and patch export stay empty.
    expect(() => git(r.workdir, 'diff', '--cached', '--quiet')).not.toThrow();
    expect(status(r)).toEqual([{ folder: '', path: '.env', status: 'written', vars: 2 }]);
  });

  it('reports unchanged on a second run and rewrites after a change', async () => {
    const r = rig();
    r.envs.set(sb, [{ name: 'A', value: '1', target: 'file' }]);
    await r.envs.applyFiles('sb_1');
    expect((await r.envs.applyFiles('sb_1'))[0]!.status).toBe('unchanged');
    r.envs.set(sb, [{ name: 'A', value: '2' }]);
    expect((await r.envs.applyFiles('sb_1'))[0]!.status).toBe('written');
    expect(readFileSync(join(r.workdir, '.env'), 'utf8')).toContain('A=2');
  });

  it('removes its own file when no variable targets a file any more, but never a foreign one', async () => {
    const r = rig();
    r.envs.set(sb, [{ name: 'A', value: '1', target: 'file' }]);
    await r.envs.applyFiles('sb_1');
    r.envs.unset(sb, ['A']);
    expect((await r.envs.applyFiles('sb_1'))[0]).toMatchObject({ status: 'removed', vars: 0 });
    expect(existsSync(join(r.workdir, '.env'))).toBe(false);

    writeFileSync(join(r.workdir, '.env'), 'MINE=1\n');
    expect((await r.envs.applyFiles('sb_1'))[0]!.status).toBe('unchanged');
    expect(readFileSync(join(r.workdir, '.env'), 'utf8')).toBe('MINE=1\n');
  });

  it('does not overwrite a file CoCoon did not create', async () => {
    const r = rig();
    writeFileSync(join(r.workdir, '.env'), 'HANDWRITTEN=1\n');
    r.envs.set(sb, [{ name: 'A', value: REAL, target: 'file' }]);
    const [result] = await r.envs.applyFiles('sb_1');
    expect(result).toMatchObject({ status: 'skipped' });
    expect(result!.message).toMatch(/not overwritten/);
    expect(readFileSync(join(r.workdir, '.env'), 'utf8')).toBe('HANDWRITTEN=1\n');
  });

  it('does not write into a file that is tracked by the repository (it would show up in diffs)', async () => {
    const r = rig();
    writeFileSync(join(r.workdir, '.env'), 'COMMITTED=1\n');
    git(r.workdir, 'add', '.env');
    git(r.workdir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'oops');
    r.envs.set(sb, [{ name: 'A', value: REAL, target: 'file' }]);
    const [result] = await r.envs.applyFiles('sb_1');
    expect(result).toMatchObject({ status: 'skipped' });
    expect(result!.message).toMatch(/tracked/);
    expect(readFileSync(join(r.workdir, '.env'), 'utf8')).toBe('COMMITTED=1\n');
    expect(git(r.workdir, 'status', '--porcelain')).toBe('');
  });

  it('writes each repository folder with its own level on top of workspace and sandbox', async () => {
    const r = rig({ repos: [{ url: 'https://github.com/acme/api', path: 'api' }, { url: 'https://github.com/acme/web.git', path: 'web' }] });
    r.envs.set(ws, [{ name: 'SHARED', value: 'ws', target: 'file' }]);
    r.envs.set({ scope: 'repo', id: 'github.com/acme/api' }, [{ name: 'API_ONLY', value: 'a', target: 'file' }, { name: 'SHARED', value: 'api', target: 'file' }]);
    r.envs.set({ scope: 'repo', id: 'https://github.com/acme/web' }, [{ name: 'WEB_ONLY', value: 'w', target: 'file' }]);
    r.envs.set(sb, [{ name: 'EVERYWHERE', value: 's', target: 'file' }], 'config/.env.cocoon');
    const files = await r.envs.applyFiles('sb_1');
    expect(files.map((f) => [f.folder, f.path, f.status])).toEqual([['api', 'config/.env.cocoon', 'written'], ['web', 'config/.env.cocoon', 'written']]);
    const api = readFileSync(join(r.workdir, 'api/config/.env.cocoon'), 'utf8');
    const web = readFileSync(join(r.workdir, 'web/config/.env.cocoon'), 'utf8');
    expect(api).toMatch(/SHARED=api\n/);
    expect(api).toContain('API_ONLY=a');
    expect(api).not.toContain('WEB_ONLY');
    expect(web).toMatch(/SHARED=ws\n/);
    expect(web).toContain('WEB_ONLY=w');
    expect(web).not.toContain('API_ONLY');
    for (const dir of ['api', 'web']) {
      expect(readFileSync(join(r.workdir, dir, '.git/info/exclude'), 'utf8')).toContain('/config/.env.cocoon');
      expect(git(join(r.workdir, dir), 'status', '--porcelain')).toBe('');
    }
  });

  it('puts placeholders (not secrets) of proxied variables into the file', async () => {
    const r = rig();
    r.envs.set(sb, [{ name: 'STRIPE_API_KEY', value: REAL, proxyHost: 'api.stripe.com', target: 'file' }]);
    await r.envs.applyFiles('sb_1');
    const text = readFileSync(join(r.workdir, '.env'), 'utf8');
    expect(text).not.toContain(REAL);
    expect(text).toContain('STRIPE_API_KEY=cocoon_abcdef0123456789_STRIPE_API_KEY');
    expect(text).toContain('STRIPE_BASE_URL=http://cocoon-proxy:8080/t/abcdef0123456789/env-sb_1-api.stripe.com');
    // target "file": nothing in the process environment
    expect(r.envs.injectedEnv(r.sandbox)).toEqual({});
  });

  it('skips a folder that is not a git repository', async () => {
    const r = rig({ repos: [{ url: 'https://github.com/acme/api', path: 'api' }] });
    rmSync(join(r.workdir, 'api/.git'), { recursive: true });
    r.envs.set(sb, [{ name: 'A', value: REAL, target: 'file' }]);
    const [result] = await r.envs.applyFiles('sb_1');
    expect(result).toMatchObject({ status: 'skipped' });
    expect(existsSync(join(r.workdir, 'api/.env'))).toBe(false);
  });

  it('requires a running sandbox but does not break agent start when writing fails', async () => {
    const r = rig();
    r.envs.set(sb, [{ name: 'A', value: '1', target: 'file' }]);
    r.setRunning(false);
    await expect(r.envs.applyFiles('sb_1')).rejects.toThrow();
    await expect(r.envs.prepare('sb_1')).resolves.toBeUndefined();
    expect(r.logs.join()).toContain('writing .env files failed');
  });

  it('leaves the staged file behind nowhere', async () => {
    const r = rig();
    r.envs.set(sb, [{ name: 'A', value: REAL, target: 'file' }]);
    await r.envs.applyFiles('sb_1');
    await r.envs.applyFiles('sb_1');
    r.envs.unset(sb, ['A']);
    await r.envs.applyFiles('sb_1');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(r.base, 'staging'))).toEqual([]);
  });
});

describe('write script', () => {
  const run = (dir: string, staged: string, rel = '.env') =>
    spawnSync('sh', ['-c', WRITE_ENV_FILE_SCRIPT], { env: { ...process.env, DIR: dir, REL: rel, STAGED: staged, MARKER: ENV_FILE_MARKER, GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' });

  it('excludes a folder inside a parent repository with the right prefix', () => {
    const parent = join(root, 'parent');
    initRepo(parent);
    const sub = join(parent, 'pkg/app');
    mkdirSync(sub, { recursive: true });
    const staged = join(root, 'staged');
    writeFileSync(staged, `${ENV_FILE_MARKER}\nA=1\n`);
    const res = run(sub, staged);
    expect(res.stdout.trim()).toBe('written');
    expect(readFileSync(join(parent, '.git/info/exclude'), 'utf8')).toContain('/pkg/app/.env');
    git(parent, 'add', '-A');
    expect(git(parent, 'status', '--porcelain')).toBe('');
  });

  it('refuses a symlink and fails for a missing folder', () => {
    const dir = join(root, 'r');
    initRepo(dir);
    const staged = join(root, 'staged');
    writeFileSync(staged, 'A=1\n');
    spawnSync('ln', ['-s', '/etc/hostname', join(dir, '.env')]);
    expect(run(dir, staged).status).toBe(13);
    writeFileSync(staged, 'A=1\n');
    expect(run(join(root, 'missing'), staged).status).toBe(10);
    // The staged copy (it holds the secrets) is deleted on every exit path.
    expect(existsSync(staged)).toBe(false);
  });

  it('does not run git hooks or touch anything else in the repository', () => {
    const dir = join(root, 'r2');
    initRepo(dir);
    const staged = join(root, 'staged');
    writeFileSync(staged, `${ENV_FILE_MARKER}\nA=1\n`);
    run(dir, staged);
    expect(git(dir, 'status', '--porcelain', '--ignored').trim()).toBe('!! .env');
  });
});
