import { MongoClient } from 'mongodb';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { createClient } from 'redis';
import type { ServiceKind } from '@cocoon/protocol';

/** How the CoCoon server reaches a service with admin rights. */
export interface AdminConn {
  host: string;
  port: number;
  user?: string;
  password?: string;
  tls?: boolean;
  /** Further published ports (e.g. Mailpit's web port), by container port. */
  ports?: Record<number, number>;
}

/** What a sandbox gets: address as seen from inside the sandbox plus its own credentials. */
export interface SandboxConn {
  host: string;
  port: number;
  /** Database / user / key prefix name (identifier-safe: [a-z0-9_]). */
  name: string;
  password: string;
  tls?: boolean;
  /** Further ports inside the sandbox's view, by container port. */
  ports?: Record<number, number>;
}

export interface ContainerSpec {
  env: Record<string, string>;
  cmd?: string[];
  dataPath: string;
  /** Container ports to publish on 127.0.0.1 (the first is the main port). */
  ports: number[];
}

export interface Engine {
  container(adminPassword: string): ContainerSpec;
  /** Returns the server version; throws if not reachable. */
  test(admin: AdminConn): Promise<string>;
  /** Creates (or updates the password of) the sandbox's own database/user. Idempotent. */
  provision(admin: AdminConn, name: string, password: string): Promise<void>;
  /** Drops everything the sandbox owns on this service. Idempotent. */
  deprovision(admin: AdminConn, name: string): Promise<void>;
  /** Empties the sandbox's data but keeps its credentials. */
  reset(admin: AdminConn, name: string, password: string): Promise<void>;
  connection(conn: SandboxConn): { url: string; database?: string; user?: string; env: Record<string, string> };
  /** One markdown line for the agent instructions. */
  instructions(conn: SandboxConn, envName: string): string;
  /** The sandbox users do not survive a restart of the service (they are not persisted), so they are provisioned again. */
  volatileUsers?: boolean;
}

