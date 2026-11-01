import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PATH_MODE_CSP, pathModeHeaders, servePreview } from './preview.ts';
import type { PortService } from './ports.ts';

type Headers = Record<string, string | string[] | undefined>;

const servers: Server[] = [];
const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const get = (port: number, path: string, cookie?: string) =>
  new Promise<{ status: number; headers: Headers }>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: cookie ? { cookie } : {} }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    })
      .on('error', reject)
      .end();
  });

/** Preview front (servePreview) in front of an "app" that tries to set cookies and sends its own CSP. */
async function setup(prefix: string) {
  const app = createServer((_req, res) => {
    res.writeHead(200, { 'set-cookie': ['sid=evil; Path=/', 'x=1'], 'content-security-policy': "default-src 'self'", 'content-type': 'text/html' });
    res.end('<script>localStorage.getItem("cocoon.token")</script>');
  });
  const appPort = await listen(app);
  const ports = {
    previewRoute: (_host: string, url: string) => ({ sandboxId: 'sb_abc123', port: 5173, prefix, rest: url.slice(prefix.length) || '/' }),
    previewTargetFor: (_r: unknown, session?: string) => (session === 'good' ? appPort : undefined),
    redeemFor: (token: string) => (token === 'link' ? 'good' : undefined),
    linkProblem: () => 'unknown-token',
    previewSuffix: 'localhost',
  } as unknown as PortService;
  const front = createServer((req, res) => servePreview(ports, req, res, false));
  return listen(front);
}

describe('pathModeHeaders', () => {
  it('drops Set-Cookie and appends the sandbox CSP to an existing policy', () => {
    const out = pathModeHeaders({ 'set-cookie': ['a=b'], 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" });
    expect(out['set-cookie']).toBeUndefined();
    expect(out['content-type']).toBe('text/html');
    expect(out['content-security-policy']).toEqual(["default-src 'self'", PATH_MODE_CSP]);
  });

  it('sets the sandbox CSP and never grants same-origin access', () => {
    expect(pathModeHeaders({})['content-security-policy']).toBe(PATH_MODE_CSP);
    expect(PATH_MODE_CSP).toMatch(/^sandbox /);
    expect(PATH_MODE_CSP).not.toContain('allow-same-origin');
  });
});

describe('servePreview', () => {
  it('path mode: strips upstream cookies and sandboxes the response', async () => {
    const port = await setup('/preview/p5173-abc123');
    expect((await get(port, '/preview/p5173-abc123/')).status).toBe(401);
    const res = await get(port, '/preview/p5173-abc123/', 'cocoon_preview=good');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(String(res.headers['content-security-policy'])).toContain('sandbox');
  });

  it('path mode: still sets the preview session cookie when redeeming a link', async () => {
    const port = await setup('/preview/p5173-abc123');
    const res = await get(port, '/preview/p5173-abc123/?cocoon_preview=link');
    expect(res.status).toBe(302);
    expect(String(res.headers['set-cookie'])).toMatch(/^cocoon_preview=good; Path=\/preview\/p5173-abc123\/; HttpOnly/);
  });

  it('host mode: keeps the app headers (own origin per preview)', async () => {
    const port = await setup('');
    const res = await get(port, '/', 'cocoon_preview=good');
    expect(res.headers['set-cookie']).toEqual(['sid=evil; Path=/', 'x=1']);
    expect(res.headers['content-security-policy']).toBe("default-src 'self'");
  });
});
