import type { ReactNode } from 'react';
import type { AgentStatus, SandboxStatus } from '@cocoon/protocol';
import { cn } from '../lib/cn';
import { useT } from '../i18n';
import { agentStatusMeta, sandboxStatusMeta, TONE_CLASSES, type Tone } from '../lib/status';

export function Badge({ tone = 'gray', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', TONE_CLASSES[tone].badge, className)}
    >
      {children}
    </span>
  );
}

export function StatusDot({ tone, animated, className }: { tone: Tone; animated?: boolean; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', TONE_CLASSES[tone].dot, animated && 'animate-status', className)} />;
}

export function AgentStatusBadge({ status, size = 'md' }: { status: AgentStatus; size?: 'md' | 'lg' }) {
  const t = useT();
  const meta = agentStatusMeta(t, status);
  return (
    <Badge tone={meta.tone} title={meta.explanation} className={cn(size === 'lg' && 'px-3 py-1 text-sm', status === 'blocked' && 'font-semibold')}>
      <StatusDot tone={meta.tone} animated={meta.animated} className={size === 'lg' ? 'size-2.5' : undefined} />
      {meta.label}
    </Badge>
  );
}

export function SandboxStatusBadge({ status }: { status: SandboxStatus }) {
  const t = useT();
  const meta = sandboxStatusMeta(t, status);
  return (
    <Badge tone={meta.tone} title={meta.explanation}>
      <StatusDot tone={meta.tone} animated={meta.animated} />
      {meta.label}
    </Badge>
  );
}
