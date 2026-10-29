import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentStatus } from '@cocoon/protocol';
import { ActivityLog } from './activity.ts';
import type { AgentManager } from './agents/manager.ts';
import { EventBus } from './events.ts';
import type { Notifier } from './notifications.ts';
import type { SandboxManager } from './sandbox/manager.ts';
import type { WorkspaceService as FilesService } from './sandbox/workspace.ts';
import { SettingsService } from './settings.ts';
import { Store, type SandboxRecord } from './store.ts';
import { TaskService } from './tasks.ts';
import { WorkspaceService } from './workspaces.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-tasks-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** TaskService with fake sandboxes (no repository, so approving needs no push) and fake agents. */
function engine() {
  const store = new Store(dir);
  const bus = new EventBus();
  const activity = new ActivityLog(bus);
  const settings = new SettingsService(store, bus, undefined);
  const workspaces = new WorkspaceService(store, bus, activity);
  const ws = workspaces.create({ name: 'Shop' });
  let agentNo = 0;
  const sandboxes = {
    create: async (_p: unknown, opts: { taskId?: string }) => {
      const record = { id: 'sb_1', name: 'x', status: 'running', workdir: '/workspace', taskId: opts.taskId, workspaceId: ws.id, createdAt: 'x', proxyToken: 't' } as unknown as SandboxRecord;
      store.putSandbox(record);
      return record;
    },
    start: async () => undefined,
    delete: async (id: string) => store.deleteSandbox(id),
    sh: async () => '',
  } as unknown as SandboxManager;
  const files = { checkoutBranch: async () => undefined, diff: async () => ({ files: [] }) } as unknown as FilesService;
  const agents = {
    spawn: async (p: { sandboxId: string; kind: string }) => {
      const agent = { id: `ag_${++agentNo}`, sandboxId: p.sandboxId, kind: p.kind, status: 'working' } as Agent;
      store.putAgent(agent);
      return agent;
    },
    kill: async () => undefined,
    read: async () => '',
  } as unknown as AgentManager;
  const notifier = { notify: () => undefined } as unknown as Notifier;
  const tasks = new TaskService(store, bus, settings, workspaces, sandboxes, files, agents, notifier, () => undefined);
  const report = (agentId: string, status: AgentStatus, exitCode?: number | null) => {
    const agent = { ...store.agent(agentId)!, status, ...(exitCode !== undefined ? { exitCode } : {}) };
    store.putAgent(agent);
    bus.publish({ type: 'agent.updated', agent });
  };
  const status = (taskId: string) => store.task(taskId)?.status;
  return { store, tasks, settings, ws, report, status };
}

/** Starts a task and waits until its agent is spawned. */
async function running(e: ReturnType<typeof engine>) {
  const task = e.tasks.create({ workspaceId: e.ws.id, title: 'Add dark mode' });
  e.tasks.start(task.id);
  await vi.waitFor(() => expect(e.store.task(task.id)?.agentId).toBeDefined());
  return e.store.task(task.id)!;
}

