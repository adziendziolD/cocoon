#!/usr/bin/env -S npx tsx
/**
 * Runs cocoond and starts it again when it exits with RESTART_EXIT_CODE (after an update, or "Restart" in the UI).
 * A server that exits with that code again and again right after starting is restarted with a growing delay
 * (restart-backoff.ts) instead of in a tight loop.
 * Kept tiny on purpose: this process itself is not replaced by an update.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RestartBackoff } from './restart-backoff.ts';

const RESTART_EXIT_CODE = 75;
const main = fileURLToPath(new URL('./main.ts', import.meta.url));

const backoff = new RestartBackoff();
let child: ReturnType<typeof spawn> | undefined;
let waiting: NodeJS.Timeout | undefined;
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    stopping = true;
    // Between two runs there is no child to stop: leave right away.
    if (waiting) process.exit(0);
    child?.kill(signal);
  });
}

function start(): void {
  // Same Node.js flags (tsx loader, --env-file) as this process.
  const startedAt = Date.now();
  child = spawn(process.execPath, [...process.execArgv, main, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, COCOON_SUPERVISED: '1' },
  });
  child.on('exit', (code, signal) => {
    if (code === RESTART_EXIT_CODE && !stopping) {
      const delay = backoff.next(Date.now() - startedAt);
      console.log(`\n  Restarting CoCoon${delay ? ` in ${Math.round(delay / 1000)} s (it keeps restarting right after it starts)` : ''} …\n`);
      child = undefined;
      waiting = setTimeout(() => {
        waiting = undefined;
        start();
      }, delay);
      return;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

start();
