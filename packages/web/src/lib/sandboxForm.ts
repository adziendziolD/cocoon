import type { Resources } from '@cocoon/protocol';
import { SIZE_PRESETS, type SizePresetId } from './runtimes';

/** Allowed sandbox names (mirrors the server's sandbox.create schema). */
export const SANDBOX_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

/** Derives a sandbox name from a repository URL, e.g. "https://github.com/a/my-app.git" → "my-app". */
export function nameFromRepo(url: string): string {
  const last = url.trim().replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/, '').replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 63);
}

/** True if the text looks like a clonable git URL (https, ssh or git@). */
export function isRepoUrl(url: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(url.trim());
}

/** The size preset matching the given resources, if any. */
export function presetFor(resources: Resources | undefined): SizePresetId | undefined {
  return SIZE_PRESETS.find((p) => p.cpus === resources?.cpus && p.memoryMb === resources?.memoryMb)?.id;
}
