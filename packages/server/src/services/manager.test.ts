import { describe, expect, it, vi } from 'vitest';
import type { ServiceKind } from '@cocoon/protocol';
import type { EgressManager } from '../egress.ts';
import type { EventBus } from '../events.ts';
import type { SandboxDriver } from '../sandbox/driver.ts';
import type { SandboxManager } from '../sandbox/manager.ts';
import type { SandboxRecord, SandboxServiceDb, ServiceRecord, Store } from '../store.ts';
import { sandboxDbName, ServiceManager, SERVICES_ENV_FILE } from './manager.ts';

describe('sandboxDbName', () => {
  it('lower-cases and replaces everything outside [a-z0-9_]', () => {
    expect(sandboxDbName('sb-AbC123')).toBe('sb_abc123');
    expect(sandboxDbName('my.sandbox/1')).toBe('my_sandbox_1');
    expect(sandboxDbName('already_ok_9')).toBe('already_ok_9');
    expect(sandboxDbName('ü-x')).toBe('__x');
  });
});

// ── ServiceManager env assembly through the public API, with fakes (no Docker, no DB, no exec) ──

const service = (id: string, kind: ServiceKind, extra: Partial<ServiceRecord> = {}): ServiceRecord => ({
  id,
  kind,
  mode: 'managed',
  attach: 'all',
  createdAt: '2026-01-01T00:00:00Z',
  adminPassword: 'admin',
  ...extra,
});

const db = (name: string, password = 'pw', error?: string): SandboxServiceDb => ({ name, password, ...(error ? { error } : {}) });

function setup(services: ServiceRecord[], sandbox: Partial<SandboxRecord> & { id: string }) {
  const sandboxes = new Map<string, SandboxRecord>([[sandbox.id, { status: 'stopped', network: 'open', proxyToken: 'tok', ...sandbox } as SandboxRecord]]);
  const byId = new Map(services.map((s) => [s.id, s]));
  const store = {
    services: () => [...byId.values()],
    service: (id: string) => byId.get(id),
    sandboxes: () => [...sandboxes.values()],
  } as unknown as Store;
  const exec = vi.fn(async (_id: string, _cmd: string[], _opts: { env: Record<string, string> }) => ({ exitCode: 0, stdout: '', stderr: '' }));
  const sh = vi.fn(async (_id: string, _script: string, _env: Record<string, string>) => ({ exitCode: 0, stdout: '', stderr: '' }));
  const sandboxManager = {
    addHooks: vi.fn(),
    record: (id: string) => {
      const record = sandboxes.get(id);
      if (!record) throw new Error(`no sandbox ${id}`);
      return record;
    },
    update: (id: string, patch: Partial<SandboxRecord>) => sandboxes.set(id, { ...sandboxes.get(id)!, ...patch }),
    exec,
    sh,
  } as unknown as SandboxManager;
  const egress = {
    setRelaySource: vi.fn(),
    writePolicy: vi.fn(),
    noProxy: (_record: unknown, extra: string[] = []) => [...new Set(['localhost', '127.0.0.1', 'cocoon-proxy', ...extra])].join(','),
  } as unknown as EgressManager;
  const bus = { publish: vi.fn() } as unknown as EventBus;
  const log = vi.fn();
  // A plain object is not a DockerDriver: managed services can't be started, nothing touches Docker.
  const manager = new ServiceManager({} as SandboxDriver, store, bus, sandboxManager, egress, log);
  return { manager, exec, sh, log };
}

