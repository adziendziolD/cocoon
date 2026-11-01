import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envFileContent } from './tmux.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-tmux-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('envFileContent', () => {
  it('exports valid names with quoted values', () => {
    expect(envFileContent({ FOO: "it's", _BAR9: 'x y' })).toBe(`export FOO='it'\\''s'\nexport _BAR9='x y'\n`);
  });

  it.each(['A B', 'A;touch /tmp/x', 'A=B', '1A', '', 'A\nB', 'A$(id)', 'A-B', 'ÄÖ'])('rejects the name %j', (key) => {
    expect(() => envFileContent({ [key]: 'v' })).toThrow(/Invalid environment variable name|Ungültiger Name/);
  });
});
