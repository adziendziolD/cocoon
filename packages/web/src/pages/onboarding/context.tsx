import { createContext, useCallback, useContext } from 'react';
import type { StepId } from './state';

export type StepStatus = 'done' | 'skipped' | 'open';

export interface OnboardingContextValue {
  step: StepId;
  goTo: (step: StepId) => void;
  next: () => void;
  back: () => void;
  status: Record<StepId, StepStatus>;
  drafts: Record<string, unknown>;
  setDraft: (key: string, update: unknown | ((prev: unknown) => unknown)) => void;
}

export const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('useOnboarding must be used inside the onboarding wizard');
  return ctx;
}

/**
 * Like useState, but the value lives in the wizard (not the step), so typed input survives
 * navigating between steps. Keys starting with "secret." are kept in memory only, everything else
 * also survives a reload (sessionStorage).
 */
export function useDraftField<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const { drafts, setDraft } = useOnboarding();
  const value = (key in drafts ? drafts[key] : initial) as T;
  const set = useCallback(
    (v: T | ((prev: T) => T)) =>
      setDraft(key, (prev: unknown) => (typeof v === 'function' ? (v as (p: T) => T)(prev === undefined ? initial : (prev as T)) : v)),
    // `initial` is only a fallback for the first update; it must not re-create the setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, setDraft],
  );
  return [value, set];
}
