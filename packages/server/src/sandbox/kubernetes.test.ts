import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execPreamble, networkPolicies, sandboxName, sandboxStatefulSet, type KubernetesOptions } from './kubernetes.ts';

const opts: KubernetesOptions = {
  namespace: 'cocoon-sandboxes',
  workspaceSize: '20Gi',
  sandboxNodes: 'cocoon.dev/sandbox=true',
  service: 'cocoon',
  controlLabels: { 'app.kubernetes.io/name': 'cocoon' },
  proxyPorts: [7431, 7432],
  probeImage: 'node',
};

describe('execPreamble', () => {
  it('hands values to the shell unchanged, whatever they contain', () => {
    const value = `it's "quoted" $HOME \`id\`\nsecond line`;
    const out = execFileSync('sh', ['-c', `${execPreamble({ env: { VALUE: value }, workdir: '/tmp' })}\nprintf '%s|%s' "$VALUE" "$PWD"`], { encoding: 'utf8' });
    expect(out).toBe(`${value}|/tmp`);
  });

  it('refuses names that would be shell code', () => {
    expect(() => execPreamble({ env: { 'A; rm -rf /': '1' } })).toThrow(/invalid environment variable name/);
  });
});

describe('sandbox pod', () => {
  const set = sandboxStatefulSet(
    { sandboxId: 'sb_1A2b', name: 'demo', image: 'img', network: 'egress', runtime: 'gvisor', resources: { cpus: 1.5, memoryMb: 2048, pids: 100 }, workdir: '/workspace', env: { A: 'b' }, toolbox: true },
    opts,
  );
  const pod = set.spec!.template.spec!;

  it('is named after the sandbox and starts stopped', () => {
    expect(sandboxName('sb_1A2b')).toBe('cocoon-sb-1a2b');
    expect(set.metadata!.name).toBe('cocoon-sb-1a2b');
    expect(set.spec!.replicas).toBe(0);
  });

  it('gets no API token, no root and no capabilities, and only runs on the sandbox nodes', () => {
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000 });
    for (const container of [...pod.initContainers!, ...pod.containers]) expect(container.securityContext).toEqual({ allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
    expect(pod.nodeSelector).toEqual({ 'cocoon.dev/sandbox': 'true' });
    expect(pod.tolerations).toEqual([{ key: 'cocoon.dev/sandbox', operator: 'Equal', value: 'true', effect: 'NoSchedule' }]);
  });

  it('carries limits, runtime, network label and a read-only toolbox', () => {
    expect(pod.containers[0]!.resources!.limits).toEqual({ cpu: '1500m', memory: '2048Mi', 'ephemeral-storage': '10Gi' });
    expect(pod.runtimeClassName).toBe('gvisor');
    expect(set.spec!.template.metadata!.labels!['cocoon.dev/network']).toBe('egress');
    expect(pod.containers[0]!.volumeMounts!.find((m) => m.name === 'toolbox')!.readOnly).toBe(true);
  });
});

describe('volume init container', () => {
  it('builds the home once, also after a copy that was interrupted', () => {
    const script = sandboxStatefulSet({ sandboxId: 'sb_1', name: 'x', image: 'img', network: 'none', runtime: null, resources: {}, workdir: '/workspace', env: {}, toolbox: false }, opts)
      .spec!.template.spec!.initContainers![0]!.command![2]!;
    const dir = mkdtempSync(join(tmpdir(), 'cocoon-vol-'));
    try {
      mkdirSync(join(dir, 'home.new'));
      writeFileSync(join(dir, 'home.new', 'half'), '');
      const run = () => execFileSync('sh', ['-c', script.replace('cd /data', `cd '${dir}'`)]);
      run();
      expect(existsSync(join(dir, 'home.new'))).toBe(false);
      expect(existsSync(join(dir, 'home', 'half'))).toBe(false);
      writeFileSync(join(dir, 'home', 'kept'), '');
      run();
      expect(existsSync(join(dir, 'home', 'kept'))).toBe(true);
      expect(existsSync(join(dir, 'workspace'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('network policies', () => {
  const policies = Object.fromEntries(networkPolicies(opts, 'cocoon').map((p) => [p.metadata!.name!, p.spec!]));

  it('deny everything for every pod first', () => {
    expect(policies['cocoon-default-deny']).toEqual({ podSelector: {}, policyTypes: ['Ingress', 'Egress'] });
  });

  it('let sandboxes with network reach only the proxy ports of cocoond', () => {
    const [rule] = policies['cocoon-to-proxy']!.egress!;
    expect(rule!.ports!.map((p) => p.port)).toEqual([7431, 7432]);
    expect(rule!.to![0]!.podSelector!.matchLabels).toEqual({ 'app.kubernetes.io/name': 'cocoon' });
  });

  it('keep "open" sandboxes out of private and link-local ranges (cluster, nodes, cloud metadata)', () => {
    const block = policies['cocoon-open']!.egress![0]!.to![0]!.ipBlock!;
    expect(block.cidr).toBe('0.0.0.0/0');
    expect(block.except).toEqual(expect.arrayContaining(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']));
  });
});
