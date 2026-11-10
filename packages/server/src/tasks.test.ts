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
  let sandboxNo = 0;
  const killed: string[] = [];
  // Tests can hold back spawning an agent and reading a result file to provoke the races of slow starts.
  let spawnGate: Promise<void> = Promise.resolve();
  let shGate: Promise<void> = Promise.resolve();
  let checkGate: Promise<void> = Promise.resolve();
  // Loop tests: results of the requirement check (first in, first out; default = met), and what the agents were sent.
  const checkResults: ({ exitCode: number; output: string } | Error)[] = [];
  const checked: string[] = [];
  const spawned: { id: string; kind: string; prompt?: string }[] = [];
  const sent: string[] = [];
  // What shell commands in the sandbox print: the verdict file of a review agent in the review tests.
  let shOutput = '';
  const hold = (which: 'spawn' | 'sh' | 'check') => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    if (which === 'spawn') spawnGate = gate;
    else if (which === 'check') checkGate = gate;
    else shGate = gate;
    return release;
  };
  const sandboxes = {
    create: async (_p: unknown, opts: { taskId?: string }) => {
      const record = { id: `sb_${++sandboxNo}`, name: 'x', status: 'running', workdir: '/workspace', taskId: opts.taskId, workspaceId: ws.id, createdAt: 'x', proxyToken: 't' } as unknown as SandboxRecord;
      store.putSandbox(record);
      return record;
    },
    start: async () => undefined,
    delete: async (id: string) => store.deleteSandbox(id),
    sh: async () => {
      await shGate;
      return shOutput;
    },
  } as unknown as SandboxManager;
  const files = { checkoutBranch: async () => undefined, diff: async () => ({ files: [] }), publish: async () => ({ pushed: [] }) } as unknown as FilesService;
  const agents = {
    spawn: async (p: { sandboxId: string; kind: string; prompt?: string }) => {
      await spawnGate;
      const agent = { id: `ag_${++agentNo}`, sandboxId: p.sandboxId, kind: p.kind, status: 'working' } as Agent;
      spawned.push({ id: agent.id, kind: p.kind, prompt: p.prompt });
      store.putAgent(agent);
      return agent;
    },
    kill: async (id: string) => {
      killed.push(id);
    },
    read: async () => '',
    sendInput: async (p: { text: string }) => {
      sent.push(p.text);
    },
    runCheck: async (_sandboxId: string, command: string) => {
      checked.push(command);
      await checkGate;
      const next = checkResults.shift() ?? { exitCode: 0, output: '' };
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as AgentManager;
  const notifier = { notify: () => undefined } as unknown as Notifier;
  const tasks = new TaskService(store, bus, settings, workspaces, sandboxes, files, agents, notifier, () => undefined);
  const report = (agentId: string, status: AgentStatus, exitCode?: number | null) => {
    const agent = { ...store.agent(agentId)!, status, ...(exitCode !== undefined ? { exitCode } : {}) };
    store.putAgent(agent);
    bus.publish({ type: 'agent.updated', agent });
  };
  const status = (taskId: string) => store.task(taskId)?.status;
  const verdict = (value: 'approved' | 'changes_requested' | 'missing', summary = 'Add a test for the empty case') => {
    shOutput = value === 'missing' ? '' : JSON.stringify({ verdict: value, summary });
  };
  return { store, tasks, settings, workspaces, ws, report, status, killed, hold, verdict, checkResults, checked, spawned, sent };
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

describe('TaskService: races', () => {
  it('does not start a second agent or sandbox when a task is stopped and started while it is still starting', async () => {
    const e = engine();
    const release = e.hold('spawn');
    const task = e.tasks.create({ workspaceId: e.ws.id, title: 'Add dark mode' });
    e.tasks.start(task.id);
    await vi.waitFor(() => expect(e.store.sandboxes()).toHaveLength(1));
    e.tasks.stop(task.id);
    e.tasks.start(task.id);
    release();

    await vi.waitFor(() => expect(e.store.task(task.id)?.agentId).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(e.store.sandboxes()).toHaveLength(1);
    expect(e.store.task(task.id)).toMatchObject({ status: 'running', agentId: 'ag_2' });
    expect(e.store.task(task.id)?.runs).toHaveLength(1);
    // The agent of the outdated start was stopped instead of running untracked.
    expect(e.killed).toEqual(['ag_1']);
  });

  it('stops the agent of a task in review when it is stopped, deleted or started again', async () => {
    const stopped = engine();
    const a = await running(stopped);
    stopped.report(a.agentId!, 'done');
    expect(stopped.status(a.id)).toBe('review');
    stopped.tasks.stop(a.id);
    expect(stopped.killed).toEqual([a.agentId]);

    const deleted = engine();
    const b = await running(deleted);
    deleted.report(b.agentId!, 'done');
    await deleted.tasks.delete(b.id);
    expect(deleted.killed).toEqual([b.agentId]);

    const restarted = engine();
    const c = await running(restarted);
    restarted.report(c.agentId!, 'done');
    restarted.tasks.start(c.id);
    expect(restarted.killed).toEqual([c.agentId]);
  });

  it('forgets an agent it stopped as soon as the agent has exited, even if the task moved on', async () => {
    const e = engine();
    const task = await running(e);
    const stopping = (e.tasks as unknown as { stopping: Set<string> }).stopping;
    e.tasks.stop(task.id);
    expect(stopping.has(task.agentId!)).toBe(true);
    // The task is in the backlog by now, so nothing else looks at this agent any more.
    e.report(task.agentId!, 'exited', 143);
    expect(stopping.size).toBe(0);
  });

  it('publishes only once when a task is approved twice at the same time', async () => {
    const e = engine();
    const task = await running(e);
    e.report(task.agentId!, 'done');
    const first = e.tasks.approve(task.id);
    await expect(e.tasks.approve(task.id)).rejects.toThrow(/being finished/);
    await first;
    expect(e.status(task.id)).toBe('done');
    // Afterwards the usual "not in review" applies.
    await expect(e.tasks.approve(task.id)).rejects.toThrow(/review/);
  });

  it('does not bring back a task that was deleted while its review result was read', async () => {
    const e = engine();
    e.workspaces.update({ workspaceId: e.ws.id, review: { enabled: true, agentKinds: ['shell'], agentPushes: false } });
    const task = await running(e);
    e.report(task.agentId!, 'done');
    await e.tasks.approve(task.id);
    await vi.waitFor(() => expect(e.store.task(task.id)).toMatchObject({ status: 'running', reviewStep: 0 }));
    await vi.waitFor(() => expect(e.store.task(task.id)?.runs).toHaveLength(2));

    const release = e.hold('sh');
    e.report(e.store.task(task.id)!.agentId!, 'done');
    await e.tasks.delete(task.id);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(e.store.task(task.id)).toBeUndefined();
  });
});

describe('TaskService: update cannot skip review and publishing', () => {
  it('refuses status done for running, failed and review tasks and leaves them untouched', async () => {
    const e = engine();
    const task = await running(e);
    expect(() => e.tasks.update({ taskId: task.id, status: 'done', title: 'sneaky' })).toThrow(/already started|schon gestartet/);
    expect(e.store.task(task.id)).toMatchObject({ status: 'running', title: 'Add dark mode' });

    e.report(task.agentId!, 'exited', 1);
    expect(e.status(task.id)).toBe('failed');
    expect(() => e.tasks.update({ taskId: task.id, status: 'done' })).toThrow(/already started|schon gestartet/);
    expect(e.status(task.id)).toBe('failed');

    e.tasks.markFinished(task.id);
    expect(e.status(task.id)).toBe('review');
    expect(() => e.tasks.update({ taskId: task.id, status: 'done' })).toThrow(/already started|schon gestartet/);
    expect(e.status(task.id)).toBe('review');

    // The way to done stays open: approve.
    expect((await e.tasks.approve(task.id)).status).toBe('done');
  });

  it('still lets a task that never ran be closed or moved around', () => {
    const e = engine();
    const task = e.tasks.create({ workspaceId: e.ws.id, title: 'Not needed' });
    expect(e.tasks.update({ taskId: task.id, status: 'done' }).status).toBe('done');
    expect(e.tasks.update({ taskId: task.id, status: 'backlog' }).status).toBe('backlog');
    expect(e.tasks.update({ taskId: task.id, status: 'queued' }).status).toBe('queued');
  });
});

describe('TaskService: dependencies', () => {
  it('rejects dependency cycles', () => {
    const e = engine();
    const a = e.tasks.create({ workspaceId: e.ws.id, title: 'A' });
    const b = e.tasks.create({ workspaceId: e.ws.id, title: 'B', dependsOn: [a.id] });
    const c = e.tasks.create({ workspaceId: e.ws.id, title: 'C', dependsOn: [b.id] });
    expect(() => e.tasks.update({ taskId: a.id, dependsOn: [b.id] })).toThrow(/cycle/);
    expect(() => e.tasks.update({ taskId: a.id, dependsOn: [c.id] })).toThrow(/cycle/);
    expect(e.store.task(a.id)?.dependsOn).toEqual([]);
    // Other shapes stay allowed: diamonds and chains.
    expect(() => e.tasks.update({ taskId: c.id, dependsOn: [a.id, b.id] })).not.toThrow();
  });
});

describe('TaskService: review-fix loop', () => {
  /** A task whose working agent is done and approved, so that the (single) review agent is running. */
  async function reviewing(e: ReturnType<typeof engine>, maxFixRounds: number) {
    e.workspaces.update({ workspaceId: e.ws.id, review: { enabled: true, agentKinds: ['shell'], agentPushes: false, maxFixRounds } });
    const task = await running(e);
    e.report(task.agentId!, 'done');
    await e.tasks.approve(task.id);
    await vi.waitFor(() => expect(e.store.task(task.id)?.runs).toHaveLength(2));
    return task.id;
  }
  /** The agent of the task's latest run reports "done" and the task follows. */
  const finishLatest = (e: ReturnType<typeof engine>, taskId: string) => e.report(e.store.task(taskId)!.agentId!, 'done');

  it('sends the findings to a new working agent, reviews again and finishes when the review approves', async () => {
    const e = engine();
    const id = await reviewing(e, 2);
    const reviewer = e.store.task(id)!.agentId!;

    e.verdict('changes_requested');
    finishLatest(e, id);
    await vi.waitFor(() => expect(e.store.task(id)?.runs).toHaveLength(3));
    let task = e.store.task(id)!;
    expect(task).toMatchObject({ status: 'running', fixRounds: 1, autoReview: true, reviewStep: undefined });
    expect(task.agentId).not.toBe(reviewer);
    expect(e.killed).toContain(reviewer);

    // The fixing agent is done: the review starts again without anybody approving.
    e.verdict('approved');
    finishLatest(e, id);
    await vi.waitFor(() => expect(e.store.task(id)?.runs).toHaveLength(4));
    task = e.store.task(id)!;
    expect(task).toMatchObject({ status: 'running', reviewStep: 0, autoReview: undefined, reviews: [] });

    finishLatest(e, id);
    await vi.waitFor(() => expect(e.status(id)).toBe('done'));
  });

  it('stops after the maximum number of rounds and hands the task to you', async () => {
    const e = engine();
    const id = await reviewing(e, 1);

    e.verdict('changes_requested', 'First finding');
    finishLatest(e, id);
    await vi.waitFor(() => expect(e.store.task(id)?.runs).toHaveLength(3));
    finishLatest(e, id);
    await vi.waitFor(() => expect(e.store.task(id)?.runs).toHaveLength(4));

    e.verdict('changes_requested', 'Second finding');
    finishLatest(e, id);
    await vi.waitFor(() => expect(e.status(id)).toBe('review'));
    expect(e.store.task(id)).toMatchObject({ fixRounds: 1, noteKey: 'note.reviewFixExhausted', autoReview: undefined });
    expect(e.store.task(id)?.runs).toHaveLength(4);
  });

  it('does not loop when the maximum is 0 (default) or when the review left no verdict', async () => {
    const off = engine();
    const offId = await reviewing(off, 0);
    off.verdict('changes_requested');
    finishLatest(off, offId);
    await vi.waitFor(() => expect(off.status(offId)).toBe('review'));
    expect(off.store.task(offId)).toMatchObject({ fixRounds: 0, noteKey: 'note.reviewChanges' });

    const missing = engine();
    const missingId = await reviewing(missing, 3);
    missing.verdict('missing');
    finishLatest(missing, missingId);
    await vi.waitFor(() => expect(missing.status(missingId)).toBe('review'));
    expect(missing.store.task(missingId)).toMatchObject({ fixRounds: 0, noteKey: 'note.reviewNoResult' });
  });

  it('gives a manual approval a fresh round budget and lets your feedback end the automatic loop', async () => {
    const e = engine();
    const id = await reviewing(e, 1);
    e.verdict('changes_requested');
    finishLatest(e, id);
    await vi.waitFor(() => expect(e.store.task(id)?.runs).toHaveLength(3));

    // Your own feedback takes over: when the agent is done, the task waits for you instead of reviewing by itself.
    await e.tasks.reject(id, 'Please also update the docs');
    expect(e.store.task(id)?.autoReview).toBeUndefined();
    finishLatest(e, id);
    await vi.waitFor(() => expect(e.status(id)).toBe('review'));

    await e.tasks.approve(id);
    expect(e.store.task(id)).toMatchObject({ status: 'running', reviewStep: 0, fixRounds: 0 });
  });
});

describe('TaskService: iteration loop', () => {
  type LoopInput = { requirement: string; maxIterations: number; maxMinutes?: number; mode?: 'fresh' | 'continue' };
  const loopWorkflow = (loop: LoopInput, extraStage = false) => ({
    label: 'Loop',
    stages: [
      { name: 'Build', agentKind: 'claude-code', prompt: '{{task}}{{feedback}}', approval: false, loop },
      ...(extraStage ? [{ name: 'Docs', agentKind: 'claude-code', prompt: '{{task}}', approval: false }] : []),
    ],
  });
  const fail = (output: string) => ({ exitCode: 1, output });

  /** A running task whose first stage loops until `pnpm test` passes. */
  async function looping(e: ReturnType<typeof engine>, loop: Partial<LoopInput> = {}, extraStage = false) {
    e.settings.update({ workflows: { loop: loopWorkflow({ requirement: 'pnpm test', maxIterations: 3, mode: 'fresh', ...loop }, extraStage) } });
    const task = e.tasks.create({ workspaceId: e.ws.id, title: 'Fix tests', workflowId: 'loop' });
    e.tasks.start(task.id);
    await vi.waitFor(() => expect(e.store.task(task.id)?.agentId).toBeDefined());
    return task.id;
  }
  const agentOf = (e: ReturnType<typeof engine>, id: string) => e.store.task(id)!.agentId!;
  /** The latest agent reports "done" and the requirement check gets `result`. */
  const finishWith = (e: ReturnType<typeof engine>, id: string, result: { exitCode: number; output: string } | Error) => {
    e.checkResults.push(result);
    e.report(agentOf(e, id), 'done');
  };

  it('tells the agent how it is judged and starts another agent with the output until the requirement is met', async () => {
    const e = engine();
    const id = await looping(e);
    expect(e.spawned[0]?.prompt).toContain('Done criterion');
    expect(e.spawned[0]?.prompt).toContain('`pnpm test`');
    expect(e.store.task(id)).toMatchObject({ loopIteration: 1, noteKey: 'note.loopIteration' });

    finishWith(e, id, fail('2 tests failed: parser'));
    await vi.waitFor(() => expect(e.spawned).toHaveLength(2));
    expect(e.spawned[1]?.prompt).toContain('The requirement is not met yet');
    expect(e.spawned[1]?.prompt).toContain('2 tests failed: parser');
    await vi.waitFor(() => expect(e.store.task(id)).toMatchObject({ status: 'running', loopIteration: 2 }));

    finishWith(e, id, fail('1 test failed: parser'));
    await vi.waitFor(() => expect(e.spawned).toHaveLength(3));

    // Met: a single-stage workflow ends in review like any other task.
    finishWith(e, id, { exitCode: 0, output: 'ok' });
    await vi.waitFor(() => expect(e.status(id)).toBe('review'));
    expect(e.store.task(id)).toMatchObject({ noteKey: undefined, loopLastFailure: undefined });
    expect(e.checked).toEqual(['pnpm test', 'pnpm test', 'pnpm test']);
  });

  it('goes on with the next stage once the requirement is met', async () => {
    const e = engine();
    const id = await looping(e, {}, true);
    finishWith(e, id, { exitCode: 0, output: '' });
    await vi.waitFor(() => expect(e.store.task(id)).toMatchObject({ status: 'running', stage: 1 }));
    // The second stage has no loop: no check, no loop state.
    expect(e.store.task(id)?.loopIteration).toBeUndefined();
    e.report(agentOf(e, id), 'done');
    await vi.waitFor(() => expect(e.status(id)).toBe('review'));
    expect(e.checked).toHaveLength(1);
  });

  it('stops at the maximum number of iterations and hands the task to you with the last output', async () => {
    const e = engine();
    const id = await looping(e, { maxIterations: 2 });
    finishWith(e, id, fail('first failure'));
    await vi.waitFor(() => expect(e.spawned).toHaveLength(2));
    finishWith(e, id, fail('second failure'));
    await vi.waitFor(() => expect(e.status(id)).toBe('review'));
    expect(e.store.task(id)).toMatchObject({ noteKey: 'note.loopExhausted', noteParams: { iterations: 2, output: 'second failure' } });
    expect(e.spawned).toHaveLength(2);
  });

  it('stops when the check fails with the same output twice in a row', async () => {
    const e = engine();
    const id = await looping(e, { maxIterations: 5 });
    finishWith(e, id, fail('same failure'));
    await vi.waitFor(() => expect(e.spawned).toHaveLength(2));
    finishWith(e, id, fail('same failure'));
    await vi.waitFor(() => expect(e.status(id)).toBe('review'));
    expect(e.store.task(id)).toMatchObject({ noteKey: 'note.loopStuck' });
    expect(e.spawned).toHaveLength(2);
  });

  it('stops when the time limit is over', async () => {
    const e = engine();
    const id = await looping(e, { maxIterations: 5, maxMinutes: 10 });
    e.store.task(id)!.loopStartedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    finishWith(e, id, fail('still failing'));
    await vi.waitFor(() => expect(e.status(id)).toBe('review'));
    expect(e.store.task(id)).toMatchObject({ noteKey: 'note.loopTimeout', noteParams: { minutes: 10 } });
  });

  it('sends the output to the same agent in continue mode', async () => {
    const e = engine();
    const id = await looping(e, { mode: 'continue' });
    const agent = agentOf(e, id);
    finishWith(e, id, fail('lint error in a.ts'));
    await vi.waitFor(() => expect(e.sent).toHaveLength(1));
    expect(e.sent[0]).toContain('lint error in a.ts');
    await vi.waitFor(() => expect(e.store.task(id)).toMatchObject({ status: 'running', loopIteration: 2 }));
    expect(agentOf(e, id)).toBe(agent);
    expect(e.spawned).toHaveLength(1);
    expect(e.store.task(id)?.runs.at(-1)?.outcome).toBe('running');

    // The same agent finishes again and this time the requirement is met.
    finishWith(e, id, { exitCode: 0, output: '' });
    await vi.waitFor(() => expect(e.status(id)).toBe('review'));
  });

  it('hands the task to you when the requirement cannot be checked', async () => {
    const e = engine();
    const id = await looping(e);
    finishWith(e, id, new Error('sandbox is gone'));
    await vi.waitFor(() => expect(e.status(id)).toBe('review'));
    expect(e.store.task(id)).toMatchObject({ noteKey: 'note.loopCheckError', noteParams: { error: 'sandbox is gone' } });
  });

  it('does not continue the loop when the task is stopped while the check runs', async () => {
    const e = engine();
    const id = await looping(e);
    const release = e.hold('check');
    finishWith(e, id, fail('failure'));
    await vi.waitFor(() => expect(e.checked).toHaveLength(1));
    e.tasks.stop(id);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(e.status(id)).toBe('backlog');
    expect(e.spawned).toHaveLength(1);
  });

  it('gives a rejection a fresh budget: feedback goes to the agent and the loop starts counting again', async () => {
    const e = engine();
    const id = await looping(e, { maxIterations: 1 });
    finishWith(e, id, fail('failure'));
    await vi.waitFor(() => expect(e.status(id)).toBe('review'));
    await e.tasks.reject(id, 'Try the other approach');
    await vi.waitFor(() => expect(e.status(id)).toBe('running'));
    expect(e.store.task(id)?.loopIteration).toBe(1);
  });
});
