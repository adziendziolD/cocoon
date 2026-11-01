// Runs the real proxy.mjs as a child process against local servers (no network, no Docker).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TOKEN = 'abc123';
const AUTH = `Basic ${Buffer.from(`cocoon:${TOKEN}`).toString('base64')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

let dir;
let child;
let logs = [];
let forwardPort;
let httpPort;
let tcpPort;
let httpServer;
let tcpServer;
let seenHeaders = [];
let seenBytes = [];

function writePolicy(policy) {
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ version: Date.now(), sandboxes: {}, tokens: { [TOKEN]: { sandboxId: 'sb', token: TOKEN, routes: [] } }, routes: {}, ...policy }));
}

async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function applyPolicy(policy) {
  const version = Date.now() + Math.random();
  writePolicy({ ...policy, version });
  await until(() => Number(readFileSync(join(dir, 'ack'), 'utf8')) >= version, 'policy ack');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-proxy-'));
  httpServer = http.createServer((req, res) => {
    seenHeaders.push({ host: req.headers.host, url: req.url });
    res.writeHead(200, { 'content-type': 'text/plain' }).end('upstream ok');
  });
  tcpServer = net.createServer((socket) => {
    socket.on('data', (chunk) => seenBytes.push(chunk));
    socket.on('error', () => undefined);
  });
  httpPort = await listen(httpServer);
  tcpPort = await listen(tcpServer);
  const probe = net.createServer();
  forwardPort = await listen(probe);
  const credentialPort = (await new Promise((resolve) => probe.close(() => resolve(forwardPort)))) + 1;
  writePolicy({ allowlist: [] });
  child = spawn(process.execPath, [new URL('./proxy.mjs', import.meta.url).pathname], {
    env: { POLICY_DIR: dir, FORWARD_PORT: String(forwardPort), CREDENTIAL_PORT: String(credentialPort), BIND_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) logs.push(JSON.parse(line));
  });
  await until(() => logs.some((l) => l.msg === 'forward proxy listening'), 'proxy start');
  await until(() => logs.some((l) => l.msg === 'policy loaded'), 'policy load');
}, 15_000);

afterAll(() => {
  child?.kill();
  httpServer?.close();
  tcpServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

const reset = () => {
  logs = logs.filter((l) => l.msg !== 'denied');
  seenHeaders = [];
  seenBytes = [];
};
const denials = () => logs.filter((l) => l.msg === 'denied');

/** Plain HTTP request through the proxy; `host` is what the client claims in its Host header. */
function viaProxy(url, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: forwardPort, method: 'GET', path: url, headers: { host, 'proxy-authorization': AUTH } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** CONNECT through the proxy; resolves with the status line and the (open) socket. */
function connect(target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(forwardPort, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${AUTH}\r\n\r\n`));
    let head = '';
    socket.on('error', reject);
    socket.on('data', function onData(chunk) {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      resolve({ status: Number(head.split(' ')[1]), socket });
    });
  });
}

/** Real ClientHello bytes for a server name. */
async function clientHello(servername) {
  let captured;
  const got = new Promise((resolve) => (captured = resolve));
  const server = net.createServer((socket) => socket.once('data', (d) => (captured(d), socket.destroy())));
  const port = await listen(server);
  const client = tls.connect({ host: '127.0.0.1', port, servername });
  client.on('error', () => undefined);
  const data = await got;
  client.destroy();
  server.close();
  return data;
}

const closed = (socket) => new Promise((resolve) => (socket.destroyed ? resolve() : socket.once('close', resolve)));

describe('plain HTTP', () => {
  it('sends the checked destination as Host, not the client-supplied one', async () => {
    await applyPolicy({ allowlist: [], targets: [{ host: '127.0.0.1', port: httpPort }] });
    reset();
    const res = await viaProxy(`http://127.0.0.1:${httpPort}/x?y=1`, 'allowed-cdn-customer.example.com');
    expect(res).toEqual({ status: 200, body: 'upstream ok' });
    expect(seenHeaders).toEqual([{ host: `127.0.0.1:${httpPort}`, url: '/x?y=1' }]);
  });

  it('refuses an allowlisted name that resolves to loopback (DNS to an internal address)', async () => {
    await applyPolicy({ allowlist: ['localhost'] });
    reset();
    const res = await viaProxy('http://localhost/', 'localhost');
    expect(res.status).toBe(403);
    expect(res.body).toContain('internal address');
    expect(denials()).toMatchObject([{ host: 'localhost', port: 80, reason: 'private' }]);
  });

  it('refuses IP literals in the private, loopback and metadata ranges even when allowlisted', async () => {
    await applyPolicy({ allowlist: ['169.254.169.254', '127.0.0.1', '10.0.0.5', '[::1]'] });
    reset();
    for (const target of ['169.254.169.254', '127.0.0.1', '10.0.0.5', '[::1]']) {
      expect((await viaProxy(`http://${target}/latest/meta-data/`, target)).status).toBe(403);
    }
    expect(denials().map((d) => d.reason)).toEqual(['private', 'private', 'private', 'private']);
    expect(seenHeaders).toEqual([]);
  });

  it('allows an internal host that is listed in allowPrivate', async () => {
    await applyPolicy({ allowlist: ['localhost'], allowPrivate: ['localhost'], targets: [] });
    reset();
    // Port 80 is not listening, so the request passes the checks and fails at the connection (502), not at the policy (403).
    expect((await viaProxy('http://localhost/', 'localhost')).status).toBe(502);
    expect(denials()).toEqual([]);
  });

  it('still denies names that are neither allowlisted nor a target', async () => {
    await applyPolicy({ allowlist: [], targets: [{ host: '127.0.0.1', port: httpPort }] });
    reset();
    expect((await viaProxy('http://127.0.0.1:1/', '127.0.0.1')).status).toBe(403);
    expect((await viaProxy(`http://example.com:${httpPort}/`, 'example.com')).status).toBe(403);
    expect(denials().map((d) => d.reason)).toEqual([undefined, undefined]);
  });
});

