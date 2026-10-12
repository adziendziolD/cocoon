import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { Check } from 'lucide-react';
import { useEventSync } from '../../api/events';
import { ConfirmDialog } from '../../components/Dialog';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { Logo } from '../../components/Logo';
import { useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { OnboardingContext, type OnboardingContextValue, type StepStatus } from './context';
import { useCompleteOnboarding } from './lifecycle';
import { useStepStatus } from './progress';
import { loadState, saveState, STEP_IDS, STEP_LABELS, type StepId } from './state';
import { AgentStep } from './steps/AgentStep';
import { AiAccessStep } from './steps/AiAccessStep';
import { DefaultsStep } from './steps/DefaultsStep';
import { DoneStep } from './steps/DoneStep';
import { GithubStep } from './steps/GithubStep';
import { SandboxStep } from './steps/SandboxStep';
import { SystemStep } from './steps/SystemStep';
import { WelcomeStep } from './steps/WelcomeStep';

const STEP_COMPONENTS: Record<StepId, ComponentType> = {
  welcome: WelcomeStep,
  system: SystemStep,
  ai: AiAccessStep,
  github: GithubStep,
  defaults: DefaultsStep,
  sandbox: SandboxStep,
  agent: AgentStep,
  done: DoneStep,
};

/** Full-screen first-run wizard (own layout without the sidebar). */
export function OnboardingPage() {
  const t = useT();
  useEventSync(true);

  const [initial] = useState(loadState);
  const [step, setStep] = useState<StepId>(initial.step);
  const [passed, setPassed] = useState<StepId[]>(initial.passed);
  const [drafts, setDrafts] = useState<Record<string, unknown>>(initial.drafts);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const status = useStepStatus(passed);

  useEffect(() => saveState({ step, passed, drafts }), [step, passed, drafts]);
  useEffect(() => {
    document.title = `${t(STEP_LABELS[step])} · ${t('onboarding.docTitle')}`;
  }, [step, t]);

  const index = STEP_IDS.indexOf(step);
  const furthest = Math.max(index, ...passed.map((s) => STEP_IDS.indexOf(s) + 1));
  const aiIndex = STEP_IDS.indexOf('ai');
  /** Steps that can be opened via the progress indicator. AI access is required before anything after it. */
  const reachable = useCallback(
    (i: number) => (i <= furthest || status[STEP_IDS[i]!] === 'done') && (i <= aiIndex || status.ai === 'done'),
    [furthest, status, aiIndex],
  );

  const setDraft = useCallback<OnboardingContextValue['setDraft']>((key, update) => {
    setDrafts((d) => ({ ...d, [key]: typeof update === 'function' ? (update as (p: unknown) => unknown)(d[key]) : update }));
  }, []);

  const ctx = useMemo<OnboardingContextValue>(
    () => ({
      step,
      status,
      drafts,
      setDraft,
      goTo: setStep,
      next: () => {
        setPassed((p) => (p.includes(step) ? p : [...p, step]));
        setStep(STEP_IDS[Math.min(index + 1, STEP_IDS.length - 1)]!);
      },
      back: () => setStep(STEP_IDS[Math.max(index - 1, 0)]!),
    }),
    [step, status, drafts, setDraft, index],
  );

  const skip = useCompleteOnboarding();
  const Step = STEP_COMPONENTS[step];

  return (
    <OnboardingContext.Provider value={ctx}>
      <div className="min-h-full bg-gradient-to-b from-accent-soft/70 via-canvas to-canvas">
        <header className="sticky top-0 z-20 border-b border-line/70 bg-surface/80 backdrop-blur">
          <div className="mx-auto flex h-16 max-w-5xl items-center gap-3 px-4 sm:px-6">
            <Logo tagline={false} />
            <span className="hidden text-sm text-fg-subtle sm:inline">· {t('onboarding.headerTitle')}</span>
            <span className="flex-1" />
            <LanguageSwitcher />
            {step !== 'done' && (
              <button type="button" onClick={() => setConfirmSkip(true)} className="rounded-md px-2 py-1 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
                {t('onboarding.skip')}
              </button>
            )}
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-4 pt-6 pb-16 sm:px-6">
          <Stepper current={step} status={status} reachable={reachable} onSelect={setStep} />
          <div className="mx-auto mt-6 max-w-3xl rounded-2xl border border-line bg-surface shadow-[0_8px_30px_rgba(16,24,40,0.06)]">
            <Step key={step} />
          </div>
        </main>
      </div>

      <ConfirmDialog
        open={confirmSkip}
        onClose={() => setConfirmSkip(false)}
        onConfirm={() => skip.mutate('/')}
        loading={skip.isPending}
        title={t('onboarding.skipTitle')}
        message={t('onboarding.skipText')}
        confirmLabel={t('onboarding.skipConfirm')}
      />
    </OnboardingContext.Provider>
  );
}

function Stepper({ current, status, reachable, onSelect }: { current: StepId; status: Record<StepId, StepStatus>; reachable: (i: number) => boolean; onSelect: (s: StepId) => void }) {
  const t = useT();
  const index = STEP_IDS.indexOf(current);
  return (
    <nav aria-label={t('onboarding.progressLabel')}>
      {/* Compact variant for small screens */}
      <div className="md:hidden">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium text-fg">{t(STEP_LABELS[current])}</span>
          <span className="text-fg-muted">{t('onboarding.stepOf', { current: index + 1, total: STEP_IDS.length })}</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${((index + 1) / STEP_IDS.length) * 100}%` }} />
        </div>
      </div>
      <ol className="hidden items-start md:flex">
        {STEP_IDS.map((id, i) => {
          const done = status[id] === 'done' && id !== current;
          const isCurrent = id === current;
          const canOpen = !isCurrent && reachable(i);
          return (
            <li key={id} className="flex flex-1 items-start last:flex-none">
              <button
                type="button"
                onClick={() => canOpen && onSelect(id)}
                disabled={!canOpen && !isCurrent}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'group flex w-20 flex-col items-center gap-1.5 rounded-lg py-1 text-center focus-visible:outline-2 focus-visible:outline-accent',
                  canOpen ? 'cursor-pointer' : 'cursor-default',
                )}
              >
                <span
                  className={cn(
                    'flex size-8 items-center justify-center rounded-full text-sm font-semibold transition-colors',
                    isCurrent
                      ? 'bg-accent text-accent-fg ring-4 ring-accent/20'
                      : done
                        ? 'bg-emerald-500 text-white'
                        : status[id] === 'skipped'
                          ? 'bg-surface text-fg-muted ring-1 ring-line-strong'
                          : 'bg-surface-2 text-fg-subtle',
                    canOpen && 'group-hover:ring-2 group-hover:ring-accent/30',
                  )}
                >
                  {done ? <Check className="size-4" /> : i + 1}
                </span>
                <span className={cn('text-xs leading-tight', isCurrent ? 'font-semibold text-fg' : canOpen ? 'text-fg-muted group-hover:text-fg' : 'text-fg-subtle')}>
                  {t(STEP_LABELS[id])}
                </span>
                {done && <span className="sr-only">{t('onboarding.check.ok')}</span>}
              </button>
              {i < STEP_IDS.length - 1 && <span className={cn('mt-5 h-0.5 flex-1 rounded-full', i < index || done ? 'bg-accent/40' : 'bg-line')} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
