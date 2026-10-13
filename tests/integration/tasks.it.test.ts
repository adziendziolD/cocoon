import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { available, createSandbox, rpc, sh, waitFor } from './harness.ts';

const SPOON = 'https://github.com/octocat/Spoon-Knife.git';

/** Starts a shell task and waits until its agent is done and the task waits for review. */
async function runToReview(taskId: string, command: string): Promise<any> {
  await rpc('task.update', { taskId, description: command });
  await rpc('task.start', { taskId });
  return waitFor('task in review', async () => {
    const task = await rpc('task.get', { taskId });
    return task.status === 'review' && task.sandboxId ? task : undefined;
  }, 180_000);
}

describe.runIf(available)('task sandboxes', () => {
  let workspaceId: string;
  const sandboxes: string[] = [];

  beforeAll(async () => {
    workspaceId = (await rpc('workspace.create', { name: 'task-sandboxes', repo: { url: SPOON }, defaultAgentKind: 'shell' })).id;
  });
  afterAll(async () => {
    for (const sandboxId of sandboxes) await rpc('sandbox.delete', { sandboxId }).catch(() => undefined);
    if (workspaceId) await rpc('workspace.delete', { workspaceId, deleteSandboxes: true }).catch(() => undefined);
  });

  it('accepting a task with its own sandbox commits, pushes and removes the sandbox', async () => {
    const task = await rpc('task.create', { workspaceId, title: 'Add notes file', agentKind: 'shell' });
    // The remote is a bare repository inside the sandbox, so no GitHub token is needed.
    const review = await runToReview(
      task.id,
      'git init -q --bare /home/agent/remote.git && git remote set-url origin /home/agent/remote.git && echo hi > notes.txt',
    );
    const own = await rpc('sandbox.get', { sandboxId: review.sandboxId });
    expect(own.taskId).toBe(task.id);

    const done = await rpc('task.approve', { taskId: task.id });
    expect(done.status).toBe('done');
    expect(done.sandboxId).toBeUndefined();
    // Pushed to the task branch, e.g. TS-1-add-notes-file.
    expect(review.branch).toMatch(/^[A-Z][A-Z0-9]+-\d+-add-notes-file$/);
    expect(done.note).toContain(review.branch);
    await expect(rpc('sandbox.get', { sandboxId: review.sandboxId })).rejects.toThrow();
  });

  it('keeps the task in review and the sandbox when pushing fails', async () => {
    const task = await rpc('task.create', { workspaceId, title: 'Push without token', agentKind: 'shell' });
    // github.com without a GitHub token cannot be pushed to.
    const review = await runToReview(task.id, 'echo change > change.txt');
    sandboxes.push(review.sandboxId);
    await expect(rpc('task.approve', { taskId: task.id })).rejects.toThrow(/stays in|bleibt in/);
    expect((await rpc('task.get', { taskId: task.id })).status).toBe('review');
    expect((await rpc('sandbox.get', { sandboxId: review.sandboxId })).status).toBe('running');
    // The work was committed and is still there.
    expect((await sh(review.sandboxId, 'git -C /workspace log -1 --format=%s')).stdout.trim()).toBe('Push without token');
  });

  it('a hand-picked sandbox is used and kept', async () => {
    const picked = await createSandbox({ name: 'picked', repo: { url: SPOON }, workspaceId });
    sandboxes.push(picked.id);
    const task = await rpc('task.create', { workspaceId, title: 'Work in picked', agentKind: 'shell', sandboxId: picked.id });
    const review = await runToReview(task.id, 'echo picked > picked.txt');
    expect(review.sandboxId).toBe(picked.id);
    const done = await rpc('task.approve', { taskId: task.id });
    expect(done.status).toBe('done');
    expect((await rpc('sandbox.get', { sandboxId: picked.id })).status).toBe('running');
  });

  it('shared mode adopts an existing sandbox of the workspace instead of creating one', async () => {
    const existing = await createSandbox({ name: 'existing', repo: { url: SPOON }, workspaceId });
    sandboxes.push(existing.id);
    await rpc('workspace.update', { workspaceId, sandboxMode: 'shared' });
    const before = (await rpc('sandbox.list')).length;
    const task = await rpc('task.create', { workspaceId, title: 'Shared work', agentKind: 'shell' });
    const review = await runToReview(task.id, 'echo shared > shared.txt');
    // Both "picked" and "existing" are running and belong to no task; the newest one wins.
    expect(review.sandboxId).toBe(existing.id);
    expect((await rpc('sandbox.list')).length).toBe(before);
    expect((await rpc('workspace.get', { workspaceId })).sharedSandboxId).toBe(review.sandboxId);
  });
});
