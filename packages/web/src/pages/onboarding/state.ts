import type { MessageKey } from '../../i18n';

export const STEP_IDS = ['welcome', 'system', 'ai', 'github', 'defaults', 'sandbox', 'agent', 'done'] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABELS: Record<StepId, MessageKey> = {
  welcome: 'onboarding.step.welcome',
  system: 'onboarding.step.system',
  ai: 'onboarding.step.ai',
  github: 'onboarding.step.github',
  defaults: 'onboarding.step.defaults',
  sandbox: 'onboarding.step.sandbox',
  agent: 'onboarding.step.agent',
  done: 'onboarding.step.done',
};

export const isStepId = (v: unknown): v is StepId => typeof v === 'string' && (STEP_IDS as readonly string[]).includes(v);

/**
 * Wizard progress kept in sessionStorage (per browser tab), so a reload continues where the user was.
 * Draft keys starting with "secret." (pasted API keys) are never written to storage.
 */
export interface PersistedState {
  step: StepId;
  /** Steps the user has left with "Next" (or explicitly skipped). */
  passed: StepId[];
  drafts: Record<string, unknown>;
}

const STORAGE_KEY = 'cocoon.onboarding';

export function loadState(): PersistedState {
  const empty: PersistedState = { step: 'welcome', passed: [], drafts: {} };
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const data = JSON.parse(raw) as Partial<PersistedState>;
    return {
      step: isStepId(data.step) ? data.step : 'welcome',
      passed: Array.isArray(data.passed) ? data.passed.filter(isStepId) : [],
      drafts: data.drafts && typeof data.drafts === 'object' ? data.drafts : {},
    };
  } catch {
    return empty;
  }
}

export function saveState(state: PersistedState): void {
  const drafts = Object.fromEntries(Object.entries(state.drafts).filter(([k]) => !k.startsWith('secret.')));
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, drafts }));
  } catch {
    // Storage unavailable (privacy mode) – progress just won't survive a reload.
  }
}

/** Forgets the wizard progress of this tab, so the next visit of /onboarding starts at the welcome step. */
export function clearOnboardingSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
