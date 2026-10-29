import { trimTrailing } from './strings.ts';

/** A skill source on GitHub, e.g. "owner/repo", "owner/repo/skills/name@v1" or a github.com URL. */
export interface SkillSource {
  /** Clone URL (https). */
  url: string;
  /** Branch or tag; default branch if empty. */
  ref?: string;
  /** Folder inside the repository; empty = repository root (or all skills found in it). */
  path?: string;
  /** Folder name for a skill that sits at the given path / repository root. */
  name: string;
}

const SAFE = /^[A-Za-z0-9._-]+$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Parses a skill entry; undefined if it is not a (supported) GitHub reference. */
export function parseSkillSource(input: string): SkillSource | undefined {
  let text = input.trim();
  if (!text) return undefined;
  let ref: string | undefined;
  let treeRef: string | undefined;
  text = trimTrailing(text.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/^github\.com\//, ''), '/');
  const at = text.lastIndexOf('@');
  if (at > 0) {
    ref = text.slice(at + 1);
    text = text.slice(0, at);
  }
  const parts = text.split('/').filter(Boolean);
  const [owner, repoRaw] = parts;
  if (!owner || !repoRaw) return undefined;
  const repo = repoRaw.replace(/\.git$/, '');
  let rest = parts.slice(2);
  if ((rest[0] === 'tree' || rest[0] === 'blob') && rest[1]) {
    treeRef = rest[1];
    rest = rest.slice(2);
  }
  if (![owner, repo, ...rest].every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) return undefined;
  ref ??= treeRef;
  if (ref !== undefined && !/^[A-Za-z0-9._/-]+$/.test(ref)) return undefined;
  const name = rest.at(-1) ?? repo;
  if (!SAFE.test(name)) return undefined;
  return { url: `https://github.com/${owner}/${repo}`, ref: ref || undefined, path: rest.join('/') || undefined, name };
}

/** Folder (below $HOME) in which each agent CLI looks for skills. */
export const SKILLS_DIR: Record<string, string> = {
  'claude-code': '.claude/skills',
  codex: '.codex/skills',
  gemini: '.gemini/skills',
  opencode: '.config/opencode/skills',
  pi: '.pi/agent/skills',
  'qwen-code': '.qwen/skills',
};
