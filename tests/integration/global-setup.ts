import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    cocoon: { url: string; token: string; instance: string; log: string } | null;
  }
}

const root = resolve(import.meta.dirname, '../..');
let server: ChildProcess | undefined;
let dataDir: string | undefined;

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolvePort(port));
    });
    srv.on('error', reject);
  });
}

async function rpc(url: string, token: string, method: string, params: unknown = {}) {
  const res = await fetch(`${url}/v1/rpc/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as any;
}

async function waitForProxy(url: string, token: string) {
  for (let i = 0; i < 60; i++) {
    if ((await rpc(url, token, 'system.info')).proxyRunning) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('egress proxy not running after rebuild');
}

export default async function setup(project: TestProject) {
  if (!dockerAvailable()) {
    console.warn('[integration] Docker is not available – integration tests are skipped.');
    project.provide('cocoon', null);
    return;
  }
  const instance = `it${randomBytes(3).toString('hex')}`;
  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  const url = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), 'cocoon-it-'));
  const log = join(dataDir, 'server.log');
  const out = createWriteStream(log);
  server = spawn(join(root, 'node_modules/.bin/tsx'), ['packages/server/src/main.ts'], {
    cwd: root,
    env: {
      ...process.env,
      COCOON_PORT: String(port),
      COCOON_DATA_DIR: join(dataDir, 'data'),
      COCOON_INSTANCE: instance,
      COCOON_TOKEN: token,
      COCOON_DRIVER: process.env.COCOON_DRIVER ?? 'docker',
      COCOON_TOOLBOX_AUTOINSTALL: '0',
      COCOON_SERVICE_IDLE_MINUTES: '0.1',
      // Own small port ranges, so a CoCoon running on the same machine keeps its gateway ports; shared only on loopback.
      COCOON_PORTS_PREVIEW_RANGE: '17500-17504',
      COCOON_PORTS_SHARE_RANGE: '17550-17554',
      COCOON_PORTS_SHARE_BIND: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.pipe(out);
  server.stderr?.pipe(out);
  console.log(`[integration] server ${url} (instance ${instance}), log: ${log}`);

  // Ready = API answers, egress proxy runs and the sandbox image exists (it is built on first start).
  const deadline = Date.now() + 1_150_000;
  let last = '';
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited (${server.exitCode}), see ${log}`);
    try {
      const info = await rpc(url, token, 'system.info');
      const images = (await rpc(url, token, 'image.status')) as { kind: string; exists: boolean; building?: boolean }[];
      const sandboxImage = images.find((i) => i.kind === 'sandbox');
      last = `proxy=${info.proxyRunning} sandboxImage=${sandboxImage?.exists} building=${sandboxImage?.building}`;
      if (info.proxyRunning && sandboxImage?.exists && !sandboxImage.building) break;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (Date.now() >= deadline) throw new Error(`server not ready: ${last} (log: ${log})`);

  // Always test the current proxy code: rebuild its image (small, cached layers) – the instance's proxy restarts with it.
  const { buildId } = await rpc(url, token, 'image.build', { kind: 'proxy' });
  await new Promise<void>((resolveBuild, reject) => {
    const started = Date.now();
    const poll = async () => {
      const images = (await rpc(url, token, 'image.status')) as { kind: string; building?: boolean }[];
      if (!images.find((i) => i.kind === 'proxy')?.building) return resolveBuild();
      if (Date.now() - started > 600_000) return reject(new Error(`proxy build ${buildId} timed out`));
      setTimeout(() => void poll().catch(reject), 1000);
    };
    setTimeout(() => void poll().catch(reject), 1000);
  });
  await waitForProxy(url, token);
  project.provide('cocoon', { url, token, instance, log });

  return async () => {
    try {
      for (const sb of (await rpc(url, token, 'sandbox.list')) as { id: string }[]) await rpc(url, token, 'sandbox.delete', { sandboxId: sb.id }).catch(() => undefined);
      for (const svc of (await rpc(url, token, 'services.list')) as { id: string }[]) {
        await rpc(url, token, 'services.remove', { serviceId: svc.id, deleteData: true }).catch(() => undefined);
      }
    } finally {
      server?.kill('SIGTERM');
      const sh = (cmd: string) => {
        try {
          execSync(cmd, { stdio: 'ignore', timeout: 60_000 });
        } catch {
          // already gone
        }
      };
      sh(`docker rm -f cocoon-egress-proxy-${instance}`);
      sh(`docker rm -f cocoon-ports-${instance}`);
      sh(`docker ps -aq --filter name=cocoon-svc-${instance}- | xargs -r docker rm -f`);
      sh(`docker volume ls -q --filter name=cocoon-svc-${instance}- | xargs -r docker volume rm`);
      sh(`docker network rm cocoon-internal-${instance}`);
      sh(`docker volume rm cocoon-agents-${instance}`);
      if (dataDir && !process.env.COCOON_IT_KEEP) rmSync(dataDir, { recursive: true, force: true });
    }
  };
}
