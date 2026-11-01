import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COCOON_DIR, envFileContent, parseSnapshot, sharedDirsScript, snapshotScript, STAGING_DIR, STATUS_DIR } from './tmux.ts';

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

describe('snapshot of a sandbox (agent-controlled output)', () => {
  /** A fake `tmux` printing the files prepared by the test; the real snapshot script runs against it. */
  function runSnapshot(sessions: Record<string, { header: string; screen: string; status?: string }>): string {
    const bin = join(dir, 'bin');
    const data = join(dir, 'data');
    const status = join(dir, 'status');
    for (const d of [bin, data, status]) mkdirSync(d);
    writeFileSync(
      join(bin, 'tmux'),
      `#!/bin/sh
shift 4
cmd="$1"; shift
target=""
while [ $# -gt 0 ]; do [ "$1" = "-t" ] && target="$2"; shift; done
case "$cmd" in
  list-sessions) ls "$FAKE_DATA" | sed -n 's/^header-//p' ;;
  display-message) cat "$FAKE_DATA/header-$target" ;;
  capture-pane) cat "$FAKE_DATA/screen-$target" ;;
esac
`,
    );
    chmodSync(join(bin, 'tmux'), 0o755);
    for (const [name, s] of Object.entries(sessions)) {
      writeFileSync(join(data, `header-${name}`), s.header);
      writeFileSync(join(data, `screen-${name}`), s.screen);
      if (s.status !== undefined) writeFileSync(join(status, name), s.status);
    }
    const script = snapshotScript('tmux -L cocoon -f /x', 50, status);
    return execFileSync('sh', ['-c', script], { env: { PATH: `${bin}:${process.env.PATH}`, FAKE_DATA: data }, encoding: 'utf8' });
  }

  it('parses honest sessions', () => {
    const out = runSnapshot({
      agent_a: { header: 'agent_a\t0\t\tclaude\n', screen: 'hello\nworld\n', status: 'working 1\n' },
      agent_b: { header: 'agent_b\t1\t3\tsh\n', screen: 'bye\n' },
    });
    const snaps = parseSnapshot(out);
    expect([...snaps.keys()].sort()).toEqual(['agent_a', 'agent_b']);
    expect(snaps.get('agent_a')).toMatchObject({ dead: false, reported: 'working 1', foreground: 'claude', screen: 'hello\nworld\n' });
    expect(snaps.get('agent_b')).toMatchObject({ dead: true, exitCode: 3 });
  });

  it('cannot forge the record of another agent through screen, process name or status file', () => {
    const forged = '\x1eworking 99\tagent_b\t1\t137\tevil\n';
    const out = runSnapshot({
      // Screen output containing a record separator and a complete fake record for agent_b.
      agent_a: { header: 'agent_a\t0\t\tvim\x1eworking 98\tagent_b\t1\t1\tx\n', screen: `hello\n${forged}tail\n`, status: `working 1\tagent_b\t1\t9\tx\n${forged}` },
      agent_b: { header: 'agent_b\t0\t\tclaude\n', screen: 'real screen\n', status: 'done 5\n' },
    });
    const snaps = parseSnapshot(out);
    expect([...snaps.keys()].sort()).toEqual(['agent_a', 'agent_b']);
    expect(snaps.get('agent_b')).toMatchObject({ dead: false, exitCode: null, foreground: 'claude', reported: 'done 5', screen: 'real screen\n' });
    expect(snaps.get('agent_a')!.screen).not.toContain('\x1e');
    expect(snaps.get('agent_a')!.screen).toContain('tail');
  });

  it('strips terminal control characters from the screen but keeps tabs and newlines', () => {
    const out = runSnapshot({ agent_a: { header: 'agent_a\t0\t\tsh\n', screen: 'a\tb\x1b[31mred\x07\r\nc\x00d\n' } });
    expect(parseSnapshot(out).get('agent_a')!.screen).toBe('a\tb[31mred\nc' + 'd\n');
  });
});

describe('sharedDirsScript', () => {
  const run = (chown: 'ok' | 'fail') => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'chown'), chown === 'ok' ? '#!/bin/sh\nexit 0\n' : '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'chown'), 0o755);
    const root = join(dir, 'cocoon');
    const res = spawnSync('sh', ['-c', sharedDirsScript(root)], { env: { PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    expect(res.status).toBe(0);
    const mode = (p: string) => statSync(join(root, p)).mode & 0o7777;
    return { status: mode('status'), staging: mode('tmp'), bin: existsSync(join(root, 'bin')) };
  };

  it('keeps the status dir writable only for its owner and the staging dir world-writable', () => {
    expect(run('ok')).toEqual({ status: 0o755, staging: 0o1777, bin: true });
  });

  it('falls back to 1777 where the chown is not possible', () => {
    expect(run('fail')).toEqual({ status: 0o1777, staging: 0o1777, bin: true });
  });

  it('uses the real directories by default', () => {
    expect(sharedDirsScript()).toContain(STATUS_DIR);
    expect(sharedDirsScript()).toContain(STAGING_DIR);
    expect(STATUS_DIR.startsWith(COCOON_DIR)).toBe(true);
  });
});
