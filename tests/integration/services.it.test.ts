import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_IMAGE } from './global-setup.ts';
import { available, createSandbox, docker, instance, rpc, sh, waitFor } from './harness.ts';

const svcContainer = (id: string) => `cocoon-svc-${instance}-${id}`;
const status = async (id: string) => (await rpc('services.list')).find((s: { id: string }) => s.id === id)?.status;

describe.runIf(available)('shared services', () => {
  let sandboxId: string;
  let dbName: string;

  beforeAll(async () => {
    for (const kind of ['postgres', 'redis', 'wiremock']) await rpc('services.add', { kind });
    for (const id of ['postgres', 'redis', 'wiremock']) await waitFor(`${id} running`, async () => (await status(id)) === 'running', 600_000, 2000);
    // psql and redis-cli come with the "db" image variant (built by the global setup).
    const sb = await rpc('sandbox.create', { name: `svc-${Math.random().toString(16).slice(2, 6)}`, network: 'egress', image: DB_IMAGE });
    sandboxId = sb.id;
    dbName = sandboxId.toLowerCase();
    expect(sb.services.sort()).toEqual(['postgres', 'redis', 'wiremock']);
  });
  afterAll(async () => {
    if (sandboxId) await rpc('sandbox.delete', { sandboxId }).catch(() => undefined);
  });

  it('hands out connections with the sandbox’s own database and user', async () => {
    const conns = await rpc('services.connections', { sandboxId });
    const pg = conns.find((c: { serviceId: string }) => c.serviceId === 'postgres');
    expect(pg.database).toBe(dbName);
    expect(pg.user).toBe(dbName);
    expect(pg.host).toBe('postgres');
    expect(pg.env.DATABASE_URL).toBe(pg.url);
    expect(conns.find((c: { serviceId: string }) => c.serviceId === 'wiremock').env.MOCK_API_URL).toBe(`http://wiremock:8080/${dbName}`);
  });

  it('PostgreSQL: the sandbox may create schemas and test databases, but nothing elsewhere', async () => {
    const res = await sh(sandboxId, `psql -v ON_ERROR_STOP=1 -qAt -c "CREATE SCHEMA shop; CREATE TABLE shop.items(id int); INSERT INTO shop.items VALUES (1); SELECT count(*) FROM shop.items;" -c "CREATE DATABASE ${dbName}_test;"`);
    expect(res.stderr).toBe('');
    expect(res.stdout.trim()).toBe('1');
    const foreign = await sh(sandboxId, 'psql -qAt -d postgres -c "CREATE TABLE foreign_table(i int)"');
    expect(foreign.exitCode).not.toBe(0);
    expect(foreign.stderr).toMatch(/permission denied/);
  });

  it('Redis: keys only with the sandbox prefix, no admin commands', async () => {
    const res = await sh(sandboxId, 'redis-cli -u "$REDIS_URL" --no-auth-warning SET "${REDIS_KEY_PREFIX}k" v 2>&1; redis-cli -u "$REDIS_URL" --no-auth-warning SET other v 2>&1; redis-cli -u "$REDIS_URL" --no-auth-warning FLUSHALL 2>&1');
    const lines = res.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('OK');
    expect(lines[1]).toMatch(/NOPERM/);
    expect(lines[2]).toMatch(/NOPERM/);
  });

  it('WireMock: stubs under the sandbox prefix answer, through NO_PROXY in a restricted sandbox', async () => {
    const res = await sh(
      sandboxId,
      `curl -s -o /dev/null -w "%{http_code}\\n" -X POST "$WIREMOCK_ADMIN_URL/mappings" -d '{"request":{"method":"GET","urlPath":"'"$MOCK_API_PREFIX"'/users/1"},"response":{"status":200,"jsonBody":{"name":"Ada"}}}' && curl -s "$MOCK_API_URL/users/1"`,
    );
    expect(res.stdout).toContain('201');
    expect(res.stdout).toContain('"name":"Ada"');
  });

  it('agents get the env vars and a services note', async () => {
    const agent = await rpc('agent.spawn', { sandboxId, kind: 'shell' });
    await rpc('agent.send_input', { agentId: agent.id, text: 'echo "db=${PGDATABASE} mock=${MOCK_API_PREFIX}"' });
    await waitFor('agent env', async () => (await rpc('agent.read', { agentId: agent.id, lines: 30 })).text.includes(`db=${dbName} mock=/${dbName}`));
    await rpc('agent.kill', { agentId: agent.id });
    expect((await sh(sandboxId, 'cat ~/.claude/CLAUDE.md')).stdout).toContain('Shared test services');
  });

  it('reset empties the sandbox database (same credentials)', async () => {
    await rpc('services.reset', { sandboxId, serviceId: 'postgres' });
    const res = await sh(sandboxId, `psql -qAt -c "SELECT count(*) FROM information_schema.schemata WHERE schema_name='shop'"; psql -qAt -d postgres -c "SELECT count(*) FROM pg_database WHERE datname='${dbName}_test'"`);
    expect(res.stdout.trim().split('\n')).toEqual(['0', '0']);
  });

  it('deleting the sandbox drops its role, databases and stubs', async () => {
    await rpc('sandbox.delete', { sandboxId });
    const roles = docker('exec', svcContainer('postgres'), 'psql', '-U', 'postgres', '-qAt', '-c', `SELECT count(*) FROM pg_roles WHERE rolname='${dbName}'`);
    expect(roles.trim()).toBe('0');
    const creds = await rpc('services.credentials', { serviceId: 'wiremock' });
    const mappings = (await (await fetch(creds.url + '/mappings')).json()) as { mappings: { request: { urlPath?: string } }[] };
    expect(mappings.mappings.filter((m) => m.request.urlPath?.startsWith(`/${dbName}`))).toEqual([]);
    sandboxId = '';
  });

  it('pauses unused services and wakes them on demand', async () => {
    // COCOON_SERVICE_IDLE_MINUTES=0.1 in the test server: no running sandbox uses the services any more.
    await waitFor('redis paused', async () => (await status('redis')) === 'idle', 90_000, 2000);
    const sb = await rpc('sandbox.create', { name: `wake-${Math.random().toString(16).slice(2, 6)}`, network: 'egress', services: ['redis'], image: DB_IMAGE });
    try {
      expect(await status('redis')).toBe('running');
      const res = await sh(sb.id, 'redis-cli -u "$REDIS_URL" --no-auth-warning PING');
      expect(res.stdout.trim()).toBe('PONG');
    } finally {
      await rpc('sandbox.delete', { sandboxId: sb.id });
    }
  });
});
