import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog } from './activity.ts';
import { PasswordHasher } from './auth/password.ts';
import { AuthService } from './auth/users.ts';
import { parseTrustProxy } from './config.ts';
import { EventBus } from './events.ts';
import { buildHttpServer, type HttpDeps } from './http.ts';
import { createRpc, type RpcContext } from './rpc.ts';
import { SecretsService } from './secrets.ts';
import { SettingsService } from './settings.ts';
import { Store } from './store.ts';
import { TokenService } from './tokens.ts';

const ADMIN_TOKEN = 'a-long-random-admin-token-for-tests';
const PASSWORD = 'three small clouds over the harbour';
const WEBHOOK = 'https://hooks.example.com/services/T000/B000/very-secret';
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let webDir: string;
beforeAll(() => {
  process.env.LOG_LEVEL = 'silent';
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-auth-http-'));
  webDir = join(dir, 'web');
  mkdirSync(webDir);
  writeFileSync(join(webDir, 'index.html'), '<h1>ui</h1>');
});
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  rmSync(dir, { recursive: true, force: true });
});

/** The real store, token and auth services and the real RPC layer; only the sandbox side is a stub. */
async function build(trustProxy: string | undefined = undefined, agents: unknown = {}) {
  const store = new Store(dir);
  const bus = new EventBus();
  const activity = new ActivityLog(bus);
  const tokens = new TokenService(store, ADMIN_TOKEN);
  const auth = new AuthService(store, tokens, activity, { sessionIdleMs: 8 * 3_600_000, sessionMaxMs: 7 * 24 * 3_600_000 }, { hasher: new PasswordHasher({ N: 2 ** 10, r: 8, p: 1 }) });
  const settings = new SettingsService(store, bus, undefined);
  const secrets = new SecretsService(store);
  secrets.set('ANTHROPIC_API_KEY', 'sk-ant-api03-abcdefghijklmnop');
  settings.update({ notifications: { webhookUrl: WEBHOOK } });
  const sandboxes = { list: () => [{ id: 'sb_1' }] };
  const rpc = createRpc({ store, settings, secrets, tokens, auth, activity, sandboxes, workspace: {}, ports: {} } as unknown as RpcContext);
  const app = await buildHttpServer({
    config: { webDir, trustProxy: parseTrustProxy(trustProxy) },
    rpc,
    bus,
    auth,
    agents,
    workspace: { archive: async () => 'tar' },
    ports: { previewRoute: () => undefined },
  } as unknown as HttpDeps);
  apps.push(app);
  const call = async (token: string, method: string, params: unknown = {}) => {
    const res = await app.inject({ method: 'POST', url: `/v1/rpc/${method}`, headers: bearer(token), payload: params as object });
    return { status: res.statusCode, ...(res.json() as { result?: any; error?: { code: string; message: string } }) };
  };
  const post = (url: string, payload: unknown, extra: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, ...extra });
  /** Invites a user as the admin and lets them choose a password, over HTTP. */
  const signUp = async (username: string, role: 'admin' | 'member' = 'member') => {
    const created = await call(ADMIN_TOKEN, 'users.create', { username, role });
    const res = await post('/v1/auth/setup', { token: created.result.setup.token, password: PASSWORD });
    return { userId: created.result.user.id as string, token: (res.json() as { result: { token: string } }).result.token, setupToken: created.result.setup.token as string };
  };
  return { app, store, bus, auth, tokens, settings, call, post, signUp };
}