describe('CONNECT', () => {
  it('refuses an allowlisted name that resolves to loopback before any tunnel is established', async () => {
    await applyPolicy({ allowlist: ['localhost'] });
    reset();
    const { status, socket } = await connect('localhost:443');
    expect(status).toBe(403);
    socket.destroy();
    expect(denials()).toMatchObject([{ host: 'localhost', port: 443, reason: 'private' }]);
  });

  it('refuses private IP literals in CONNECT', async () => {
    await applyPolicy({ allowlist: ['169.254.169.254'] });
    reset();
    const { status, socket } = await connect('169.254.169.254:443');
    expect(status).toBe(403);
    socket.destroy();
    expect(denials()).toMatchObject([{ reason: 'private' }]);
  });

  it('forwards a tunnel whose SNI equals the CONNECT host', async () => {
    await applyPolicy({ allowlist: [], targets: [{ host: 'localhost', port: tcpPort }] });
    reset();
    const hello = await clientHello('localhost');
    const { status, socket } = await connect(`localhost:${tcpPort}`);
    expect(status).toBe(200);
    socket.write(hello);
    await until(() => Buffer.concat(seenBytes).length >= hello.length, 'upstream bytes');
    expect(Buffer.concat(seenBytes).equals(hello)).toBe(true);
    socket.destroy();
    expect(denials()).toEqual([]);
  });

  it('closes a tunnel whose SNI names another host and sends nothing upstream (domain fronting)', async () => {
    await applyPolicy({ allowlist: [], targets: [{ host: 'localhost', port: tcpPort }] });
    reset();
    const { status, socket } = await connect(`localhost:${tcpPort}`);
    expect(status).toBe(200);
    socket.write(await clientHello('attacker.githubusercontent.com'));
    await closed(socket);
    await sleep(100);
    expect(seenBytes).toEqual([]);
    expect(denials()).toMatchObject([{ host: 'localhost', reason: 'sni' }]);
  });

  it('closes a tunnel without SNI for a named host', async () => {
    await applyPolicy({ allowlist: [], targets: [{ host: 'localhost', port: tcpPort }] });
    reset();
    const { socket } = await connect(`localhost:${tcpPort}`);
    socket.write(await clientHello(''));
    await closed(socket);
    expect(seenBytes).toEqual([]);
    expect(denials()).toMatchObject([{ reason: 'sni' }]);
  });

  it('closes a tunnel that is not TLS (plain protocols over an allowed port)', async () => {
    await applyPolicy({ allowlist: [], targets: [{ host: 'localhost', port: tcpPort }] });
    reset();
    const { socket } = await connect(`localhost:${tcpPort}`);
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await closed(socket);
    expect(seenBytes).toEqual([]);
    expect(denials()).toMatchObject([{ reason: 'not-tls' }]);
  });

  it('closes the client when the upstream hangs up before any ClientHello and does not log a violation', async () => {
    const hangup = net.createServer((socket) => socket.end());
    const port = await listen(hangup);
    try {
      await applyPolicy({ allowlist: [], targets: [{ host: 'localhost', port }] });
      reset();
      const { socket } = await connect(`localhost:${port}`);
      await Promise.race([closed(socket), sleep(2000).then(() => Promise.reject(new Error('client socket stayed open')))]);
      expect(denials()).toEqual([]);
    } finally {
      hangup.close();
    }
  });

  it('handles a ClientHello that arrives in several pieces', async () => {
    await applyPolicy({ allowlist: [], targets: [{ host: 'localhost', port: tcpPort }] });
    reset();
    const hello = await clientHello('localhost');
    const { socket } = await connect(`localhost:${tcpPort}`);
    socket.write(hello.subarray(0, 3));
    await sleep(50);
    socket.write(hello.subarray(3, 40));
    await sleep(50);
    socket.write(hello.subarray(40));
    await until(() => Buffer.concat(seenBytes).length >= hello.length, 'upstream bytes');
    expect(Buffer.concat(seenBytes).equals(hello)).toBe(true);
    socket.destroy();
  });
});
