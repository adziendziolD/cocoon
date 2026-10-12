import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { available, createSandbox, rpc, sh } from './harness.ts';

const HELLO = 'https://github.com/octocat/Hello-World.git';
const SPOON = 'https://github.com/octocat/Spoon-Knife.git';

describe.runIf(available)('several repositories per sandbox', () => {
  let id: string;

  beforeAll(async () => {
    const sb = await createSandbox({ name: 'repos', repos: [{ url: HELLO, path: 'api' }, { url: SPOON }] });
    id = sb.id;
    expect(sb.repos).toEqual([
      { url: HELLO, path: 'api' },
      { url: SPOON, path: 'Spoon-Knife' },
    ]);
  });
  afterAll(async () => {
    if (id) await rpc('sandbox.delete', { sandboxId: id }).catch(() => undefined);
  });

  it('clones every repository into its own folder and tells agents about the layout', async () => {
    const res = await sh(id, 'ls /workspace; git -C /workspace/api remote get-url origin; sed -n "/cocoon-repos:start/,/cocoon-repos:end/p" ~/.claude/CLAUDE.md');
    expect(res.stdout).toContain('Spoon-Knife\napi');
    expect(res.stdout).toContain(HELLO);
    expect(res.stdout).toContain('`api` – https://github.com/octocat/Hello-World.git');
    expect(res.stdout).toContain('`Spoon-Knife` – https://github.com/octocat/Spoon-Knife.git');
  });

  it('git operations need a repository folder when there are several', async () => {
    await expect(rpc('git.status', { sandboxId: id })).rejects.toThrow(/several repositories|mehrere Repositories/);
    await expect(rpc('git.status', { sandboxId: id, repo: 'nope' })).rejects.toThrow(/nope/);
  });

  it('reports changes per repository and as one combined patch', async () => {
    await sh(id, 'echo change >> /workspace/api/README && echo neu > /workspace/Spoon-Knife/neu.txt');
    const repos = await rpc('git.repos', { sandboxId: id });
    expect(repos.map((r: { path: string; changes: number }) => [r.path, r.changes])).toEqual([
      ['api', 1],
      ['Spoon-Knife', 1],
    ]);
    const diff = await rpc('sandbox.diff', { sandboxId: id });
    expect(diff.files).toEqual(['api/README', 'Spoon-Knife/neu.txt']);
    expect(diff.repos).toEqual([
      { path: 'api', files: ['README'] },
      { path: 'Spoon-Knife', files: ['neu.txt'] },
    ]);
    expect(diff.patch).toContain('diff --git a/api/README b/api/README');
    expect(diff.patch).toContain('b/Spoon-Knife/neu.txt');
    const single = await rpc('sandbox.diff', { sandboxId: id, repo: 'Spoon-Knife' });
    expect(single.files).toEqual(['neu.txt']);
    expect(single.patch).toContain('b/neu.txt');
  });

  it('commits one repository without touching the other', async () => {
    const { sha } = await rpc('git.commit', { sandboxId: id, repo: 'api', message: 'change api' });
    expect(sha).toBeTruthy();
    expect((await rpc('git.status', { sandboxId: id, repo: 'api' })).files).toEqual([]);
    expect((await rpc('git.status', { sandboxId: id, repo: 'Spoon-Knife' })).files).toHaveLength(1);
  });

  it('applies a patch to a chosen repository', async () => {
    const { patch } = await rpc('sandbox.diff', { sandboxId: id, repo: 'Spoon-Knife' });
    await sh(id, 'cd /workspace/Spoon-Knife && git reset -q --hard && git clean -qfd');
    const res = await rpc('sandbox.apply_patch', { sandboxId: id, repo: 'Spoon-Knife', patch });
    expect(res.applied).toBe(true);
    expect((await sh(id, 'cat /workspace/Spoon-Knife/neu.txt')).stdout.trim()).toBe('neu');
  });

  it('adds and removes repositories later', async () => {
    const added = await rpc('sandbox.add_repo', { sandboxId: id, url: HELLO, path: 'libs/hello' });
    expect(added.repos.map((r: { path: string }) => r.path)).toEqual(['api', 'Spoon-Knife', 'libs/hello']);
    await expect(rpc('sandbox.add_repo', { sandboxId: id, url: SPOON, path: 'api' })).rejects.toThrow(/api/);
    // A failing clone is an error, not an empty folder.
    await expect(rpc('sandbox.add_repo', { sandboxId: id, url: 'https://github.com/octocat/cocoon-does-not-exist.git', path: 'missing' })).rejects.toThrow(
      /cocoon-does-not-exist/,
    );
    expect((await sh(id, 'git -C /workspace/libs/hello log --oneline | wc -l')).stdout.trim()).not.toBe('0');
    const removed = await rpc('sandbox.remove_repo', { sandboxId: id, repo: 'libs/hello' });
    expect(removed.repos).toHaveLength(2);
    expect((await sh(id, 'test -e /workspace/libs/hello && echo yes || echo no')).stdout.trim()).toBe('no');
  });
});

describe.runIf(available)('a single repository stays in /workspace itself', () => {
  it('clones into the workspace folder and needs no repo parameter', async () => {
    const sb = await createSandbox({ name: 'single', repo: { url: SPOON } });
    try {
      expect(sb.repos).toEqual([{ url: SPOON, path: '' }]);
      const status = await rpc('git.status', { sandboxId: sb.id });
      expect(status.remoteUrl).toBe(SPOON);
      // Adding a second repository nests it and keeps it out of the outer repository.
      await rpc('sandbox.add_repo', { sandboxId: sb.id, url: HELLO });
      const outer = await rpc('git.status', { sandboxId: sb.id, repo: '' });
      expect(outer.files).toEqual([]);
    } finally {
      await rpc('sandbox.delete', { sandboxId: sb.id });
    }
  });
});
