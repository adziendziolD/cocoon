import { describe, expect, it } from 'vitest';
import type { Task } from '@cocoon/protocol';
import { parseVerdict } from './tasks.ts';
import { deriveKey, taskBranch, withHandle } from './workspaces.ts';

describe('deriveKey', () => {
  it('uses the capitals of camel-case names and the initials of several words', () => {
    expect(deriveKey('FocusDigital', [])).toBe('FD');
    expect(deriveKey('Docs site', [])).toBe('DS');
    expect(deriveKey('My Big Web Shop', [])).toBe('MBWS');
  });

  it('falls back to the first letters', () => {
    expect(deriveKey('cocoon', [])).toBe('COC');
    expect(deriveKey('API', [])).toBe('API');
    expect(deriveKey('Ü', [])).toBe('UW');
    expect(deriveKey('42 things', [])).toBe('W4T');
  });

  it('makes keys unique', () => {
    expect(deriveKey('FocusDigital', ['FD'])).toBe('FD2');
    expect(deriveKey('FocusDigital', ['FD', 'FD2'])).toBe('FD3');
  });
});

describe('task branches', () => {
  it('builds git-safe branch names from key, number and title', () => {
    expect(taskBranch('FD', 12, 'Add Apple Pay to checkout!')).toBe('FD-12-add-apple-pay-to-checkout');
    expect(taskBranch('FD', 3, 'Größe ändern')).toBe('FD-3-grosse-andern');
    expect(taskBranch('FD', 4, '!!!')).toBe('FD-4');
    expect(taskBranch('FD', 5, 'x'.repeat(100)).length).toBeLessThanOrEqual(60);
  });

  it('keeps the branch once the task has run', () => {
    const task = { number: 7, title: 'First title', runs: [] } as unknown as Task;
    const named = withHandle(task, 'AB');
    expect(named).toMatchObject({ handle: 'AB-7', branch: 'AB-7-first-title' });
    const ran = { ...named, title: 'Renamed', runs: [{}] } as unknown as Task;
    expect(withHandle(ran, 'AB').branch).toBe('AB-7-first-title');
    expect(withHandle({ ...named, title: 'Renamed' }, 'AB').branch).toBe('AB-7-renamed');
  });
});

describe('parseVerdict', () => {
  it('reads the verdict JSON of a review agent', () => {
    expect(parseVerdict('{"verdict":"approved","summary":"All good","pullRequest":"https://github.com/a/b/pull/1"}', 'ag_1', 'claude-code')).toMatchObject({
      verdict: 'approved',
      summary: 'All good',
      pullRequest: 'https://github.com/a/b/pull/1',
    });
    expect(parseVerdict('```json\n{"verdict":"changes_requested","summary":"Tests fail"}\n```', 'ag_1', 'codex').verdict).toBe('changes_requested');
  });

  it('treats anything else as missing', () => {
    expect(parseVerdict('', 'ag_1', 'x').verdict).toBe('missing');
    expect(parseVerdict('{"verdict":"maybe"}', 'ag_1', 'x').verdict).toBe('missing');
    expect(parseVerdict('{"verdict":"approved","pullRequest":"javascript:alert(1)"}', 'ag_1', 'x').pullRequest).toBeUndefined();
  });
});

describe('tasks saved before reviews existed', () => {
  it('get empty reviews and pull requests when sent to clients', async () => {
    const { localizeTask } = await import('./tasks.ts');
    const legacy = { id: 'ts_1', workspaceId: 'ws_1', title: 'Old', status: 'done', runs: [] } as unknown as Task;
    const view = localizeTask(legacy, 'de');
    expect(view.reviews).toEqual([]);
    expect(view.pullRequests).toEqual([]);
  });
});
