import { request } from 'node:http';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { available, createSandbox, rpc, serverUrl, sh, waitFor } from './harness.ts';

/** A tiny server in the sandbox: HTTP answers with the Host it saw, upgrades echo raw bytes (like a WebSocket would). */
const SERVER = `
const http = require('http');
const s = http.createServer((req, res) => res.end('hello from the sandbox, host=' + req.headers.host + ' cookie=' + (req.headers.cookie || '')));
s.on('upgrade', (req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: echo\\r\\nConnection: Upgrade\\r\\n\\r\\n'); socket.pipe(socket); });
s.listen(Number(process.argv[2]), process.argv[3]);
`;

const start = (sandboxId: string, port: number, host: string) =>
  sh(sandboxId, `cat > /tmp/server.js <<'EOF'\n${SERVER}\nEOF\nsetsid nohup node /tmp/server.js ${port} ${host} >/tmp/server-${port}.log 2>&1 &`);

/** HTTP GET against the CoCoon server with a custom Host header (the preview host). */
function get(host: string, path: string, cookie?: string): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  const url = new URL(serverUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, headers: { host, ...(cookie ? { cookie } : {}) } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe.runIf(available)('port forwarding', () => {
  let id: string;

  beforeAll(async () => {
    id = (await createSandbox({ name: 'ports' })).id;
    await start(id, 5173, '0.0.0.0');
    await start(id, 3000, '127.0.0.1');
  });
  afterAll(async () => {
    if (id) await rpc('sandbox.delete', { sandboxId: id }).catch(() => undefined);
  });

  it('detects listening ports and whether they listen on all addresses', async () => {
    const ports = await waitFor('listening ports', async () => {
      const list = await rpc('ports.list', { sandboxId: id });
      return list.some((p: any) => p.port === 5173) && list.some((p: any) => p.port === 3000) ? list : undefined;
    }, 30_000);
    expect(ports.find((p: any) => p.port === 5173)).toMatchObject({ listening: true, address: 'all' });
    expect(ports.find((p: any) => p.port === 3000)).toMatchObject({ listening: true, address: 'loopback' });
  });

  it('serves an opened port as a preview only after logging in with the one-time link', async () => {
    const opened = await rpc('ports.open', { sandboxId: id, port: 5173 });
    expect(opened.opened).toMatchObject({ mode: 'preview' });
    const { url } = await rpc('ports.preview_link', { sandboxId: id, port: 5173 });
    const link = new URL(url);
    const host = link.host;
    expect(host).toMatch(/^p5173-[a-f0-9]+\.localhost:\d+$/);

    // Without a session: no access.
    expect((await get(host, '/')).status).toBe(401);

    // The link sets a cookie and redirects; the token works only once.
    const login = await get(host, link.pathname + link.search);
    expect(login.status).toBe(302);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect(cookie).toMatch(/^cocoon_preview=/);
    expect((await get(host, link.pathname + link.search)).status).toBe(403);

    // The app sees Host localhost:<port> and never the session cookie.
    const page = await waitFor('preview answers', async () => {
      const res = await get(host, '/hello', `${cookie}; theme=dark`);
      return res.status === 200 ? res : undefined;
    }, 30_000);
    expect(page.body).toBe('hello from the sandbox, host=localhost:5173 cookie=theme=dark');

    // The cookie is bound to this preview host only.
    const other = host.replace('p5173-', 'p3000-');
    expect((await get(other, '/', cookie)).status).toBe(401);
  });

  it('proxies upgrades (WebSockets) for logged-in previews', async () => {
    const { url } = await rpc('ports.preview_link', { sandboxId: id, port: 5173 });
    const link = new URL(url);
    const cookie = String((await get(link.host, link.pathname + link.search)).headers['set-cookie']).split(';')[0]!;
    const server = new URL(serverUrl);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(server.port), server.hostname, () => {
        socket.write(`GET /ws HTTP/1.1\r\nHost: ${link.host}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\r\n\r\n') && !data.includes('ping')) socket.write('ping');
        if (data.includes('ping')) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error(`no echo, got: ${data}`)), 10_000);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 101/);
    expect(reply).toContain('ping');
  });

  it('shares a port on the host network and closes it again', async () => {
    const shared = await rpc('ports.open', { sandboxId: id, port: 5173, mode: 'shared' });
    expect(shared.opened.mode).toBe('shared');
    expect(shared.opened.url).toMatch(/^http:\/\/127\.0\.0\.1:1755\d$/);
    const body = await waitFor('shared port answers', async () => {
      const res = await fetch(shared.opened.url).catch(() => undefined);
      return res?.ok ? res.text() : undefined;
    }, 30_000);
    expect(body).toContain('hello from the sandbox');

    await rpc('ports.close', { sandboxId: id, port: 5173 });
    await waitFor('shared port closed', async () => !(await fetch(shared.opened.url).then((r) => r.ok).catch(() => false)), 15_000);
    expect((await rpc('ports.list', { sandboxId: id })).find((p: any) => p.port === 5173).opened).toBeUndefined();
  });
});
