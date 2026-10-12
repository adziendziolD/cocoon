import { describe, expect, it } from 'vitest';
import { SERVICE_KINDS, ServiceKind } from '@cocoon/protocol';
import { ENGINES, type SandboxConn } from './engines.ts';

const conn = (overrides: Partial<SandboxConn> = {}): SandboxConn => ({ host: 'postgres', port: 5432, name: 'sb_abc123', password: 's3cret', ...overrides });

// A password that needs URL encoding: reserved URL characters, space, percent and non-ASCII.
const NASTY = 'p@ss:w/rd?#% ü&=+';
const NASTY_ENCODED = encodeURIComponent(NASTY);

describe('ENGINES', () => {
  it('has an engine for every service kind', () => {
    expect(Object.keys(ENGINES).sort()).toEqual([...ServiceKind.options].sort());
  });

  it.each(ServiceKind.options)('%s: connection env covers the vars documented in SERVICE_KINDS (except DATABASE_URL)', (kind) => {
    const port = SERVICE_KINDS[kind].port;
    const { env } = ENGINES[kind].connection(conn({ host: kind, port }));
    const documented = SERVICE_KINDS[kind].env.filter((name) => name !== 'DATABASE_URL');
    expect(Object.keys(env).sort()).toEqual([...documented].sort());
  });

  it.each(ServiceKind.options)('%s: instructions mention the given env var', (kind) => {
    const text = ENGINES[kind].instructions(conn({ host: kind, port: SERVICE_KINDS[kind].port }), 'COCOON_MY_SVC_URL');
    expect(text).toContain('`$COCOON_MY_SVC_URL`');
    expect(text.startsWith('- **')).toBe(true);
    expect(text).not.toContain('s3cret');
  });

  it.each(ServiceKind.options)('%s: container publishes the kind\'s main port first', (kind) => {
    const spec = ENGINES[kind].container('admin-pw');
    expect(spec.ports[0]).toBe(SERVICE_KINDS[kind].port);
    expect(spec.dataPath).toMatch(/^\//);
  });
});

describe('postgres', () => {
  const pg = ENGINES.postgres;

  it('builds URL, libpq env and database/user', () => {
    expect(pg.connection(conn())).toEqual({
      url: 'postgresql://sb_abc123:s3cret@postgres:5432/sb_abc123',
      database: 'sb_abc123',
      user: 'sb_abc123',
      env: {
        POSTGRES_URL: 'postgresql://sb_abc123:s3cret@postgres:5432/sb_abc123',
        PGHOST: 'postgres',
        PGPORT: '5432',
        PGUSER: 'sb_abc123',
        PGPASSWORD: 's3cret',
        PGDATABASE: 'sb_abc123',
      },
    });
  });

  it('URL-encodes the password in the URL only and requires TLS when configured', () => {
    const built = pg.connection(conn({ password: NASTY, tls: true, host: 'db.example.com', port: 6543 }));
    expect(built.url).toBe(`postgresql://sb_abc123:${NASTY_ENCODED}@db.example.com:6543/sb_abc123?sslmode=require`);
    expect(built.env.PGPASSWORD).toBe(NASTY);
    expect(new URL(built.url).password).toBe(NASTY_ENCODED);
    expect(decodeURIComponent(new URL(built.url).password)).toBe(NASTY);
  });

  it('instructions name the database and psql env', () => {
    const text = pg.instructions(conn(), 'DATABASE_URL');
    expect(text).toContain('$DATABASE_URL');
    expect(text).toContain('`sb_abc123`');
    expect(text).toContain('PGHOST');
  });

  it('container sets the admin password and data path', () => {
    expect(pg.container('pw')).toEqual({ env: { POSTGRES_PASSWORD: 'pw' }, dataPath: '/var/lib/postgresql/data', ports: [5432] });
  });
});

describe('mysql', () => {
  const my = ENGINES.mysql;

  it('builds URL and MYSQL_* env with an encoded password', () => {
    const built = my.connection(conn({ host: 'mysql', port: 3306, password: NASTY }));
    expect(built.url).toBe(`mysql://sb_abc123:${NASTY_ENCODED}@mysql:3306/sb_abc123`);
    expect(built).toMatchObject({ database: 'sb_abc123', user: 'sb_abc123' });
    expect(built.env).toEqual({
      MYSQL_URL: built.url,
      MYSQL_HOST: 'mysql',
      MYSQL_PORT: '3306',
      MYSQL_USER: 'sb_abc123',
      MYSQL_PASSWORD: NASTY,
      MYSQL_DATABASE: 'sb_abc123',
    });
  });

  it('instructions mention the extra-database prefix', () => {
    expect(my.instructions(conn(), 'MYSQL_URL')).toContain('`sb_abc123_…`');
  });

  it('container sets both MariaDB and MySQL root passwords', () => {
    expect(my.container('pw')).toEqual({ env: { MARIADB_ROOT_PASSWORD: 'pw', MYSQL_ROOT_PASSWORD: 'pw' }, dataPath: '/var/lib/mysql', ports: [3306] });
  });
});

describe('mongodb', () => {
  const mongo = ENGINES.mongodb;

  it('authenticates against the own database and adds tls when configured', () => {
    expect(mongo.connection(conn({ host: 'mongodb', port: 27017 }))).toEqual({
      url: 'mongodb://sb_abc123:s3cret@mongodb:27017/sb_abc123?authSource=sb_abc123',
      database: 'sb_abc123',
      user: 'sb_abc123',
      env: {
        MONGODB_URI: 'mongodb://sb_abc123:s3cret@mongodb:27017/sb_abc123?authSource=sb_abc123',
        MONGO_URL: 'mongodb://sb_abc123:s3cret@mongodb:27017/sb_abc123?authSource=sb_abc123',
      },
    });
    const tls = mongo.connection(conn({ host: 'm', port: 1, password: NASTY, tls: true }));
    expect(tls.url).toBe(`mongodb://sb_abc123:${NASTY_ENCODED}@m:1/sb_abc123?authSource=sb_abc123&tls=true`);
  });

  it('container creates the root user', () => {
    expect(mongo.container('pw')).toEqual({ env: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'pw' }, dataPath: '/data/db', ports: [27017] });
  });
});

