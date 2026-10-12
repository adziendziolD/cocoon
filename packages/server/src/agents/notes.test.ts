import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_NOTE_FILES, agentNotesScript } from './notes.ts';

describe('agentNotesScript', () => {
  it('uses section markers per key', () => {
    const script = agentNotesScript('services');
    expect(script).toContain('<!-- cocoon-services:start -->');
    expect(script).toContain('<!-- cocoon-services:end -->');
    for (const file of AGENT_NOTE_FILES) expect(script).toContain(file);
  });

  // The script runs inside Linux sandboxes and relies on GNU `sed -i`.
  describe.skipIf(process.platform !== 'linux')('in a shell', () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'cocoon-notes-'));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    const run = (key: string, notes: string) => {
      const res = spawnSync('sh', ['-c', agentNotesScript(key)], { env: { PATH: process.env.PATH, HOME: home, NOTES: notes } });
      expect(res.status, res.stderr.toString()).toBe(0);
    };
    const claudeMd = () => join(home, '.claude/CLAUDE.md');

    it('writes the section into every agent memory file', () => {
      run('services', '## Services\n- postgres');
      for (const file of AGENT_NOTE_FILES) {
        expect(readFileSync(join(home, file), 'utf8')).toBe('<!-- cocoon-services:start -->\n## Services\n- postgres\n<!-- cocoon-services:end -->\n');
      }
    });

    it('replaces its own section, keeps user content and other sections', () => {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(claudeMd(), '# My notes\nAlways use pnpm.\n');
      run('repos', 'repo layout');
      run('services', 'old services');
      run('services', 'new services');
      const content = readFileSync(claudeMd(), 'utf8');
      expect(content).toContain('# My notes\nAlways use pnpm.\n');
      expect(content).toContain('repo layout');
      expect(content).toContain('new services');
      expect(content).not.toContain('old services');
      expect(content.match(/cocoon-services:start/g)).toHaveLength(1);
    });

    it('removes the section for empty notes and deletes files that become empty', () => {
      run('services', 'something');
      run('services', '');
      expect(existsSync(claudeMd())).toBe(false);
    });
  });
});
