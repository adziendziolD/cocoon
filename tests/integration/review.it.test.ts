import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { available, rpc, sh, waitFor } from './harness.ts';

const SPOON = 'https://github.com/octocat/Spoon-Knife.git';

/**
 * Test reviewer: gets the review prompt as $1, finds the verdict file in it and writes a verdict –
 * "changes_requested" if the task contains PLEASE-REJECT; the summary tells whether it saw a GitHub token.
 */
const REVIEWER_SCRIPT = `f=$(printf '%s' "$1" | grep -o '/home/agent/.cocoon/review/[^ ]*\\.json' | head -1)
verdict=approved; case "$1" in *PLEASE-REJECT*) verdict=changes_requested;; esac
tok=no; [ -n "$GITHUB_TOKEN" ] && tok=yes
mkdir -p "$(dirname "$f")"; printf '{"verdict":"%s","summary":"reviewed token=%s"}' "$verdict" "$tok" > "$f"`;

/** The working stage: a shell task that points origin to a bare repository in the sandbox and changes a file. */
const WORK = (extra = '') => `git init -q --bare /home/agent/remote.git && git remote set-url origin /home/agent/remote.git && echo change > change.txt ${extra}`;

async function untilStatus(taskId: string, status: string, timeout = 180_000): Promise<any> {
  return waitFor(`task ${status}`, async () => {
    const task = await rpc('task.get', { taskId });
    return task.status === status && (status !== 'review' || task.sandboxId) ? task : undefined;
  }, timeout);
}

describe.runIf(available)('code review on approval and task numbers', () => {
  let workspaceId: string;
  let agents: Record<string, unknown>;

  beforeAll(async () => {
    const settings = await rpc('settings.get');
    agents = settings.agents;
    await rpc('settings.update', {
      agents: {
        ...agents,
        'test-reviewer': { label: 'Test reviewer', command: ['bash', '-c', REVIEWER_SCRIPT, 'reviewer'], promptMode: 'arg' },
      },
    });
    workspaceId = (
      await rpc('workspace.create', {
        name: 'Review Test',
        repo: { url: SPOON },
        defaultAgentKind: 'shell',
        review: { enabled: true, agentKinds: ['test-reviewer', 'test-reviewer'], agentPushes: false },
      })
    ).id;
  });
  afterAll(async () => {
    await rpc('secrets.delete', { name: 'GITHUB_TOKEN' }).catch(() => undefined);
    if (workspaceId) await rpc('workspace.delete', { workspaceId, deleteSandboxes: true }).catch(() => undefined);
    if (agents) await rpc('settings.update', { agents }).catch(() => undefined);
  });

  it('numbers tasks per workspace and derives branch names', async () => {
    const ws = await rpc('workspace.get', { workspaceId });
    expect(ws.key).toBe('RT');
    const a = await rpc('task.create', { workspaceId, title: 'Add Apple Pay', agentKind: 'shell' });
    const b = await rpc('task.create', { workspaceId, title: 'Second one', agentKind: 'shell' });
    expect([a.handle, b.handle]).toEqual(['RT-1', 'RT-2']);
    expect(a.branch).toBe('RT-1-add-apple-pay');
    // A taken key is refused.
    await expect(rpc('workspace.create', { name: 'Other', key: 'RT' })).rejects.toThrow(/RT/);
    await rpc('task.delete', { taskId: a.id });
    await rpc('task.delete', { taskId: b.id });
  });

  it('approving runs the review agents in the same sandbox, then pushes the task branch and removes the sandbox', async () => {
    const task = await rpc('task.create', { workspaceId, title: 'Notes file', agentKind: 'shell', description: WORK() });
    await rpc('task.start', { taskId: task.id });
    const review = await untilStatus(task.id, 'review');
    // The task sandbox works on the task branch.
    expect((await sh(review.sandboxId, 'git -C /workspace rev-parse --abbrev-ref HEAD')).stdout.trim()).toBe(review.branch);

    await rpc('task.approve', { taskId: task.id });
    const done = await untilStatus(task.id, 'done');
    expect(done.reviews.map((r: any) => r.verdict)).toEqual(['approved', 'approved']);
    expect(done.reviews[0].summary).toBe('reviewed token=no');
    expect(done.note).toContain(review.branch);
    expect(done.sandboxId).toBeUndefined();
    await expect(rpc('sandbox.get', { sandboxId: review.sandboxId })).rejects.toThrow();
  });

  it('"changes requested" brings the task back to review and keeps the sandbox', async () => {
    const task = await rpc('task.create', { workspaceId, title: 'Rejected work', agentKind: 'shell', description: WORK('# PLEASE-REJECT') });
    await rpc('task.start', { taskId: task.id });
    const review = await untilStatus(task.id, 'review');
    await rpc('task.approve', { taskId: task.id });
    const back = await waitFor('review verdict', async () => {
      const t = await rpc('task.get', { taskId: task.id });
      return t.status === 'review' && t.reviews.length ? t : undefined;
    }, 180_000);
    expect(back.reviews.map((r: any) => r.verdict)).toEqual(['changes_requested']);
    expect(back.note).toMatch(/reviewed token=no/);
    expect(back.reviewStep).toBeUndefined();
    expect((await rpc('sandbox.get', { sandboxId: review.sandboxId })).status).toBe('running');
  });

  it('gives the GitHub token only to the last review agent, and only with the setting on', async () => {
    await rpc('workspace.update', { workspaceId, review: { enabled: true, agentKinds: ['test-reviewer', 'test-reviewer'], agentPushes: true } });
    const task = await rpc('task.create', { workspaceId, title: 'With token', agentKind: 'shell', description: WORK() });
    await rpc('task.start', { taskId: task.id });
    await untilStatus(task.id, 'review');
    // Set the token only now: the repository was cloned from GitHub without it.
    await rpc('secrets.set', { name: 'GITHUB_TOKEN', value: 'ghp_cocoon_integration_test_token' });
    await rpc('task.approve', { taskId: task.id });
    const done = await untilStatus(task.id, 'done');
    expect(done.reviews.map((r: any) => r.summary)).toEqual(['reviewed token=no', 'reviewed token=yes']);
    await rpc('secrets.delete', { name: 'GITHUB_TOKEN' });
  });
});