describe('TaskService: failed tasks whose agent finished after all', () => {
  it('marks a failed task as finished, so it can be approved', async () => {
    const e = engine();
    const task = await running(e);
    e.report(task.agentId!, 'exited', 1);
    expect(e.status(task.id)).toBe('failed');
    expect(e.tasks.get(task.id).runs.at(-1)?.outcome).toBe('failed');

    const marked = e.tasks.markFinished(task.id);
    expect(marked).toMatchObject({ status: 'review', attention: false, noteKey: 'note.markedFinished' });
    expect(marked.runs.at(-1)?.outcome).toBe('finished');

    const approved = await e.tasks.approve(task.id);
    expect(approved.status).toBe('done');
  });

  it('only marks failed tasks as finished', async () => {
    const e = engine();
    const task = await running(e);
    expect(() => e.tasks.markFinished(task.id)).toThrow(/has not failed|nicht fehlgeschlagen/);
    e.report(task.agentId!, 'done');
    expect(e.status(task.id)).toBe('review');
    expect(() => e.tasks.markFinished(task.id)).toThrow(/has not failed|nicht fehlgeschlagen/);
  });

  it('follows an agent that was declared gone but finishes after all', async () => {
    const e = engine();
    const task = await running(e);
    e.report(task.agentId!, 'exited', null);
    expect(e.store.task(task.id)).toMatchObject({ status: 'failed', noteKey: 'note.agentGone' });

    e.report(task.agentId!, 'done');
    expect(e.store.task(task.id)).toMatchObject({ status: 'review', noteKey: undefined });
    expect(e.store.task(task.id)?.runs.at(-1)).toMatchObject({ outcome: 'finished' });
  });

  it('runs again when the agent of a failed task works again, and goes to review when it is done', async () => {
    const e = engine();
    const task = await running(e);
    e.report(task.agentId!, 'exited', 2);
    e.report(task.agentId!, 'working');
    expect(e.store.task(task.id)?.status).toBe('running');
    expect(e.store.task(task.id)?.runs.at(-1)).toMatchObject({ outcome: 'running', finishedAt: undefined });

    e.report(task.agentId!, 'exited', 0);
    expect(e.status(task.id)).toBe('review');
  });

  it('stays failed while the agent stays failed or idle', async () => {
    const e = engine();
    const task = await running(e);
    e.report(task.agentId!, 'exited', 1);
    e.report(task.agentId!, 'exited', 1);
    e.report(task.agentId!, 'idle');
    expect(e.status(task.id)).toBe('failed');
  });

  it('does not bring back a task that was retried with a new agent', async () => {
    const e = engine();
    const task = await running(e);
    const first = task.agentId!;
    e.report(first, 'exited', 1);
    e.tasks.start(task.id);
    await vi.waitFor(() => expect(e.store.task(task.id)?.agentId).not.toBe(first));
    e.report(first, 'done');
    expect(e.store.task(task.id)).toMatchObject({ status: 'running', runs: [{ agentId: first, outcome: 'failed' }, { outcome: 'running' }] });
  });

  it('follows the agent a failed task was switched to', async () => {
    const e = engine();
    const task = await running(e);
    e.report(task.agentId!, 'exited', 1);
    const next = { id: 'ag_next', sandboxId: 'sb_1', kind: 'codex', status: 'working' } as Agent;
    e.store.putAgent(next);
    e.tasks.adoptAgent(task.agentId!, next);
    expect(e.store.task(task.id)).toMatchObject({ status: 'running', agentId: 'ag_next' });
    expect(e.store.task(task.id)?.runs.at(-1)).toMatchObject({ agentId: 'ag_next', outcome: 'running', stageName: 'codex' });

    e.report('ag_next', 'done');
    expect(e.status(task.id)).toBe('review');
  });
});

describe('TaskService: removed workflows', () => {
  const workflow = { label: 'Build', stages: [{ name: 'Build', agentKind: 'shell', prompt: '{{task}}', approval: false }] };

  /** A running task of workflow "build". */
  async function withWorkflow(e: ReturnType<typeof engine>) {
    e.settings.update({ workflows: { build: workflow } });
    const task = e.tasks.create({ workspaceId: e.ws.id, title: 'Add dark mode', workflowId: 'build' });
    e.tasks.start(task.id);
    await vi.waitFor(() => expect(e.store.task(task.id)?.agentId).toBeDefined());
    return e.store.task(task.id)!;
  }

  it('fails the task instead of throwing when its workflow is gone as the agent finishes', async () => {
    const e = engine();
    const task = await withWorkflow(e);
    e.settings.update({ workflows: {} });
    expect(() => e.report(task.agentId!, 'done')).not.toThrow();
    expect(e.store.task(task.id)).toMatchObject({ status: 'failed', noteKey: 'note.workflowGone' });
  });

  it('refuses settings that drop a workflow of an unfinished task', async () => {
    const e = engine();
    const task = await withWorkflow(e);
    expect(() => e.tasks.assertWorkflowsUnused({})).toThrow(/build/);
    expect(() => e.tasks.assertWorkflowsUnused({ build: workflow })).not.toThrow();
    e.report(task.agentId!, 'exited', 1);
    expect(() => e.tasks.assertWorkflowsUnused({})).not.toThrow();
  });

  it('keeps the settings unchanged when a guard vetoes them', async () => {
    const e = engine();
    await withWorkflow(e);
    e.settings.addGuard((next) => e.tasks.assertWorkflowsUnused(next.workflows));
    expect(() => e.settings.update({ workflows: {} })).toThrow(/build/);
    expect(e.settings.get().workflows).toHaveProperty('build');
  });
});
