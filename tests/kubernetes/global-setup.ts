import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { TestProject } from 'vitest/node';
import { build, rpc } from '../integration/global-setup.ts';

const root = resolve(import.meta.dirname, '../..');
export const KUBECONFIG = resolve(import.meta.dirname, '.kubeconfig');
/** Set in tests/kubernetes/kustomization.yaml. */
const TOKEN = 'kubernetes-test-token-0123456789';
const PORT = 17420;

const has = (command: string, ...args: string[]) => {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
};

/** Deploys the current code into the kind test cluster (setup.sh) and reaches it through a port-forward. */
export default async function setup(project: TestProject) {
  if (!has('docker', 'info') || !has('kind', 'version') || !has('kubectl', 'version', '--client')) {
    console.warn('[kubernetes] docker, kind and kubectl are needed – Kubernetes tests are skipped.');
    project.provide('cocoon', null);
    return;
  }
  execFileSync(resolve(import.meta.dirname, 'setup.sh'), { cwd: root, stdio: 'inherit' });
  const forward: ChildProcess = spawn('kubectl', ['-n', 'cocoon', 'port-forward', 'svc/cocoon', `${PORT}:7420`], { env: { ...process.env, KUBECONFIG }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${PORT}`;
  let last = '';
  for (let i = 0; i < 60; i++) {
    try {
      if ((await rpc(url, TOKEN, 'system.info')).proxyRunning) break;
    } catch (err) {
      last = (err as Error).message;
    }
    if (i === 59) throw new Error(`server not reachable through the port-forward: ${last}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Agents and the ports test's server run with the toolbox's Node.js; installing it also checks the shared volume.
  await build(url, TOKEN, { kind: 'agents', tools: ['claude-code'] });
  const toolbox = ((await rpc(url, TOKEN, 'image.status')) as { kind: string; exists: boolean }[]).find((i) => i.kind === 'agents');
  if (!toolbox?.exists) throw new Error('agent toolbox not installed (kubectl -n cocoon logs cocoon-0)');
  project.provide('cocoon', { url, token: TOKEN, instance: '', log: 'kubectl -n cocoon logs cocoon-0', kubernetes: true });

  return async () => {
    for (const sb of (await rpc(url, TOKEN, 'sandbox.list').catch(() => [])) as { id: string }[]) await rpc(url, TOKEN, 'sandbox.delete', { sandboxId: sb.id }).catch(() => undefined);
    forward.kill('SIGTERM');
  };
}