describe('signing in over HTTP', () => {
  it('needs no token for the sign-in routes, and answers a wrong password with 401 and a generic message', async () => {
    const { post, signUp } = await build();
    await signUp('alice');
    const wrong = await post('/v1/auth/login', { username: 'alice', password: 'not my password at all' });
    const unknown = await post('/v1/auth/login', { username: 'nobody', password: 'not my password at all' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.headers['cache-control']).toBe('no-store');
  });

  it('keeps the text of unexpected errors away from callers who are not signed in', async () => {
    const { auth, post } = await build();
    vi.spyOn(auth, 'login').mockRejectedValue(new Error('scrypt failed in /srv/cocoon/internal/path'));
    const res = await post('/v1/auth/login', { username: 'alice', password: 'not my password at all' });
    expect(res.statusCode).toBe(500);
    const error = (res.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('internal');
    expect(error.message).not.toContain('/srv/cocoon');
  });

  it('invites, sets the password with the link, signs in and uses the session like a token', async () => {
    const { post, call, signUp } = await build();
    const { token, setupToken } = await signUp('Alice');
    // The link says whom it is for ... and works once.
    expect((await post('/v1/auth/setup-info', { token: setupToken })).statusCode).toBe(401);
    const login = await post('/v1/auth/login', { username: 'alice', password: PASSWORD });
    expect(login.statusCode).toBe(200);
    const session = (login.json() as { result: { token: string; identity: unknown } }).result;
    expect(session.identity).toMatchObject({ kind: 'user', role: 'member', user: { username: 'alice' } });
    expect(session.token).not.toBe(token);
    const me = await call(session.token, 'auth.me');
    expect(me.result).toMatchObject({ kind: 'user', role: 'member', user: { username: 'alice' } });
    expect((await call(token, 'auth.me')).status).toBe(200);
  });

  it('shows the account behind a setup link', async () => {
    const { post, call } = await build();
    const created = await call(ADMIN_TOKEN, 'users.create', { username: 'alice', displayName: 'Alice A.', role: 'member' });
    const info = await post('/v1/auth/setup-info', { token: created.result.setup.token });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual({ result: { username: 'alice', displayName: 'Alice A.' } });
  });

  it('explains weak passwords with 400 instead of using up the link', async () => {
    const { post, call } = await build();
    const created = await call(ADMIN_TOKEN, 'users.create', { username: 'alice', role: 'member' });
    const weak = await post('/v1/auth/setup', { token: created.result.setup.token, password: 'short' });
    expect(weak.statusCode).toBe(400);
    expect((weak.json() as { error: { code: string } }).error.code).toBe('bad_request');
    expect((await post('/v1/auth/setup', { token: created.result.setup.token, password: PASSWORD })).statusCode).toBe(200);
  });

  it('slows down guessing: 429 with Retry-After after five wrong passwords', async () => {
    const { post, signUp } = await build();
    await signUp('alice');
    for (let i = 0; i < 5; i++) expect((await post('/v1/auth/login', { username: 'alice', password: `wrong password ${i} xx` })).statusCode).toBe(401);
    const locked = await post('/v1/auth/login', { username: 'alice', password: PASSWORD });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBe('30');
    expect((locked.json() as { error: { code: string } }).error.code).toBe('rate_limited');
  });

  it('refuses malformed and oversized bodies before doing any work', async () => {
    const { post, app } = await build();
    expect((await post('/v1/auth/login', {})).statusCode).toBe(400);
    expect((await post('/v1/auth/login', { username: 'alice' })).statusCode).toBe(400);
    expect((await post('/v1/auth/login', { username: 'alice', password: 'x'.repeat(2000) })).statusCode).toBe(400);
    const big = await post('/v1/auth/login', { username: 'alice', password: 'y'.repeat(10_000) });
    // Fastify refuses this before our handler runs; it still answers in our error format, without caching.
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: { code: 'bad_request' } });
    expect(big.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{' })).statusCode).toBe(400);
  });

  it('knows no other routes below /v1/auth without a token', async () => {
    const { app } = await build();
    for (const url of ['/v1/auth/logout', '/v1/auth/me', '/v1/auth/%6cogin/..']) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode, url).toBe(401);
    }
  });
});

