import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RestartBackoff, STABLE_MS } from './restart-backoff.ts';

describe('RestartBackoff', () => {
  it('restarts a healthy server right away', () => {
    const backoff = new RestartBackoff();
    expect(backoff.next(STABLE_MS)).toBe(0);
    expect(backoff.next(10 * 60_000)).toBe(0);
  });

  it('backs off exponentially while the server keeps restarting right after start, up to a cap', () => {
    const backoff = new RestartBackoff();
    const delays = Array.from({ length: 9 }, () => backoff.next(500));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });

  it('starts over after a stable run', () => {
    const backoff = new RestartBackoff();
    backoff.next(100);
    backoff.next(100);
    expect(backoff.next(100)).toBe(4000);
    expect(backoff.next(STABLE_MS + 1)).toBe(0);
    expect(backoff.next(100)).toBe(1000);
  });
});

describe('supervisor crash loop', () => {
  it('waits between restarts of a server that exits with 75 immediately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cocoon-sup-'));
    try {
      const counter = join(dir, 'starts.log');
      // The supervisor starts ./main.ts next to it: run a copy with a stand-in main.ts that exits with 75 right away.
      const src = new URL('.', import.meta.url).pathname;
      writeFileSync(join(dir, 'supervisor.ts'), readFileSync(join(src, 'supervisor.ts'), 'utf8'));
      writeFileSync(join(dir, 'restart-backoff.ts'), readFileSync(join(src, 'restart-backoff.ts'), 'utf8'));
      writeFileSync(join(dir, 'main.ts'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(counter)}, Date.now() + '\\n');\nprocess.exit(75);\n`);
      const tsx = join(src, '../../../node_modules/.bin/tsx');
      const child = spawn(tsx, [join(dir, 'supervisor.ts')], { stdio: 'ignore', env: { ...process.env } });
      await new Promise((resolve) => setTimeout(resolve, 3600));
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('exit', resolve));
      const starts = readFileSync(counter, 'utf8').trim().split('\n').map(Number);
      // Without a backoff the loop would have started the server dozens of times in this window.
      expect(starts.length).toBeGreaterThanOrEqual(2);
      expect(starts.length).toBeLessThanOrEqual(4);
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(900);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
