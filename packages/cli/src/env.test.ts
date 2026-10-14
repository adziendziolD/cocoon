import { describe, expect, it } from 'vitest';
import { parseAssignments, scopeFrom } from './env.ts';

describe('scopeFrom', () => {
  it('needs exactly one scope', () => {
    expect(scopeFrom({ workspace: 'ws_1' })).toEqual({ scope: 'workspace', id: 'ws_1' });
    expect(scopeFrom({ repo: 'github.com/a/b' })).toEqual({ scope: 'repo', id: 'github.com/a/b' });
    expect(scopeFrom({ sandbox: 'sb_1' })).toEqual({ scope: 'sandbox', id: 'sb_1' });
    expect(() => scopeFrom({})).toThrow(/exactly one/);
    expect(() => scopeFrom({ workspace: 'a', sandbox: 'b' })).toThrow(/exactly one/);
  });
});

describe('parseAssignments', () => {
  it('splits at the first "=" only', () => {
    expect(parseAssignments(['A=1', 'URL=postgres://u:p@h/db?x=y', 'EMPTY='])).toEqual([
      { name: 'A', value: '1' },
      { name: 'URL', value: 'postgres://u:p@h/db?x=y' },
      { name: 'EMPTY', value: '' },
    ]);
  });

  it('rejects arguments without a name and does not echo the value', () => {
    expect(() => parseAssignments(['=value'])).toThrow(/expected NAME=value/);
    expect(() => parseAssignments(['justaword'])).toThrow(/expected NAME=value/);
    try {
      parseAssignments(['sk_live_secretvalue']);
    } catch (err) {
      expect((err as Error).message).not.toContain('secretvalue'.repeat(2));
    }
  });
});