describe('client addresses behind a proxy', () => {
  const guess = (post: Awaited<ReturnType<typeof build>>['post'], forwarded: string, n: number) =>
    post('/v1/auth/login', { username: `user${n}`, password: 'spring2026spring2026' }, { remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': forwarded } });

  it('ignores X-Forwarded-For by default, so it cannot be used to escape the throttle', async () => {
    const { post } = await build();
    for (let i = 0; i < 20; i++) expect((await guess(post, `192.0.2.${i}`, i)).statusCode).toBe(401);
    expect((await guess(post, '192.0.2.200', 99)).statusCode).toBe(429);
  });

  it('believes a proxy on the same machine by default (the Caddy setup), so clients behind it are told apart', async () => {
    const { post } = await build();
    const viaCaddy = (forwarded: string, n: number) =>
      post('/v1/auth/login', { username: `user${n}`, password: 'spring2026spring2026' }, { remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': forwarded } });
    for (let i = 0; i < 20; i++) expect((await viaCaddy('192.0.2.1', i)).statusCode).toBe(401);
    expect((await viaCaddy('192.0.2.1', 99)).statusCode).toBe(429);
    expect((await viaCaddy('192.0.2.2', 99)).statusCode).toBe(401);
  });

  it('believes nobody with COCOON_TRUST_PROXY=0', async () => {
    const { post } = await build('0');
    const viaCaddy = (forwarded: string, n: number) =>
      post('/v1/auth/login', { username: `user${n}`, password: 'spring2026spring2026' }, { remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': forwarded } });
    for (let i = 0; i < 20; i++) expect((await viaCaddy(`192.0.2.${i}`, i)).statusCode).toBe(401);
    expect((await viaCaddy('192.0.2.200', 99)).statusCode).toBe(429);
  });

  it('tells clients apart with COCOON_TRUST_PROXY=1', async () => {
    const { post } = await build('1');
    for (let i = 0; i < 20; i++) expect((await guess(post, '192.0.2.1', i)).statusCode).toBe(401);
    expect((await guess(post, '192.0.2.1', 99)).statusCode).toBe(429);
    expect((await guess(post, '192.0.2.2', 99)).statusCode).toBe(401);
  });
});

describe('roles over HTTP', () => {
  it('lets a member work and refuses administration with 403', async () => {
    const { call, signUp } = await build();
    const { token } = await signUp('alice');
    expect((await call(token, 'sandbox.list')).result).toEqual([{ id: 'sb_1' }]);
    for (const [method, params] of [
      ['secrets.set', { name: 'X_KEY', value: 'v' }],
      ['secrets.delete', { name: 'ANTHROPIC_API_KEY' }],
      ['settings.update', { general: { language: 'en' } }],
      ['tokens.list', {}],
      ['tokens.create', { name: 'x' }],
      ['users.list', {}],
      ['users.create', { username: 'mallory', role: 'admin' }],
      ['update.apply', {}],
      ['system.restart', {}],
      ['image.build', { kind: 'sandbox' }],
      ['services.credentials', { serviceId: 's' }],
    ] as const) {
      const res = await call(token, method, params);
      expect(res.status, method).toBe(403);
      expect(res.error?.code, method).toBe('forbidden');
    }
    // The admin token can still do all of it.
    expect((await call(ADMIN_TOKEN, 'users.list')).status).toBe(200);
  });

  it('refuses a GitHub token other than the default from members, and lets admins choose', async () => {
    const { call, signUp } = await build();
    const { token } = await signUp('alice');
    const res = await call(token, 'sandbox.update', { sandboxId: 'sb_1', githubToken: 'GITHUB_TOKEN_COMPANY' });
    expect(res.status).toBe(403);
    expect(res.error?.code).toBe('forbidden');
    expect((await call(token, 'workspace.update', { workspaceId: 'w', githubToken: 'GITHUB_TOKEN_COMPANY' })).status).toBe(403);
  });

  it('refuses before the parameters are looked at, so a member learns nothing about the method', async () => {
    const { call, signUp } = await build();
    const { token } = await signUp('alice');
    const res = await call(token, 'secrets.set', { definitely: 'wrong' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.error)).not.toContain('name');
  });

  it('gives unknown methods the same answer as before', async () => {
    const { call, signUp } = await build();
    const { token } = await signUp('alice');
    expect((await call(token, 'does.not.exist')).status).toBe(404);
  });

  it('shows a member the names of the credentials but not their values, and no webhook', async () => {
    const { call, signUp } = await build();
    const { token } = await signUp('alice');
    const secrets = (await call(token, 'secrets.list')).result as Array<{ name: string; preview?: string; updatedAt?: string }>;
    expect(secrets.find((s) => s.name === 'ANTHROPIC_API_KEY')).toEqual({ name: 'ANTHROPIC_API_KEY', set: true, source: 'store' });
    expect(JSON.stringify(secrets)).not.toContain('sk-ant');
    const settings = JSON.stringify((await call(token, 'settings.get')).result);
    expect(settings).not.toContain('very-secret');
    // An admin sees both.
    const admin = (await call(ADMIN_TOKEN, 'secrets.list')).result as Array<{ name: string; preview?: string }>;
    expect(admin.find((s) => s.name === 'ANTHROPIC_API_KEY')?.preview).toMatch(/^sk-ant/);
    expect(JSON.stringify((await call(ADMIN_TOKEN, 'settings.get')).result)).toContain('very-secret');
  });

  it('lets an admin user administrate, and a member not become one by asking', async () => {
    const { call, signUp } = await build();
    const root = await signUp('root', 'admin');
    const alice = await signUp('alice');
    expect((await call(root.token, 'users.list')).status).toBe(200);
    expect((await call(alice.token, 'users.update', { userId: alice.userId, role: 'admin' })).status).toBe(403);
    const promoted = await call(root.token, 'users.update', { userId: alice.userId, role: 'admin' });
    expect(promoted.status).toBe(200);
    // The old session ended with the role change: signing in again gives the new role.
    expect((await call(alice.token, 'users.list')).status).toBe(401);
  });

  it('downloads archives with a session token in the query, like with other tokens', async () => {
    const { app, signUp } = await build();
    const { token } = await signUp('alice');
    expect((await app.inject({ method: 'GET', url: `/v1/sandboxes/sb_1/archive?token=${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/sandboxes/sb_1/archive?token=ccs_nope' })).statusCode).toBe(401);
  });
});

describe('ending access', () => {
  it('stops a session at once when the user signs out, is locked, reset or deleted', async () => {
    const { call, signUp } = await build();
    const out = await signUp('out');
    const locked = await signUp('locked');
    const reset = await signUp('reset');
    const gone = await signUp('gone');
    expect((await call(out.token, 'auth.logout')).status).toBe(200);
    expect((await call(ADMIN_TOKEN, 'users.update', { userId: locked.userId, disabled: true })).status).toBe(200);
    expect((await call(ADMIN_TOKEN, 'users.reset_password', { userId: reset.userId })).status).toBe(200);
    expect((await call(ADMIN_TOKEN, 'users.delete', { userId: gone.userId })).status).toBe(200);
    for (const user of [out, locked, reset, gone]) expect((await call(user.token, 'auth.me')).status).toBe(401);
  });

  it('changes the password and keeps only the session that did it', async () => {
    const { call, post, signUp } = await build();
    const { token } = await signUp('alice');
    const other = ((await post('/v1/auth/login', { username: 'alice', password: PASSWORD })).json() as { result: { token: string } }).result.token;
    const wrong = await call(token, 'auth.change_password', { currentPassword: 'not the password', newPassword: 'seven brave owls in the library' });
    // 400, not 401: the UI signs a user out on 401.
    expect(wrong.status).toBe(400);
    expect((await call(token, 'auth.change_password', { currentPassword: PASSWORD, newPassword: 'seven brave owls in the library' })).status).toBe(200);
    expect((await call(token, 'auth.me')).status).toBe(200);
    expect((await call(other, 'auth.me')).status).toBe(401);
  });

  it('refuses a password change for tokens', async () => {
    const { call } = await build();
    expect((await call(ADMIN_TOKEN, 'auth.change_password', { currentPassword: 'x', newPassword: 'seven brave owls in the library' })).status).toBe(400);
  });
});

/** Collects what a socket receives. */
function listen(ws: WebSocket) {
  const messages: Array<Record<string, any>> = [];
  const closed: { code?: number } = {};
  ws.on('message', (data) => messages.push(JSON.parse(String(data))));
  ws.on('close', (code) => void (closed.code = code));
  return { messages, closed };
}
const until = async (condition: () => boolean, what = 'condition') => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition(), what).toBe(true);
};

describe('sockets', () => {
  it('refuse connections without a valid token', async () => {
    const { app, signUp } = await build();
    await app.ready();
    await expect(app.injectWS('/v1/ws')).rejects.toThrow(/401/);
    await expect(app.injectWS('/v1/ws?token=ccs_nope')).rejects.toThrow(/401/);
    const { token } = await signUp('alice');
    const ws = await app.injectWS(`/v1/ws?token=${token}`);
    ws.close();
  });

  it('release a terminal that was still being attached when the socket closed', async () => {
    let release!: (session: unknown) => void;
    const attaching = new Promise((resolve) => (release = resolve));
    let closed = 0;
    const { app, signUp } = await build(undefined, { attach: () => attaching });
    await app.ready();
    const { token } = await signUp('alice');
    const ws = await app.injectWS(`/v1/agents/ag_1/attach?token=${token}`);
    const events = listen(ws);
    ws.terminate();
    await until(() => events.closed.code !== undefined, 'socket closed');
    // The server sees the close a moment after the client does.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stream = Object.assign(new (await import('node:stream')).PassThrough());
    release({ stream, close: () => closed++, resize: async () => undefined });
    await until(() => closed > 0, 'terminal released');
    expect(closed).toBe(1);
  });

  it('are closed with 4401 when the session ends', async () => {
    const { app, call, signUp } = await build();
    await app.ready();
    const { token, userId } = await signUp('alice');
    const ws = await app.injectWS(`/v1/ws?token=${token}`);
    const events = listen(ws);
    const other = await signUp('bob');
    const otherWs = await app.injectWS(`/v1/ws?token=${other.token}`);
    const otherEvents = listen(otherWs);
    await call(ADMIN_TOKEN, 'users.update', { userId, disabled: true });
    await until(() => events.closed.code !== undefined, 'alice socket closed');
    expect(events.closed.code).toBe(4401);
    // Other users keep their connection.
    expect(otherEvents.closed.code).toBeUndefined();
    otherWs.close();
  });

  it('are closed when the session of the same browser signs out', async () => {
    const { app, call, signUp } = await build();
    await app.ready();
    const { token } = await signUp('alice');
    const ws = await app.injectWS(`/v1/ws?token=${token}`);
    const events = listen(ws);
    await call(token, 'auth.logout');
    await until(() => events.closed.code !== undefined);
    expect(events.closed.code).toBe(4401);
  });

  it('of a revoked API token are closed too', async () => {
    const { app, call, tokens } = await build();
    await app.ready();
    const created = await call(ADMIN_TOKEN, 'tokens.create', { name: 'Laptop' });
    const ws = await app.injectWS(`/v1/ws?token=${created.result.token}`);
    const events = listen(ws);
    const adminWs = await app.injectWS(`/v1/ws?token=${ADMIN_TOKEN}`);
    const adminEvents = listen(adminWs);
    expect((await call(ADMIN_TOKEN, 'tokens.revoke', { id: created.result.info.id })).status).toBe(200);
    await until(() => events.closed.code !== undefined);
    expect(events.closed.code).toBe(4401);
    expect(adminEvents.closed.code).toBeUndefined();
    expect(tokens.list().map((t) => t.name)).toEqual([]);
    adminWs.close();
  });

  it('refuse a method call from a member just like HTTP', async () => {
    const { app, signUp } = await build();
    await app.ready();
    const { token } = await signUp('alice');
    const ws = await app.injectWS(`/v1/ws?token=${token}`);
    const { messages } = listen(ws);
    ws.send(JSON.stringify({ id: 1, method: 'secrets.set', params: { name: 'X_KEY', value: 'v' } }));
    ws.send(JSON.stringify({ id: 2, method: 'sandbox.list' }));
    await until(() => messages.length >= 2);
    expect(messages.find((m) => m.id === 1)?.error?.code).toBe('forbidden');
    expect(messages.find((m) => m.id === 2)?.result).toEqual([{ id: 'sb_1' }]);
    ws.close();
  });

  it('send members only the events they may see', async () => {
    const { app, bus, signUp, settings } = await build();
    await app.ready();
    const { token } = await signUp('alice');
    const memberWs = await app.injectWS(`/v1/ws?token=${token}`);
    const adminWs = await app.injectWS(`/v1/ws?token=${ADMIN_TOKEN}`);
    const member = listen(memberWs);
    const admin = listen(adminWs);
    for (const ws of [memberWs, adminWs]) ws.send(JSON.stringify({ id: 'ev', method: 'events.subscribe', params: {} }));
    await until(() => member.messages.some((m) => m.id === 'ev') && admin.messages.some((m) => m.id === 'ev'));

    bus.publish({ type: 'update.progress', buildId: 'b', status: 'running', line: 'git pull' });
    bus.publish({ type: 'image.build', buildId: 'b', kind: 'sandbox', status: 'running' });
    settings.update({ general: { language: 'en' } });
    bus.publish({ type: 'task.deleted', taskId: 't_1', workspaceId: 'ws_1' });

    await until(() => member.messages.some((m) => m.event?.type === 'task.deleted') && admin.messages.some((m) => m.event?.type === 'task.deleted'));
    const types = (messages: Array<Record<string, any>>) => messages.filter((m) => m.event).map((m) => m.event.type as string);
    expect(types(admin.messages)).toEqual(['update.progress', 'image.build', 'settings.updated', 'task.deleted']);
    expect(types(member.messages)).toEqual(['settings.updated', 'task.deleted']);
    // The settings event reaches the member without the webhook.
    expect(JSON.stringify(member.messages)).not.toContain('very-secret');
    expect(JSON.stringify(admin.messages)).toContain('very-secret');
    memberWs.close();
    adminWs.close();
  });
});

describe('MCP', () => {
  async function tools(address: string, token: string): Promise<string[]> {
    const res = await fetch(`${address}/mcp`, {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    return body.result.tools.map((tool) => tool.name);
  }

  it('lists only the tools a member may use, and still lists them all for admins', async () => {
    const { app, signUp } = await build();
    const { token } = await signUp('alice');
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const member = await tools(address, token);
    const admin = await tools(address, ADMIN_TOKEN);
    expect(member).toContain('sandbox_create');
    expect(member).toContain('agent_spawn');
    // Exposed to MCP, but administration: update_status.
    expect(admin).toContain('update_status');
    expect(member).not.toContain('update_status');
    expect(admin.filter((name) => !member.includes(name))).toEqual(['update_status']);
  });

  it('runs a tool for a member and refuses one that is administration', async () => {
    const { app, signUp } = await build();
    const { token } = await signUp('alice');
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const call = async (name: string) => {
      const res = await fetch(`${address}/mcp`, {
        method: 'POST',
        headers: { ...bearer(token), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
      });
      return ((await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    };
    const allowed = await call('sandbox_list');
    expect(allowed.isError).toBeUndefined();
    expect(JSON.parse(allowed.content[0]!.text)).toEqual([{ id: 'sb_1' }]);
    const refused = await call('update_status');
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('unknown tool');
  });

  it('refuses tool calls without a token', async () => {
    const { app } = await build();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const res = await fetch(`${address}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});
