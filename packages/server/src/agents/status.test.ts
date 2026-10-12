import { describe, expect, it } from 'vitest';
import { AgentProfile } from '@cocoon/protocol';
import { StatusDetector } from './status.ts';

const IDLE_MS = 2500;

const profile = (overrides: Partial<AgentProfile> = {}) =>
  AgentProfile.parse({
    command: ['claude'],
    workingPatterns: ['esc to interrupt'],
    blockedPatterns: ['\\(y/n\\)', 'Do you want to'],
    ...overrides,
  });

const screen = (...lines: string[]) => lines.join('\n');
const PROMPT = screen('> fix the tests', '', 'Done. All tests pass.', '', '> ');

describe('StatusDetector heuristics', () => {
  it('reports working while the screen changes and idle once it is quiet', () => {
    const d = new StatusDetector(profile(), false, IDLE_MS);
    expect(d.observe('a', '', '', 0)).toEqual({ status: 'working', source: 'heuristic' });
    expect(d.observe('b', '', '', 1000).status).toBe('working');
    expect(d.observe('b', '', '', 2000).status).toBe('working'); // quiet for only 1s
    // not armed: work without a request counts as idle afterwards
    expect(d.observe('b', '', '', 1000 + IDLE_MS).status).toBe('idle');
  });

  it('reports done after work that was requested (armed)', () => {
    const d = new StatusDetector(profile(), true, IDLE_MS);
    expect(d.observe('thinking', '', '', 0).status).toBe('working');
    expect(d.observe(PROMPT, '', '', 1000).status).toBe('working');
    expect(d.observe(PROMPT, '', '', 1000 + IDLE_MS)).toEqual({ status: 'done', source: 'heuristic' });
  });

  it('stays idle after arm() until the screen actually changes', () => {
    const d = new StatusDetector(profile(), false, IDLE_MS);
    d.observe(PROMPT, '', '', 0);
    d.observe(PROMPT, '', '', 5000);
    d.arm(10_000);
    expect(d.observe(PROMPT, '', '', 10_000 + IDLE_MS).status).toBe('idle');
    expect(d.observe(PROMPT + 'x', '', '', 13_000).status).toBe('working');
    expect(d.observe(PROMPT + 'x', '', '', 13_000 + IDLE_MS).status).toBe('done');
  });

  it('treats a working pattern in the tail as working even on a quiet screen', () => {
    const d = new StatusDetector(profile(), true, IDLE_MS);
    const busy = screen('✻ Compiling… (12s · esc to interrupt)', '> ');
    d.observe(busy, '', '', 0);
    expect(d.observe(busy, '', '', 60_000).status).toBe('working');
  });

  it('ignores working patterns that scrolled out of the last 15 lines', () => {
    const d = new StatusDetector(profile(), false, IDLE_MS);
    const old = screen('esc to interrupt', ...Array.from({ length: 15 }, (_, i) => `line ${i}`));
    d.observe(old, '', '', 0);
    expect(d.observe(old, '', '', 60_000).status).toBe('idle');
  });

  it('reports blocked for a question at the bottom of a quiet screen', () => {
    const d = new StatusDetector(profile(), true, IDLE_MS);
    const question = screen('Edit file src/a.ts', '', 'Do you want to make this edit?', '❯ 1. Yes', '  2. No');
    d.observe('working…', '', '', 0);
    d.observe(question, '', '', 500);
    expect(d.observe(question, '', '', 500 + IDLE_MS)).toEqual({ status: 'blocked', source: 'heuristic' });
  });

  it('does not report blocked for a question that is no longer near the bottom', () => {
    const d = new StatusDetector(profile(), false, IDLE_MS);
    const scrolled = screen('Continue? (y/n)', 'y', '1', '2', '3', '4', '5', '6', '', '  ');
    d.observe(scrolled, '', '', 0);
    expect(d.observe(scrolled, '', '', IDLE_MS).status).toBe('idle');
  });

  it('forgets a question once the user answered it (arm), even if it stays on screen', () => {
    const d = new StatusDetector(profile(), true, IDLE_MS);
    const question = screen('Run npm install? (y/n)');
    d.observe(question, '', '', 0);
    expect(d.observe(question, '', '', IDLE_MS).status).toBe('blocked');
    d.arm(3000);
    expect(d.observe(question, '', '', 3000 + IDLE_MS).status).not.toBe('blocked');
    // a new question appears below → blocked again
    const next = screen('Run npm install? (y/n)', 'Overwrite package-lock.json? (y/n)');
    d.observe(next, '', '', 7000);
    expect(d.observe(next, '', '', 7000 + IDLE_MS).status).toBe('blocked');
  });

  it('uses the foreground process for shell-like agents', () => {
    const d = new StatusDetector(profile({ command: ['bash'], workingPatterns: [], blockedPatterns: [], idleForeground: ['bash', 'zsh'] }), true, IDLE_MS);
    d.observe('$ make', '', '', 0);
    expect(d.observe('$ make', 'make', '', 10_000).status).toBe('working');
    expect(d.observe('$ make', 'bash', '', 20_000).status).toBe('done');
    // an unknown foreground ("") does not count as working
    const fresh = new StatusDetector(profile({ idleForeground: ['bash'] }), false, IDLE_MS);
    fresh.observe('$', '', '', 0);
    expect(fresh.observe('$', '', '', 10_000).status).toBe('idle');
  });
});

