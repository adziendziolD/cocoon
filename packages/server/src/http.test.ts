import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildHttpServer, isPublicRoute, redactToken, type HttpDeps } from './http.ts';

const TOKEN = 'secret-token';
const auth = { authorization: `Bearer ${TOKEN}` };

let webDir: string;
beforeAll(() => {
  process.env.LOG_LEVEL = 'silent';
  webDir = mkdtempSync(join(tmpdir(), 'cocoon-web-'));
  writeFileSync(join(webDir, 'index.html'), '<h1>ui</h1>');
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
});

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function build(rpc = vi.fn(async () => 'executed')) {
  const deps = {
    config: { webDir },
    rpc,
    bus: { subscribe: () => () => undefined },
    tokens: { verify: (token: string | undefined) => token === TOKEN },
    agents: {},
    workspace: { archive: async () => 'tar' },
    ports: { previewRoute: () => undefined },
  } as unknown as HttpDeps;
  const app = await buildHttpServer(deps);
  apps.push(app);
  return { app, rpc };
}

describe('authentication', () => {
  it('rejects API calls without a token and runs them with one', async () => {
    const { app, rpc } = await build();
    expect((await app.inject({ method: 'POST', url: '/v1/rpc/sandbox.exec', payload: {} })).statusCode).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    const ok = await app.inject({ method: 'POST', url: '/v1/rpc/sandbox.exec', payload: {}, headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it('cannot be bypassed by percent-encoding the path', async () => {
    const { app, rpc } = await build();
    for (const url of ['/%761/rpc/sandbox.exec', '/v%31/rpc/sandbox.exec', '/%76%31/rpc/sandbox.exec', '/%6dcp', '/%761/ws']) {
      const res = await app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: 'GET', url: '/%761/sandboxes/sb_1/archive' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/%761/agents/ag_1/attach' })).statusCode).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('protects every method on an API path, also with an unknown route', async () => {
    const { app } = await build();
    for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
      expect((await app.inject({ method, url: '/v1/unknown' })).statusCode, method).toBe(method === 'GET' ? 404 : 401);
    }
  });

  it('accepts the token as a query parameter for downloads and sockets', async () => {
    const { app } = await build();
    expect((await app.inject({ method: 'GET', url: `/v1/sandboxes/sb_1/archive?token=${TOKEN}` })).statusCode).toBe(200);
  });

  it('serves the health check and the web UI without a token', async () => {
    const { app } = await build();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('ui');
    expect((await app.inject({ method: 'GET', url: '/some/page' })).body).toContain('ui');
    expect((await app.inject({ method: 'GET', url: '/assets/app.js' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
  });
});

describe('isPublicRoute', () => {
  it('lets through only the health check, the UI and the not-found fallback for reads', () => {
    expect(isPublicRoute('GET', '/healthz')).toBe(true);
    expect(isPublicRoute('GET', '/*')).toBe(true);
    expect(isPublicRoute('GET', undefined)).toBe(true);
    expect(isPublicRoute('POST', '/*')).toBe(false);
    expect(isPublicRoute('POST', undefined)).toBe(false);
    expect(isPublicRoute('GET', '/v1/ws')).toBe(false);
    expect(isPublicRoute('GET', '/v1/agents/:agentId/attach')).toBe(false);
    expect(isPublicRoute('POST', '/mcp')).toBe(false);
  });
});

describe('token in logs', () => {
  it('redacts the token query parameter', () => {
    expect(redactToken('/v1/ws?token=abc123&lang=de')).toBe('/v1/ws?token=[redacted]&lang=de');
    expect(redactToken('/v1/ws?lang=de&TOKEN=abc')).toBe('/v1/ws?lang=de&TOKEN=[redacted]');
    expect(redactToken('/v1/rpc/x')).toBe('/v1/rpc/x');
    expect(redactToken(undefined)).toBeUndefined();
  });
});
