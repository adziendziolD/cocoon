// Port gateway: forwards host ports (published by Docker/Podman) to ports inside sandboxes. Managed by cocoond.
//
// PORTS_LISTEN  ports to listen on, e.g. "7500-7549,7550-7599" (the container publishes the same numbers on the host)
// PORTS_MAP     JSON file written by cocoond: { "7500": { "host": "10.89.0.5", "port": 5173 }, … }
//
// Plain TCP piping, so HTTP, WebSockets and any other protocol work. Unmapped ports close the connection right away.
// Dependency-free on purpose (runs in the egress-proxy image).
import net from 'node:net';
import { readFileSync, statSync } from 'node:fs';

const MAP_FILE = process.env.PORTS_MAP ?? '/ports/ports.json';

export function parsePorts(spec) {
  const ports = new Set();
  for (const part of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [from, to = from] = part.split('-').map(Number);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 65535 || to < from) throw new Error(`invalid port range "${part}"`);
    for (let p = from; p <= to; p++) ports.add(p);
  }
  return [...ports];
}

let mapping = {};
let mtime = 0;
/** Open connections per listening port, with the target they were opened for. */
const connections = new Map();

const sameTarget = (a, b) => Boolean(a && b && a.host === b.host && a.port === b.port);

function load() {
  try {
    const stat = statSync(MAP_FILE);
    if (stat.mtimeMs === mtime) return;
    mtime = stat.mtimeMs;
    mapping = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
  } catch {
    // keep the last good mapping (file missing or being rewritten)
    return;
  }
  // A closed or re-pointed port must stop working right away, also for kept-alive connections.
  for (const [port, open] of connections) {
    for (const conn of open) if (!sameTarget(conn.target, mapping[String(port)])) conn.close();
  }
}

function serve(port) {
  const server = net.createServer((client) => {
    load();
    const target = mapping[String(port)];
    if (!target) return client.destroy();
    const upstream = net.connect(target.port, target.host);
    const open = connections.get(port) ?? new Set();
    connections.set(port, open);
    const conn = {
      target,
      close: () => {
        open.delete(conn);
        client.destroy();
        upstream.destroy();
      },
    };
    open.add(conn);
    const close = conn.close;
    client.on('close', close);
    upstream.on('close', close);
    upstream.setTimeout(0);
    client.on('error', close);
    upstream.on('error', close);
    client.pipe(upstream).pipe(client);
  });
  server.on('error', (err) => console.error(`port ${port}: ${err.message}`));
  server.listen(port, '0.0.0.0');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ports = parsePorts(process.env.PORTS_LISTEN ?? '7500-7599');
  load();
  // Bind mounts do not reliably deliver file events on every platform, so poll.
  setInterval(load, 1000).unref();
  for (const port of ports) serve(port);
  console.log(`port gateway listening on ${ports.length} ports`);
}