describe('StatusDetector hook reports', () => {
  const hooked = () => profile({ hooks: 'claude-code' });

  it('prefers a fresh hook report over the heuristic', () => {
    const d = new StatusDetector(hooked(), true, IDLE_MS);
    d.observe(PROMPT, '', '', 0);
    expect(d.observe(PROMPT, '', 'blocked 1700000000', 100)).toEqual({ status: 'blocked', source: 'hook' });
    expect(d.observe(PROMPT, '', 'done 1700000001', 200)).toEqual({ status: 'done', source: 'hook' });
    expect(d.observe(PROMPT, '', 'idle 1700000002', 300)).toEqual({ status: 'idle', source: 'hook' });
  });

  it('ignores hook reports when the profile has no hooks', () => {
    const d = new StatusDetector(profile(), false, IDLE_MS);
    d.observe(PROMPT, '', '', 0);
    expect(d.observe(PROMPT, '', 'blocked 1', IDLE_MS)).toEqual({ status: 'idle', source: 'heuristic' });
  });

  it('ignores unknown and non-reportable statuses', () => {
    const d = new StatusDetector(hooked(), false, IDLE_MS);
    d.observe(PROMPT, '', '', 0);
    expect(d.observe(PROMPT, '', 'exited 1', IDLE_MS).source).toBe('heuristic');
    expect(d.observe(PROMPT, '', 'confused 2', IDLE_MS).source).toBe('heuristic');
  });

  it('ignores the report that was current when the task was armed', () => {
    const d = new StatusDetector(hooked(), false, IDLE_MS);
    d.observe(PROMPT, '', 'done 1', 0);
    d.arm(1000);
    expect(d.observe(PROMPT, '', 'done 1', 1000 + IDLE_MS)).toEqual({ status: 'idle', source: 'heuristic' });
    expect(d.observe(PROMPT, '', 'working 2', 5000)).toEqual({ status: 'working', source: 'hook' });
  });

  it('distrusts a stale "working" report once the screen has been quiet for 15s', () => {
    const d = new StatusDetector(hooked(), true, IDLE_MS);
    d.observe(PROMPT, '', 'working 1', 0);
    expect(d.observe(PROMPT, '', 'working 1', 10_000)).toEqual({ status: 'working', source: 'hook' });
    expect(d.observe(PROMPT, '', 'working 1', 15_001)).toEqual({ status: 'done', source: 'heuristic' });
  });

  it('keeps trusting "working" while the heuristic also sees work', () => {
    const d = new StatusDetector(hooked(), true, IDLE_MS);
    const busy = screen('Running… esc to interrupt');
    d.observe(busy, '', 'working 1', 0);
    expect(d.observe(busy, '', 'working 1', 60_000)).toEqual({ status: 'working', source: 'hook' });
  });
});

describe('StatusDetector after a server restart', () => {
  it('keeps a restored done/blocked status until something changes', () => {
    const d = new StatusDetector(profile({ hooks: 'claude-code' }), false, IDLE_MS, 'done');
    // the first snapshot and the existing hook report count as already known
    expect(d.observe(PROMPT, '', 'done 1', 100_000)).toEqual({ status: 'done', source: 'heuristic' });
    expect(d.observe(PROMPT, '', 'done 1', 110_000).status).toBe('done');
    // a new report with a changing screen wins (a "working" report on a screen quiet for >15s would count as stale)
    expect(d.observe(`${PROMPT}fix`, '', 'working 2', 120_000)).toEqual({ status: 'working', source: 'hook' });
    expect(d.observe(`${PROMPT}fix`, '', 'blocked 3', 140_000)).toEqual({ status: 'blocked', source: 'hook' });
  });

  it('restored blocked stays blocked; a changing screen means working', () => {
    const d = new StatusDetector(profile(), false, IDLE_MS, 'blocked');
    expect(d.observe(PROMPT, '', '', 100_000).status).toBe('blocked');
    expect(d.observe(PROMPT + '!', '', '', 100_500).status).toBe('working');
  });

  it('a restored working agent is not kept working', () => {
    const d = new StatusDetector(profile(), false, IDLE_MS, 'working');
    expect(d.observe(PROMPT, '', '', 100_000).status).toBe('idle');
  });
});