describe('ServiceManager env assembly', () => {
  it('gives the first service of each kind the standard names and every service COCOON_<ID>_URL', async () => {
    const { manager } = setup([service('postgres', 'postgres'), service('pg-2', 'postgres'), service('cache', 'redis')], {
      id: 'sb-1',
      services: ['postgres', 'pg-2', 'cache'],
      serviceDbs: { postgres: db('sb_1', 'a'), 'pg-2': db('sb_1', 'b'), cache: db('sb_1', 'c') },
    });
    const env = await manager.agentEnv('sb-1');
    expect(env).toEqual({
      DATABASE_URL: 'postgresql://sb_1:a@postgres:5432/sb_1',
      POSTGRES_URL: 'postgresql://sb_1:a@postgres:5432/sb_1',
      PGHOST: 'postgres',
      PGPORT: '5432',
      PGUSER: 'sb_1',
      PGPASSWORD: 'a',
      PGDATABASE: 'sb_1',
      COCOON_POSTGRES_URL: 'postgresql://sb_1:a@postgres:5432/sb_1',
      COCOON_PG_2_URL: 'postgresql://sb_1:b@pg-2:5432/sb_1',
      REDIS_URL: 'redis://sb_1:c@cache:6379',
      REDIS_KEY_PREFIX: 'sb_1:',
      COCOON_CACHE_URL: 'redis://sb_1:c@cache:6379',
    });
  });

  it('DATABASE_URL prefers postgres over mysql regardless of attach order', async () => {
    const { manager } = setup([service('mysql', 'mysql'), service('postgres', 'postgres')], {
      id: 'sb-1',
      services: ['mysql', 'postgres'],
      serviceDbs: { mysql: db('sb_1'), postgres: db('sb_1') },
    });
    const env = await manager.agentEnv('sb-1');
    expect(env.DATABASE_URL).toBe('postgresql://sb_1:pw@postgres:5432/sb_1');
    expect(env.MYSQL_URL).toBe('mysql://sb_1:pw@mysql:3306/sb_1');
    expect(env.COCOON_MYSQL_URL).toBe(env.MYSQL_URL);
  });

  it('DATABASE_URL falls back to mysql and is not set for other kinds', async () => {
    const mysqlOnly = setup([service('mysql', 'mysql')], { id: 's', services: ['mysql'], serviceDbs: { mysql: db('s') } });
    expect((await mysqlOnly.manager.agentEnv('s')).DATABASE_URL).toBe('mysql://s:pw@mysql:3306/s');
    const mongoOnly = setup([service('mongodb', 'mongodb')], { id: 's', services: ['mongodb'], serviceDbs: { mongodb: db('s') } });
    expect(await mongoOnly.manager.agentEnv('s')).not.toHaveProperty('DATABASE_URL');
  });

  it('resolves service addresses and keeps NO_PROXY out of per-service env and open sandboxes', async () => {
    const services = [service('postgres', 'postgres'), service('mocks', 'wiremock'), service('ext', 'postgres', { mode: 'external', host: 'db.corp', port: 5433 })];
    const serviceDbs = { postgres: db('s'), mocks: db('s'), ext: db('s') };
    const egress = setup(services, { id: 's', network: 'egress', services: ['postgres', 'mocks', 'ext'], serviceDbs });
    const connections = egress.manager.connections('s');
    expect(connections.map((c) => [c.serviceId, c.host, c.port])).toEqual([
      ['postgres', 'postgres', 5432],
      ['mocks', 'mocks', 8080],
      ['ext', 'db.corp', 5433], // without Docker (bubblewrap) external servers are reached directly
    ]);
    // per-service env never contains NO_PROXY
    for (const c of connections) expect(c.env).not.toHaveProperty('NO_PROXY');

    const open = setup(services, { id: 's', network: 'open', services: ['postgres', 'mocks'], serviceDbs });
    expect(await open.manager.agentEnv('s')).not.toHaveProperty('NO_PROXY');
  });

  it('agentEnv sets NO_PROXY and no_proxy with the managed service hosts on egress sandboxes', async () => {
    const { manager } = setup([service('postgres', 'postgres'), service('mail', 'mailpit')], {
      id: 's',
      network: 'egress',
      services: ['postgres', 'mail'],
      serviceDbs: { postgres: db('s'), mail: db('s') },
    });
    const env = await manager.agentEnv('s');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,cocoon-proxy,postgres,mail');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it('skips services whose provisioning failed and services that no longer exist', async () => {
    const { manager } = setup([service('postgres', 'postgres'), service('pg-2', 'postgres')], {
      id: 's',
      services: ['postgres', 'pg-2', 'gone'],
      serviceDbs: { postgres: db('s', 'pw', 'connection refused'), 'pg-2': db('s'), gone: db('s') },
    });
    const conns = manager.connections('s');
    expect(conns.map((c) => c.serviceId)).toEqual(['postgres', 'pg-2']);
    expect(conns[0]!.error).toBe('connection refused');
    expect(conns[0]!.env).toEqual({});
    // the failed service doesn't count as "first postgres": pg-2 gets the standard names
    expect(conns[1]!.env).toMatchObject({ DATABASE_URL: 'postgresql://s:pw@pg-2:5432/s', PGHOST: 'pg-2', COCOON_PG_2_URL: 'postgresql://s:pw@pg-2:5432/s' });
  });

  it('connections() report the per-service env, credentials only for database kinds', () => {
    const { manager } = setup([service('postgres', 'postgres'), service('pg-2', 'postgres'), service('mocks', 'wiremock', { label: 'API mocks' })], {
      id: 's',
      services: ['postgres', 'pg-2', 'mocks'],
      serviceDbs: { postgres: db('s', 'one'), 'pg-2': db('s', 'two'), mocks: db('s', 'three') },
    });
    const [first, second, mocks] = manager.connections('s');
    expect(first).toMatchObject({ serviceId: 'postgres', kind: 'postgres', label: 'PostgreSQL', database: 's', user: 's', password: 'one' });
    expect(first!.env).toMatchObject({ DATABASE_URL: first!.url, PGPASSWORD: 'one', COCOON_POSTGRES_URL: first!.url });
    // the second postgres only gets its own COCOON_ var
    expect(second!.env).toEqual({ COCOON_PG_2_URL: 'postgresql://s:two@pg-2:5432/s' });
    expect(mocks).toMatchObject({ label: 'API mocks', url: 'http://mocks:8080/s', password: undefined });
  });

  it('agentEnv returns {} for sandboxes without services', async () => {
    const { manager } = setup([service('postgres', 'postgres')], { id: 's' });
    expect(await manager.agentEnv('s')).toEqual({});
    expect(manager.connections('s')).toEqual([]);
  });

  it('writes services.env and agent instructions into running sandboxes', async () => {
    const { manager, exec, sh } = setup([service('postgres', 'postgres'), service('pg-2', 'postgres')], {
      id: 's',
      status: 'running',
      services: ['postgres', 'pg-2'],
      serviceDbs: { postgres: db('s', "it's"), 'pg-2': db('s') },
    });
    await manager.agentEnv('s');
    expect(exec).toHaveBeenCalledTimes(1);
    const [, cmd, opts] = exec.mock.calls[0]!;
    expect(cmd.join(' ')).toContain(SERVICES_ENV_FILE);
    const envFile = opts.env.CONTENT!;
    expect(envFile).toContain("export PGPASSWORD='it'\\''s'\n");
    expect(envFile).toContain("export COCOON_PG_2_URL='postgresql://s:pw@pg-2:5432/s'\n");

    const notes = sh.mock.calls[0]![2].NOTES!;
    expect(sh).toHaveBeenCalledTimes(1);
    expect(notes.startsWith('## Shared test services')).toBe(true);
    expect(notes).toContain('`$DATABASE_URL`'); // first postgres: standard name
    expect(notes).toContain('`$COCOON_PG_2_URL`'); // second: its own var
    expect(notes).not.toContain("it's"); // no credentials in the instructions
  });
});