describe('redis', () => {
  const redis = ENGINES.redis;

  it('uses the sandbox user and a key prefix; rediss:// with TLS', () => {
    expect(redis.connection(conn({ host: 'redis', port: 6379, password: NASTY }))).toEqual({
      url: `redis://sb_abc123:${NASTY_ENCODED}@redis:6379`,
      user: 'sb_abc123',
      env: { REDIS_URL: `redis://sb_abc123:${NASTY_ENCODED}@redis:6379`, REDIS_KEY_PREFIX: 'sb_abc123:' },
    });
    expect(redis.connection(conn({ tls: true })).url.startsWith('rediss://')).toBe(true);
  });

  it('instructions mention the key prefix', () => {
    expect(redis.instructions(conn(), 'REDIS_URL')).toContain('`sb_abc123:`');
  });

  it('container passes the password on the command line with persistence', () => {
    expect(redis.container('pw')).toEqual({ env: {}, cmd: ['redis-server', '--requirepass', 'pw', '--appendonly', 'yes'], dataPath: '/data', ports: [6379] });
  });
});

describe('wiremock', () => {
  const wm = ENGINES.wiremock;

  it('gives every sandbox its own URL prefix and no credentials', () => {
    const built = wm.connection(conn({ host: 'wiremock', port: 8080 }));
    expect(built).toEqual({
      url: 'http://wiremock:8080/sb_abc123',
      env: {
        MOCK_API_URL: 'http://wiremock:8080/sb_abc123',
        WIREMOCK_URL: 'http://wiremock:8080',
        WIREMOCK_ADMIN_URL: 'http://wiremock:8080/__admin',
        MOCK_API_PREFIX: '/sb_abc123',
      },
    });
    expect(JSON.stringify(built)).not.toContain('s3cret');
  });

  it('instructions show a stub under the prefix', () => {
    expect(wm.instructions(conn(), 'MOCK_API_URL')).toContain('"urlPath":"/sb_abc123/users/1"');
  });

  it('container stores mappings under /home/wiremock', () => {
    expect(wm.container('pw')).toMatchObject({ dataPath: '/home/wiremock', ports: [8080] });
  });
});

describe('mailpit', () => {
  const mp = ENGINES.mailpit;

  it('builds SMTP and API URLs, using the mapped web port when given', () => {
    expect(mp.connection(conn({ host: 'mailpit', port: 1025 }))).toEqual({
      url: 'smtp://mailpit:1025',
      env: { SMTP_HOST: 'mailpit', SMTP_PORT: '1025', SMTP_URL: 'smtp://mailpit:1025', MAILPIT_API_URL: 'http://mailpit:8025/api/v1' },
    });
    expect(mp.connection(conn({ host: '127.0.0.1', port: 31025, ports: { 8025: 38025 } })).env.MAILPIT_API_URL).toBe('http://127.0.0.1:38025/api/v1');
  });

  it('container publishes SMTP and web ports and keeps its database in /data', () => {
    const spec = mp.container('pw');
    expect(spec.ports).toEqual([1025, 8025]);
    expect(spec.dataPath).toBe('/data');
    expect(spec.env.MP_DATABASE).toBe('/data/mailpit.db');
  });
});
