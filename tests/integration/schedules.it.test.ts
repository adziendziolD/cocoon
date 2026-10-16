import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { available, rpc, waitFor } from './harness.ts';

const SPOON = 'https://github.com/octocat/Spoon-Knife.git';

/** Scheduled agents with shell agents: the command writes the report to $COCOON_REPORT_FILE itself. */
describe.runIf(available)('scheduled agents', () => {
  let workspaceId: string;

  beforeAll(async () => {
    workspaceId = (await rpc('workspace.create', { name: 'schedules', repo: { url: SPOON }, defaultAgentKind: 'shell' })).id;
  });
  afterAll(async () => {
    if (workspaceId) await rpc('workspace.delete', { workspaceId, deleteSandboxes: true }).catch(() => undefined);
  });

  const waitForStatus = (taskId: string, status: string) =>
    waitFor(`task ${status}`, async () => {
      const task = await rpc('task.get', { taskId });
      return task.status === status ? task : undefined;
    }, 180_000);

  it('validates the cron expression and previews the next runs', async () => {
    await expect(rpc('schedule.create', { workspaceId, name: 'Broken', cron: '0 25 * * *', prompt: 'true' })).rejects.toThrow(/out of range/);
    const preview = await rpc('schedule.preview', { cron: '0 3 * * 1-5', timezone: 'Europe/Berlin', count: 3 });
    expect(preview).toMatchObject({ valid: true, timezone: 'Europe/Berlin' });
    expect(preview.next).toHaveLength(3);
  });

  it('a run whose report says ok is closed automatically and its sandbox removed', async () => {
    const schedule = await rpc('schedule.create', {
      workspaceId,
      name: 'Checks',
      cron: '0 3 * * *',
      timezone: 'UTC',
      agentKind: 'shell',
      prompt: `test -f README.md && echo '{"status":"ok","summary":"README present","report":"- ✅ README"}' > "$COCOON_REPORT_FILE"`,
    });
    expect(schedule.nextRunAt).toMatch(/T03:00:00/);
    const { result, task } = await rpc('schedule.run', { scheduleId: schedule.id });
    expect(result).toBe('started');
    expect(task.scheduleId).toBe(schedule.id);

    const done = await waitForStatus(task.id, 'done');
    expect(done.report).toMatchObject({ status: 'ok', summary: 'README present', details: '- ✅ README' });
    expect(done.sandboxId).toBeUndefined();
    expect((await rpc('schedule.get', { scheduleId: schedule.id })).lastResult).toBe('started');
  });

  it('a run with findings waits for review, and the next run is skipped while it is open', async () => {
    const schedule = await rpc('schedule.create', {
      workspaceId,
      name: 'Findings',
      cron: '0 4 * * 1',
      timezone: 'UTC',
      agentKind: 'shell',
      prompt: `echo '{"status":"action_needed","summary":"2 outdated packages"}' > "$COCOON_REPORT_FILE"`,
    });
    const { task } = await rpc('schedule.run', { scheduleId: schedule.id });
    const review = await waitForStatus(task.id, 'review');
    expect(review.report).toMatchObject({ status: 'action_needed', summary: '2 outdated packages' });
    expect(review.sandboxId).toBeTruthy();

    const again = await rpc('schedule.run', { scheduleId: schedule.id });
    expect(again.result).toBe('skipped');

    await rpc('schedule.delete', { scheduleId: schedule.id, deleteTasks: true });
    await expect(rpc('task.get', { taskId: task.id })).rejects.toThrow();
    await expect(rpc('sandbox.get', { sandboxId: review.sandboxId })).rejects.toThrow();
  });
});