const enc = encodeURIComponent;
const TIMEOUT_MS = 5000;

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const pgLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function withPg<T>(admin: AdminConn, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    host: admin.host,
    port: admin.port,
    user: admin.user,
    password: admin.password,
    database: 'postgres',
    ssl: admin.tls ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: TIMEOUT_MS,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function pgDropDatabases(client: pg.Client, name: string): Promise<void> {
  const owned = await client.query<{ datname: string }>(
    'SELECT d.datname FROM pg_database d JOIN pg_roles r ON d.datdba = r.oid WHERE r.rolname = $1',
    [name],
  );
  for (const { datname } of owned.rows) await client.query(`DROP DATABASE IF EXISTS ${pgIdent(datname)} WITH (FORCE)`);
}

const postgres: Engine = {
  container: (password) => ({ env: { POSTGRES_PASSWORD: password }, dataPath: '/var/lib/postgresql/data', ports: [5432] }),
  test: (admin) => withPg(admin, async (c) => `PostgreSQL ${(await c.query<{ server_version: string }>('SHOW server_version')).rows[0]?.server_version ?? ''}`.trim()),
  provision: (admin, name, password) =>
    withPg(admin, async (c) => {
      const role = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
      // CREATEDB: test runners (Django, Rails, …) create and drop their own test databases.
      await c.query(`${role.rowCount ? 'ALTER' : 'CREATE'} ROLE ${pgIdent(name)} LOGIN CREATEDB PASSWORD ${pgLiteral(password)}`);
      const db = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (!db.rowCount) await c.query(`CREATE DATABASE ${pgIdent(name)} OWNER ${pgIdent(name)}`);
      await c.query(`REVOKE ALL ON DATABASE ${pgIdent(name)} FROM PUBLIC`);
    }),
  deprovision: (admin, name) =>
    withPg(admin, async (c) => {
      const role = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
      if (!role.rowCount) return;
      await pgDropDatabases(c, name);
      await c.query(`DROP OWNED BY ${pgIdent(name)}`);
      await c.query(`DROP ROLE IF EXISTS ${pgIdent(name)}`);
    }),
  reset: async (admin, name, password) => {
    await withPg(admin, (c) => pgDropDatabases(c, name));
    await postgres.provision(admin, name, password);
  },
  connection: ({ host, port, name, password, tls }) => {
    const url = `postgresql://${name}:${enc(password)}@${host}:${port}/${name}${tls ? '?sslmode=require' : ''}`;
    return {
      url,
      database: name,
      user: name,
      env: { POSTGRES_URL: url, PGHOST: host, PGPORT: String(port), PGUSER: name, PGPASSWORD: password, PGDATABASE: name },
    };
  },
  instructions: ({ name }, envName) =>
    `- **PostgreSQL** – \`$${envName}\` (also \`PGHOST\`/\`PGUSER\`/\`PGPASSWORD\`/\`PGDATABASE\`, so \`psql\` works without arguments). You own the database \`${name}\`: create schemas and tables freely; you may also create extra databases for tests.`,
};

// ── MySQL / MariaDB ───────────────────────────────────────────────────────────
async function withMysql<T>(admin: AdminConn, fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({
    host: admin.host,
    port: admin.port,
    user: admin.user,
    password: admin.password,
    ssl: admin.tls ? { rejectUnauthorized: false } : undefined,
    connectTimeout: TIMEOUT_MS,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function mysqlDropDatabases(c: mysql.Connection, name: string): Promise<void> {
  const [rows] = await c.query<mysql.RowDataPacket[]>('SHOW DATABASES');
  for (const row of rows) {
    const db = String(Object.values(row)[0]);
    if (db === name || db.startsWith(`${name}_`)) await c.query(`DROP DATABASE IF EXISTS \`${db}\``);
  }
}

const mysqlEngine: Engine = {
  container: (password) => ({
    env: { MARIADB_ROOT_PASSWORD: password, MYSQL_ROOT_PASSWORD: password },
    dataPath: '/var/lib/mysql',
    ports: [3306],
  }),
  test: (admin) =>
    withMysql(admin, async (c) => {
      const [rows] = await c.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v');
      const version = String(rows[0]?.v ?? '');
      return `${/mariadb/i.test(version) ? 'MariaDB' : 'MySQL'} ${version.split('-')[0]}`;
    }),
  provision: (admin, name, password) =>
    withMysql(admin, async (c) => {
      await c.query(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
      await c.query(`CREATE USER IF NOT EXISTS '${name}'@'%' IDENTIFIED BY ?`, [password]);
      await c.query(`ALTER USER '${name}'@'%' IDENTIFIED BY ?`, [password]);
      await c.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${name}'@'%'`);
      // Extra databases for tests: anything prefixed with the sandbox name.
      await c.query(`GRANT ALL PRIVILEGES ON \`${name.replace(/_/g, '\\_')}\\_%\`.* TO '${name}'@'%'`);
    }),
  deprovision: (admin, name) =>
    withMysql(admin, async (c) => {
      await mysqlDropDatabases(c, name);
      await c.query(`DROP USER IF EXISTS '${name}'@'%'`);
    }),
  reset: async (admin, name, password) => {
    await withMysql(admin, (c) => mysqlDropDatabases(c, name));
    await mysqlEngine.provision(admin, name, password);
  },
  connection: ({ host, port, name, password }) => {
    const url = `mysql://${name}:${enc(password)}@${host}:${port}/${name}`;
    return {
      url,
      database: name,
      user: name,
      env: { MYSQL_URL: url, MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_USER: name, MYSQL_PASSWORD: password, MYSQL_DATABASE: name },
    };
  },
  instructions: ({ name }, envName) =>
    `- **MySQL/MariaDB** – \`$${envName}\` (also \`MYSQL_HOST\`/\`MYSQL_USER\`/\`MYSQL_PASSWORD\`/\`MYSQL_DATABASE\`). You own the database \`${name}\` and may create more databases named \`${name}_…\` (e.g. for tests).`,
};

// ── MongoDB ───────────────────────────────────────────────────────────────────
async function withMongo<T>(admin: AdminConn, fn: (client: MongoClient) => Promise<T>): Promise<T> {
  const auth = admin.user ? `${enc(admin.user)}:${enc(admin.password ?? '')}@` : '';
  const client = new MongoClient(`mongodb://${auth}${admin.host}:${admin.port}/?authSource=admin&directConnection=true`, {
    serverSelectionTimeoutMS: TIMEOUT_MS,
    tls: admin.tls,
    tlsAllowInvalidCertificates: admin.tls,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

const mongodb: Engine = {
  container: (password) => ({
    env: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: password },
    dataPath: '/data/db',
    ports: [27017],
  }),
  test: (admin) => withMongo(admin, async (c) => `MongoDB ${(await c.db('admin').command({ buildInfo: 1 })).version as string}`),
  provision: (admin, name, password) =>
    withMongo(admin, async (c) => {
      const db = c.db(name);
      const existing = (await db.command({ usersInfo: name })) as { users: unknown[] };
      if (existing.users.length) await db.command({ updateUser: name, pwd: password });
      else await db.command({ createUser: name, pwd: password, roles: [{ role: 'dbOwner', db: name }] });
    }),
  deprovision: (admin, name) =>
    withMongo(admin, async (c) => {
      const db = c.db(name);
      await db.dropDatabase();
      const existing = (await db.command({ usersInfo: name })) as { users: unknown[] };
      if (existing.users.length) await db.command({ dropUser: name });
    }),
  // Users live in the database itself; dropDatabase keeps them in admin.system.users.
  reset: (admin, name) => withMongo(admin, async (c) => void (await c.db(name).dropDatabase())),
  connection: ({ host, port, name, password, tls }) => {
    const url = `mongodb://${name}:${enc(password)}@${host}:${port}/${name}?authSource=${name}${tls ? '&tls=true' : ''}`;
    return { url, database: name, user: name, env: { MONGODB_URI: url, MONGO_URL: url } };
  },
  instructions: ({ name }, envName) =>
    `- **MongoDB** – \`$${envName}\` (also \`MONGO_URL\`). You own the database \`${name}\` (role dbOwner): create collections and indexes freely.`,
};

// ── Redis ─────────────────────────────────────────────────────────────────────
async function withRedis<T>(admin: AdminConn, fn: (client: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const client = createClient({
    socket: { host: admin.host, port: admin.port, tls: admin.tls || undefined, connectTimeout: TIMEOUT_MS, reconnectStrategy: false },
    username: admin.user && admin.user !== 'default' ? admin.user : undefined,
    password: admin.password || undefined,
  } as Parameters<typeof createClient>[0]);
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.quit().catch(() => client.disconnect().catch(() => undefined));
  }
}

async function redisDeleteKeys(client: ReturnType<typeof createClient>, prefix: string): Promise<void> {
  let cursor = '0';
  do {
    const reply = (await client.sendCommand(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '500'])) as [string, string[]];
    cursor = String(reply[0]);
    if (reply[1].length) await client.sendCommand(['UNLINK', ...reply[1]]);
  } while (cursor !== '0');
}

const redis: Engine = {
  // ACL users are created at runtime and are not part of the AOF: after a restart only the default user exists.
  volatileUsers: true,
  container: (password) => ({ env: {}, cmd: ['redis-server', '--requirepass', password, '--appendonly', 'yes'], dataPath: '/data', ports: [6379] }),
  test: (admin) =>
    withRedis(admin, async (c) => {
      const info = String(await c.sendCommand(['INFO', 'server']));
      return `Redis ${/redis_version:([^\r\n]+)/.exec(info)?.[1] ?? ''}`.trim();
    }),
  provision: (admin, name, password) =>
    withRedis(admin, async (c) => {
      await c.sendCommand(['ACL', 'SETUSER', name, 'reset', 'on', `>${password}`, `~${name}:*`, `&${name}:*`, '+@all', '-@admin', '-@dangerous']);
    }),
  deprovision: (admin, name) =>
    withRedis(admin, async (c) => {
      await c.sendCommand(['ACL', 'DELUSER', name]);
      await redisDeleteKeys(c, `${name}:`);
    }),
  reset: (admin, name) => withRedis(admin, (c) => redisDeleteKeys(c, `${name}:`)),
  connection: ({ host, port, name, password, tls }) => {
    const url = `${tls ? 'rediss' : 'redis'}://${name}:${enc(password)}@${host}:${port}`;
    return { url, user: name, env: { REDIS_URL: url, REDIS_KEY_PREFIX: `${name}:` } };
  },
  instructions: ({ name }, envName) =>
    `- **Redis** – \`$${envName}\`. Your user may only use keys and channels starting with \`${name}:\` (\`$REDIS_KEY_PREFIX\`); configure your client's key prefix accordingly.`,
};

// ── WireMock ──────────────────────────────────────────────────────────────────
async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

interface WireMockMapping {
  id: string;
  request?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

async function wiremockRemoveStubs(admin: AdminConn, name: string): Promise<void> {
  const base = `http://${admin.host}:${admin.port}/__admin`;
  const { mappings } = await http<{ mappings: WireMockMapping[] }>(`${base}/mappings`);
  const prefix = `/${name}`;
  const owned = mappings.filter((m) => {
    if (m.metadata?.cocoonSandbox === name) return true;
    return ['url', 'urlPath', 'urlPattern', 'urlPathPattern', 'urlPathTemplate'].some((key) => {
      const value = m.request?.[key];
      return typeof value === 'string' && value.replace(/^\^/, '').startsWith(prefix);
    });
  });
  for (const m of owned) await http(`${base}/mappings/${m.id}`, { method: 'DELETE' });
}

const wiremock: Engine = {
  container: () => ({ env: {}, cmd: ['--disable-banner', '--global-response-templating'], dataPath: '/home/wiremock', ports: [8080] }),
  test: async (admin) => {
    const health = await http<{ version?: string }>(`http://${admin.host}:${admin.port}/__admin/health`).catch(async () => {
      await http(`http://${admin.host}:${admin.port}/__admin/mappings?limit=1`);
      return {} as { version?: string };
    });
    return `WireMock ${health?.version ?? ''}`.trim();
  },
  provision: async () => undefined,
  deprovision: (admin, name) => wiremockRemoveStubs(admin, name),
  reset: (admin, name) => wiremockRemoveStubs(admin, name),
  connection: ({ host, port, name }) => {
    const base = `http://${host}:${port}`;
    const url = `${base}/${name}`;
    return { url, env: { MOCK_API_URL: url, WIREMOCK_URL: base, WIREMOCK_ADMIN_URL: `${base}/__admin`, MOCK_API_PREFIX: `/${name}` } };
  },
  instructions: ({ name }, envName) =>
    `- **WireMock (HTTP API mocks)** – point the code under test at \`$${envName}\` instead of real APIs. Register stubs via \`POST $WIREMOCK_ADMIN_URL/mappings\`; their URLs must start with \`/${name}\` (\`$MOCK_API_PREFIX\`), e.g. \`{"request":{"method":"GET","urlPath":"/${name}/users/1"},"response":{"status":200,"jsonBody":{"id":1}}}\`. The WireMock server is shared – never delete stubs outside your prefix.`,
};

// ── Mailpit ───────────────────────────────────────────────────────────────────
const MAILPIT_WEB = 8025;

const mailpit: Engine = {
  container: () => ({ env: { MP_DATABASE: '/data/mailpit.db', MP_MAX_MESSAGES: '5000', MP_SMTP_AUTH_ACCEPT_ANY: '1', MP_SMTP_AUTH_ALLOW_INSECURE: '1' }, dataPath: '/data', ports: [1025, MAILPIT_WEB] }),
  test: async (admin) => {
    const web = admin.ports?.[MAILPIT_WEB] ?? MAILPIT_WEB;
    const info = await http<{ Version?: string }>(`http://${admin.host}:${web}/api/v1/info`);
    return `Mailpit ${info?.Version ?? ''}`.trim();
  },
  provision: async () => undefined,
  deprovision: async () => undefined,
  reset: async () => undefined,
  connection: ({ host, port, ports }) => {
    const api = `http://${host}:${ports?.[MAILPIT_WEB] ?? MAILPIT_WEB}/api/v1`;
    return { url: `smtp://${host}:${port}`, env: { SMTP_HOST: host, SMTP_PORT: String(port), SMTP_URL: `smtp://${host}:${port}`, MAILPIT_API_URL: api } };
  },
  instructions: (_conn, envName) =>
    `- **Mailpit (email catcher)** – send mail via SMTP to \`$${envName}\` (\`SMTP_HOST\`/\`SMTP_PORT\`, no TLS, any or no login); nothing leaves the server. Read received mails via \`$MAILPIT_API_URL/messages\` and \`$MAILPIT_API_URL/message/<ID>\`. The mailbox is shared with other sandboxes.`,
};

export const ENGINES: Record<ServiceKind, Engine> = { postgres, mysql: mysqlEngine, mongodb, redis, wiremock, mailpit };
