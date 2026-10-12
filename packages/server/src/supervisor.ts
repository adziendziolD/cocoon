#!/usr/bin/env -S npx tsx
/**
 * Runs cocoond and starts it again when it exits with RESTART_EXIT_CODE (after an update, or "Restart" in the UI).
 * Kept tiny on purpose: this process itself is not replaced by an update.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RESTART_EXIT_CODE = 75;
const main = fileURLToPath(new URL('./main.ts', import.meta.url));

let child: ReturnType<typeof spawn> | undefined;
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
}

function start(): void {
  // Same Node.js flags (tsx loader, --env-file) as this process.
  child = spawn(process.execPath, [...process.execArgv, main, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, COCOON_SUPERVISED: '1' },
  });
  child.on('exit', (code, signal) => {
    if (code === RESTART_EXIT_CODE && !stopping) {
      console.log('\n  Restarting CoCoon …\n');
      start();
      return;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

start();
