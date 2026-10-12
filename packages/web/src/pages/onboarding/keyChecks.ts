import type { TestResult } from '../../lib/providers';
import { useDraftField } from './context';

/** Outcome of the last key verification: ok (or not tested), rejected by the provider, or not verifiable (e.g. unreachable). */
export type Verdict = 'ok' | 'rejected' | 'unverified';

const verdict = (r: TestResult | null): Verdict => (!r || r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'rejected' : 'unverified');

/** Verification verdicts of the built-in API keys checked in the "AI access" step (kept in the wizard drafts). */
export function useKeyVerdicts(): Record<'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY', Verdict> {
  const [anthropic] = useDraftField<TestResult | null>('ai.test.ANTHROPIC_API_KEY', null);
  const [openai] = useDraftField<TestResult | null>('ai.test.OPENAI_API_KEY', null);
  return { ANTHROPIC_API_KEY: verdict(anthropic), OPENAI_API_KEY: verdict(openai) };
}
