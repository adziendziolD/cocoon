import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@cocoon/protocol';
import { ActivityLog } from './activity.ts';
import { EventBus } from './events.ts';
import { classifyIssue, IssueService, parseIssues, taskFromIssue } from './github-issues.ts';
import { SecretsService } from './secrets.ts';
import { Store } from './store.ts';
import type { TaskService } from './tasks.ts';
import { WorkspaceService } from './workspaces.ts';

const raw = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  body: 'Details',
  html_url: `https://github.com/acme/shop/issues/${number}`,
  labels: [],
  user: { login: 'ann' },
  created_at: `2026-01-0${number}T00:00:00Z`,
  comments: 2,
  ...over,
});

describe('classifyIssue', () => {
  it('treats bug labels and the bug issue type as bugs, everything else as features', () => {
    expect(classifyIssue({ labels: [{ name: 'Bug' }] })).toBe('bug');
    expect(classifyIssue({ labels: ['type: bug'] })).toBe('bug');
    expect(classifyIssue({ labels: [], type: { name: 'Bug' } })).toBe('bug');
    expect(classifyIssue({ labels: [{ name: 'enhancement' }] })).toBe('feature');
    expect(classifyIssue({ labels: [] })).toBe('feature');
    expect(classifyIssue({ labels: [{ name: 'debugging-tools' }] })).toBe('feature');
  });
});

describe('parseIssues', () => {
  it('drops pull requests and maps the fields', () => {
    const issues = parseIssues('acme/shop', [raw(1, { labels: [{ name: 'bug' }, { name: 'ui' }] }), raw(2, { pull_request: {} }), raw(3, { body: null, user: null })]);
    expect(issues.map((i) => i.number)).toEqual([1, 3]);
    expect(issues[0]).toMatchObject({ repo: 'acme/shop', kind: 'bug', labels: ['bug', 'ui'], author: 'ann', comments: 2 });
    expect(issues[1]).toMatchObject({ body: '', author: undefined, kind: 'feature' });
  });
});

describe('taskFromIssue', () => {
  it('appends the issue link and shortens long titles', () => {
    const [issue] = parseIssues('acme/shop', [raw(1, { title: 'x'.repeat(300) })]);
    const task = taskFromIssue(issue!);
    expect(task.title).toHaveLength(200);
    expect(task.description).toBe('Details\n\n---\nGitHub acme/shop#1: https://github.com/acme/shop/issues/1');
  });
});

describe('IssueService', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cocoon-issues-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup(respond: (url: string) => { status?: number; body: unknown }) {
    const store = new Store(dir);
    const bus = new EventBus();
    const workspaces = new WorkspaceService(store, bus, new ActivityLog(bus));
    const ws = workspaces.create({ name: 'Shop', repos: [{ url: 'https://github.com/acme/shop.git' }, { url: 'https://gitlab.com/acme/other' }] });
    const created: Task[] = [];
    const tasks = {
      list: () => created,
      create: (params: { title: string; description?: string }, origin: Pick<Task, 'issue'>) => {
        const task = { id: `ts_${created.length + 1}`, workspaceId: ws.id, ...params, issue: origin.issue } as Task;
        created.push(task);
        return task;
      },
    } as unknown as TaskService;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const { status = 200, body } = respond(String(url));
      return new Response(JSON.stringify(body), { status });
    });
    const service = new IssueService(workspaces, tasks, new SecretsService(store), fetchFn as unknown as typeof fetch);
    return { service, ws, fetchFn, created };
  }

  it('lists the open issues of the GitHub repositories only', async () => {
    const { service, ws, fetchFn } = setup(() => ({ body: [raw(1, { labels: [{ name: 'bug' }] }), raw(2, { pull_request: {} }), raw(3)] }));
    const result = await service.list({ workspaceId: ws.id });
    expect(result.repos).toEqual(['acme/shop']);
    expect(result.issues.map((i) => [i.number, i.kind])).toEqual([[3, 'feature'], [1, 'bug']]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]![0])).toContain('/repos/acme/shop/issues?state=open');
  });

  it('caches the GitHub answer unless a refresh is requested', async () => {
    const { service, ws, fetchFn } = setup(() => ({ body: [raw(1)] }));
    await service.list({ workspaceId: ws.id });
    await service.list({ workspaceId: ws.id });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await service.list({ workspaceId: ws.id, refresh: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('reports repositories that cannot be read instead of failing', async () => {
    const { service, ws } = setup(() => ({ status: 404, body: { message: 'Not Found' } }));
    const result = await service.list({ workspaceId: ws.id });
    expect(result.issues).toEqual([]);
    expect(result.errors).toEqual([{ repo: 'acme/shop', message: expect.stringContaining('Not Found') }]);
  });

  it('imports issues as tasks once and skips known or unknown ones', async () => {
    const { service, ws, created } = setup(() => ({ body: [raw(1), raw(2)] }));
    const first = await service.import({ workspaceId: ws.id, status: 'backlog', issues: [{ repo: 'acme/shop', number: 1 }, { repo: 'acme/shop', number: 99 }] });
    expect(first.tasks).toHaveLength(1);
    expect(first.skipped).toBe(1);
    expect(created[0]).toMatchObject({ title: 'Issue 1', issue: { repo: 'acme/shop', number: 1, url: 'https://github.com/acme/shop/issues/1' } });
    const again = await service.import({ workspaceId: ws.id, status: 'backlog', issues: [{ repo: 'acme/shop', number: 1 }, { repo: 'acme/shop', number: 2 }] });
    expect(again.tasks.map((t) => t.title)).toEqual(['Issue 2']);
    expect(again.skipped).toBe(1);
    const listed = await service.list({ workspaceId: ws.id });
    expect(listed.issues.every((i) => i.taskId)).toBe(true);
  });
});
