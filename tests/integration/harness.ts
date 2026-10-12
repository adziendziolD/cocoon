import { execFileSync } from 'node:child_process';
import { inject } from 'vitest';

const ctx = inject('cocoon');

/** Integration tests run only when the global setup could start a server (Docker available). */
export const available = Boolean(ctx);
export const instance = ctx?.instance ?? '';

export async function rpc<T = any>(method: string, params: unknown = {}): Promise<T> {
  if (!ctx) throw new Error('no server');
  const res = await fetch(`${ctx.url}/v1/rpc/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** Runs a shell command in a sandbox as the sandbox user (through the API, like agents and the UI do). */
export async function sh(sandboxId: string, script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return rpc('sandbox.exec', { sandboxId, command: ['bash', '-lc', script], timeoutMs: 120_000 });
}

/** Runs a command in a container directly (e.g. to inspect a shared service as admin). */
export function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 120_000, intervalMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${(lastError as Error).message}` : ''}`);
}

export async function createSandbox(params: Record<string, unknown>): Promise<{ id: string; [key: string]: any }> {
  return rpc('sandbox.create', { network: 'egress', services: [], ...params, name: `${params.name ?? 'it'}-${Math.random().toString(16).slice(2, 6)}` });
}
