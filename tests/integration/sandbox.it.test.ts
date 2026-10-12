import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { available, createSandbox, rpc, sh, waitFor } from './harness.ts';

describe.runIf(available)('sandbox lifecycle, files, agents and egress', () => {
  let id: string;

  beforeAll(async () => {
    id = (await createSandbox({ name: 'basic' })).id;
  });
  afterAll(async () => {
    if (id) await rpc('sandbox.delete', { sandboxId: id }).catch(() => undefined);
  });

  it('runs as a non-root user in /workspace with an empty baseline repository', async () => {
    const sb = await rpc('sandbox.get', { sandboxId: id });
    expect(sb.status).toBe('running');
    const res = await sh(id, 'id -u; pwd; git -C /workspace log --oneline | wc -l');
    expect(res.exitCode).toBe(0);
    const [uid, cwd, commits] = res.stdout.trim().split('\n');
    expect(uid).not.toBe('0');
    expect(cwd).toBe('/workspace');
    expect(commits).toBe('1');
  });

  it('writes and reads files and reports them in the diff', async () => {
    await rpc('files.write', { sandboxId: id, path: 'src/hello.txt', content: 'Hallo CoCoon\n' });
    const read = await rpc('files.read', { sandboxId: id, path: 'src/hello.txt' });
    expect(read.content).toBe('Hallo CoCoon\n');
    const listing = await rpc('files.list', { sandboxId: id, path: 'src' });
    expect(listing.entries.map((e: { name: string }) => e.name)).toContain('hello.txt');
    const diff = await rpc('sandbox.diff', { sandboxId: id });
    expect(diff.files).toEqual(['src/hello.txt']);
    expect(diff.patch).toContain('+Hallo CoCoon');
  });

  it('commits and applies patches', async () => {
    const { sha } = await rpc('git.commit', { sandboxId: id, message: 'add hello' });
    expect(sha).toMatch(/^[0-9a-f]{7,}$/);
    const status = await rpc('git.status', { sandboxId: id });
    expect(status.files).toEqual([]);
    const patch = 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+patched\n';
    const applied = await rpc('sandbox.apply_patch', { sandboxId: id, patch });
    expect(applied.applied).toBe(true);
    expect((await sh(id, 'cat new.txt')).stdout.trim()).toBe('patched');
  });

  it('starts a shell agent, sends input and reads its screen', async () => {
    const agent = await rpc('agent.spawn', { sandboxId: id, kind: 'shell' });
    await rpc('agent.send_input', { agentId: agent.id, text: 'echo "agent-$((40+2))"' });
    const screen = await waitFor('agent output', async () => {
      const { text } = await rpc('agent.read', { agentId: agent.id, lines: 40 });
      return text.includes('agent-42') && text;
    });
    expect(screen).toContain('agent-42');
    await rpc('agent.kill', { agentId: agent.id });
    await waitFor('agent exit', async () => (await rpc('agent.get', { agentId: agent.id })).status === 'exited', 30_000);
  });

  it('restricted network: allowlisted hosts work, everything else is blocked by the egress proxy', async () => {
    const allowed = await sh(id, 'curl -s -o /dev/null -w "%{http_code}" --max-time 20 https://github.com');
    expect(['200', '301', '302']).toContain(allowed.stdout.trim());
    const blocked = await sh(id, 'curl -s -o /dev/null -w "%{http_code}" --max-time 20 https://example.org; echo " exit=$?"');
    expect(blocked.stdout).not.toMatch(/^200/);
    const denied = await waitFor('denied entry', async () => {
      const list = await rpc('egress.denied');
      return list.find((d: { host: string }) => d.host === 'example.org');
    }, 30_000);
    expect(denied).toBeTruthy();
  });

  it('stops and starts again with files kept', async () => {
    await rpc('sandbox.stop', { sandboxId: id });
    expect((await rpc('sandbox.get', { sandboxId: id })).status).toBe('stopped');
    await rpc('sandbox.start', { sandboxId: id });
    expect((await sh(id, 'cat src/hello.txt')).stdout).toBe('Hallo CoCoon\n');
  });
});
