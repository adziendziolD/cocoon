import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { available, createSandbox, rpc, sh, waitFor } from '../integration/harness.ts';
import { KUBECONFIG } from './global-setup.ts';

const kubectl = (...args: string[]) => execFileSync('kubectl', args, { encoding: 'utf8', env: { ...process.env, KUBECONFIG }, timeout: 60_000 }).trim();
const podOf = (sandboxId: string) => `cocoon-${sandboxId.replace('_', '-')}-0`;
/** "open" if a TCP connection to host:port works from the sandbox, "blocked" otherwise. */
const reach = async (sandboxId: string, host: string, port: number) =>
  (await sh(sandboxId, `timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/${port}' 2>/dev/null && echo open || echo blocked`)).stdout.trim();

describe.runIf(available)('sandboxes as Kubernetes pods', () => {
  const ids: Record<'none' | 'egress' | 'open', string> = { none: '', egress: '', open: '' };
  let apiServer = '';
  let cocoond = '';

  beforeAll(async () => {
    apiServer = kubectl('get', 'service', 'kubernetes', '-o', 'jsonpath={.spec.clusterIP}');
    cocoond = kubectl('-n', 'cocoon', 'get', 'service', 'cocoon', '-o', 'jsonpath={.spec.clusterIP}');
    for (const network of ['none', 'egress', 'open'] as const) ids[network] = (await createSandbox({ name: `k8s-${network}`, network })).id;
  });
  afterAll(async () => {
    for (const id of Object.values(ids)) if (id) await rpc('sandbox.delete', { sandboxId: id }).catch(() => undefined);
  });

  it('runs on the sandbox nodes, without root and without a token for the cluster', async () => {
    const node = kubectl('-n', 'cocoon-sandboxes', 'get', 'pod', podOf(ids.none), '-o', 'jsonpath={.spec.nodeName}');
    expect(kubectl('get', 'node', node, '-o', 'jsonpath={.metadata.labels.cocoon\\.dev/sandbox}')).toBe('true');
    const res = await sh(ids.none, 'id -u; ls /var/run/secrets/kubernetes.io/serviceaccount 2>/dev/null | wc -l');
    expect(res.stdout.trim().split('\n')).toEqual(['1000', '0']);
  });

  it('"no network" reaches nothing: not the API server, not cocoond, not the internet', async () => {
    expect(await reach(ids.none, apiServer, 443)).toBe('blocked');
    expect(await reach(ids.none, cocoond, 7420)).toBe('blocked');
    expect(await reach(ids.none, cocoond, 7431)).toBe('blocked');
    expect(await reach(ids.none, '1.1.1.1', 443)).toBe('blocked');
  });

  it('"restricted" reaches only the egress proxy', async () => {
    expect(await reach(ids.egress, cocoond, 7431)).toBe('open');
    expect(await reach(ids.egress, cocoond, 7420)).toBe('blocked');
    expect(await reach(ids.egress, apiServer, 443)).toBe('blocked');
    expect(await reach(ids.egress, '1.1.1.1', 443)).toBe('blocked');
  });

  it('"open" reaches the internet, but not the cluster and not other sandboxes', async () => {
    const page = await sh(ids.open, 'curl -s -o /dev/null -w "%{http_code}" --max-time 20 https://example.org');
    expect(page.stdout.trim()).toBe('200');
    expect(await reach(ids.open, apiServer, 443)).toBe('blocked');
    expect(await reach(ids.open, cocoond, 7420)).toBe('blocked');
    await sh(ids.egress, 'setsid nohup bash -c "while true; do echo hi | timeout 60 nc -l -p 9000 >/dev/null 2>&1 || sleep 1; done" >/dev/null 2>&1 &');
    const other = kubectl('-n', 'cocoon-sandboxes', 'get', 'pod', podOf(ids.egress), '-o', 'jsonpath={.status.podIP}');
    expect(await reach(ids.open, other, 9000)).toBe('blocked');
  });

  it('keeps workspace and home across stop and start, and frees the pod while stopped', async () => {
    await sh(ids.none, 'echo kept > /workspace/a.txt; echo kept > ~/b.txt');
    await rpc('sandbox.stop', { sandboxId: ids.none });
    expect(kubectl('-n', 'cocoon-sandboxes', 'get', 'pods', '-l', `cocoon.dev/sandbox=${ids.none}`, '-o', 'name')).toBe('');
    await rpc('sandbox.start', { sandboxId: ids.none });
    expect((await sh(ids.none, 'cat /workspace/a.txt ~/b.txt')).stdout).toBe('kept\nkept\n');
    // What bootstrap wrote survives too: agents can start after a restart.
    const agent = await rpc('agent.spawn', { sandboxId: ids.none, kind: 'shell' });
    expect(agent.status).not.toBe('exited');
    await rpc('agent.kill', { agentId: agent.id });
  });

  it('removes pod and volume with the sandbox', async () => {
    const id = ids.open;
    ids.open = '';
    await rpc('sandbox.delete', { sandboxId: id });
    // The volume goes once its pod is gone.
    await waitFor('pod and volume removed', async () => kubectl('-n', 'cocoon-sandboxes', 'get', 'statefulset,pvc,pod', '-l', `cocoon.dev/sandbox=${id}`, '-o', 'name') === '', 60_000);
  });
});
