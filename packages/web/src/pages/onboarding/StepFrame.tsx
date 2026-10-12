import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CircleCheck, CircleX, Loader2, type LucideIcon } from 'lucide-react';
import type { SecretInfo } from '@cocoon/protocol';
import { Button } from '../../components/Button';
import { Callout } from '../../components/HelpText';
import { useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { useOnboarding } from './context';

export interface StepFrameProps {
  icon: LucideIcon;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  onNext?: () => void;
  nextLabel?: string;
  nextIcon?: ReactNode;
  nextDisabled?: boolean;
  nextLoading?: boolean;
  /** Extra buttons left of "Next" (e.g. "Skip"). */
  actions?: ReactNode;
  /** Short text next to the buttons, e.g. why "Next" is disabled. */
  footerHint?: ReactNode;
  hideBack?: boolean;
  /** Banner for steps that are already satisfied; `false` hides the default banner. */
  doneBanner?: ReactNode | false;
}

const INTERACTIVE = new Set(['TEXTAREA', 'BUTTON', 'A', 'SELECT', 'SUMMARY']);

/** Common layout of one wizard step: heading, content, footer with back/next. Enter moves on where sensible. */
export function StepFrame({ icon: Icon, title, lead, children, onNext, nextLabel, nextIcon, nextDisabled, nextLoading, actions, footerHint, hideBack, doneBanner }: StepFrameProps) {
  const t = useT();
  const { step, status, back } = useOnboarding();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // A new step mounts this frame: move focus to its heading (screen readers announce it) and scroll up.
  useEffect(() => {
    window.scrollTo({ top: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.nativeEvent.isComposing || e.shiftKey || e.altKey) return;
    const el = e.target as HTMLElement;
    // Inputs inside their own small form (e.g. "save key") submit that form instead.
    if (el.closest('form') || el.closest('[role="dialog"]')) return;
    if (INTERACTIVE.has(el.tagName)) return;
    if (el instanceof HTMLInputElement && ['checkbox', 'radio', 'button', 'submit'].includes(el.type)) return;
    e.preventDefault();
    if (onNext && !nextDisabled && !nextLoading) onNext();
  };

  const banner = doneBanner === false ? null : status[step] === 'done' ? (doneBanner ?? <Callout tone="success" title={t('onboarding.alreadyDone')}>{t('onboarding.alreadyDoneText')}</Callout>) : null;

  return (
    <div onKeyDown={onKeyDown} className="animate-in">
      <div className="px-5 pt-6 pb-2 sm:px-8 sm:pt-8">
        <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon className="size-5.5" />
        </div>
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight text-fg outline-none">
          {title}
        </h1>
        {lead && <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-fg-muted">{lead}</p>}
      </div>
      <div className="space-y-6 px-5 py-5 sm:px-8">
        {banner}
        {children}
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-b-2xl border-t border-line bg-surface-2/60 px-5 py-4 sm:px-8">
        {!hideBack && (
          <Button variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={back}>
            {t('common.back')}
          </Button>
        )}
        <div className="min-w-0 flex-1 text-xs text-fg-muted">{footerHint}</div>
        {actions}
        {onNext && (
          <Button variant="primary" size="lg" onClick={onNext} disabled={nextDisabled} loading={nextLoading} className="min-w-32">
            {nextLabel ?? t('common.next')}
            {!nextLoading && (nextIcon ?? <ArrowRight className="size-4" />)}
          </Button>
        )}
      </div>
    </div>
  );
}

export type CheckState = 'ok' | 'working' | 'error' | 'waiting';

/** Status icon for checklist rows. */
export function CheckIcon({ state, className }: { state: CheckState; className?: string }) {
  const t = useT();
  const label = t(`onboarding.check.${state}`);
  return (
    <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', className, {
      ok: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      working: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
      error: 'bg-red-500/10 text-red-600 dark:text-red-400',
      waiting: 'bg-surface-2 text-fg-subtle',
    }[state])} role="img" aria-label={label} title={label}>
      {state === 'ok' ? <CircleCheck className="size-4.5" /> : state === 'error' ? <CircleX className="size-4.5" /> : state === 'working' ? <Loader2 className="size-4.5 animate-spin" /> : <span className="size-2 rounded-full bg-current" />}
    </span>
  );
}

/** Green "saved" row for a stored secret with optional actions (verify, replace). */
export function StoredSecret({ info, children }: { info: SecretInfo | undefined; children?: ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
      <CircleCheck className="size-4 text-emerald-600" />
      <span className="text-sm font-medium text-fg">{t('onboarding.secretSaved')}</span>
      <span className="font-mono text-xs text-fg-subtle">{info?.preview ?? '••••'}</span>
      {info?.source === 'env' && <span className="text-xs text-fg-subtle">{t('providers.form.keyFromEnv')}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** Numbered how-to list. */
export function HowTo({ steps }: { steps: ReactNode[] }) {
  return (
    <ol className="space-y-2.5">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3 text-sm leading-relaxed text-fg-muted">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{i + 1}</span>
          <div className="min-w-0 flex-1 pt-0.5">{s}</div>
        </li>
      ))}
    </ol>
  );
}
