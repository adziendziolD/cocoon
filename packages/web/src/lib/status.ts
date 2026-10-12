import type { AgentStatus, NetworkMode, SandboxStatus } from '@cocoon/protocol';
import type { TFunction } from '../i18n';

export type Tone = 'blue' | 'amber' | 'green' | 'gray' | 'slate' | 'red' | 'accent';

export interface StatusMeta {
  label: string;
  tone: Tone;
  /** One plain-language sentence for beginners. */
  explanation: string;
  animated?: boolean;
}

const AGENT_TONE: Record<AgentStatus, { tone: Tone; animated?: boolean }> = {
  working: { tone: 'blue', animated: true },
  blocked: { tone: 'amber', animated: true },
  done: { tone: 'green' },
  idle: { tone: 'gray' },
  exited: { tone: 'slate' },
  unknown: { tone: 'gray' },
};

const SANDBOX_TONE: Record<SandboxStatus, { tone: Tone; animated?: boolean }> = {
  creating: { tone: 'blue', animated: true },
  running: { tone: 'green' },
  stopped: { tone: 'slate' },
  error: { tone: 'red' },
  missing: { tone: 'red' },
};

/** Label, colour and explanation of an agent status in the active language. */
export function agentStatusMeta(t: TFunction, status: AgentStatus): StatusMeta {
  const s = status in AGENT_TONE ? status : 'unknown';
  return { ...AGENT_TONE[s], label: t(`status.agent.${s}`), explanation: t(`status.agent.${s}.explanation`) };
}

/** Label, colour and explanation of a sandbox status in the active language. */
export function sandboxStatusMeta(t: TFunction, status: SandboxStatus): StatusMeta {
  const s = status in SANDBOX_TONE ? status : 'error';
  return { ...SANDBOX_TONE[s], label: t(`status.sandbox.${s}`), explanation: t(`status.sandbox.${s}.explanation`) };
}

export const NETWORK_MODES: NetworkMode[] = ['egress', 'open', 'none'];

/** Label, short label and description of a network mode in the active language. */
export function networkModeMeta(t: TFunction, mode: NetworkMode): { label: string; short: string; description: string } {
  return { label: t(`network.${mode}.label`), short: t(`network.${mode}.short`), description: t(`network.${mode}.description`) };
}

/** Sort order: things needing attention first. */
export const AGENT_STATUS_ORDER: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
  exited: 5,
};

export const TONE_CLASSES: Record<Tone, { badge: string; dot: string; soft: string }> = {
  blue: {
    badge: 'bg-blue-500/10 text-blue-700 ring-blue-500/25 dark:text-blue-300',
    dot: 'bg-blue-500',
    soft: 'bg-blue-500/5 border-blue-500/20',
  },
  amber: {
    badge: 'bg-amber-400/20 text-amber-800 ring-amber-500/40 dark:text-amber-300',
    dot: 'bg-amber-500',
    soft: 'bg-amber-400/10 border-amber-500/40',
  },
  green: {
    badge: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300',
    dot: 'bg-emerald-500',
    soft: 'bg-emerald-500/5 border-emerald-500/20',
  },
  gray: {
    badge: 'bg-gray-500/10 text-gray-600 ring-gray-500/20 dark:text-gray-300',
    dot: 'bg-gray-400',
    soft: 'bg-gray-500/5 border-gray-500/20',
  },
  slate: {
    badge: 'bg-slate-500/15 text-slate-700 ring-slate-500/25 dark:text-slate-300',
    dot: 'bg-slate-500',
    soft: 'bg-slate-500/5 border-slate-500/20',
  },
  red: {
    badge: 'bg-red-500/10 text-red-700 ring-red-500/25 dark:text-red-300',
    dot: 'bg-red-500',
    soft: 'bg-red-500/5 border-red-500/25',
  },
  accent: {
    badge: 'bg-accent-soft text-accent ring-accent/25',
    dot: 'bg-accent',
    soft: 'bg-accent-soft border-accent/20',
  },
};

const GIT_CODES = ['M', 'A', 'D', 'R', 'C', 'U'] as const;
type GitCode = (typeof GIT_CODES)[number];
const isGitCode = (c: string): c is GitCode => (GIT_CODES as readonly string[]).includes(c);

export function gitStatusLabel(t: TFunction, code: string): string {
  const c = code.trim();
  if (c === '??') return t('git.status.A');
  if (isGitCode(c)) return t(`git.status.${c}`);
  const first = c[0] ?? '';
  return isGitCode(first) ? t(`git.status.${first}`) : c;
}
