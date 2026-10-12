import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../../api/keys';
import { useSettings, useSetupStatus } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { useT } from '../../i18n';
import { clearOnboardingSession } from './state';

/** Path the app was opened with (the auto-redirect only happens for the start page, not for deep links). */
const initialPath = window.location.pathname;
let redirectChecked = false;

/**
 * Sends first-time users to the onboarding wizard once per app load: only when the app was opened
 * on the start page, the wizard was never completed/skipped and the server setup is not complete
 * (existing, fully set-up installations are left alone).
 * Returns true while the decision is pending, so the dashboard doesn't flash before the redirect.
 */
export function useOnboardingRedirect(): boolean {
  const settings = useSettings();
  const setup = useSetupStatus();
  const navigate = useNavigate();
  const [, force] = useState(0);
  const relevant = !redirectChecked && initialPath === '/';

  useEffect(() => {
    if (redirectChecked) return;
    if (initialPath !== '/') {
      redirectChecked = true;
      return;
    }
    if (settings.error || setup.error) {
      redirectChecked = true;
      force((n) => n + 1);
      return;
    }
    if (!settings.data || !setup.data) return;
    redirectChecked = true;
    if (!settings.data.general.onboardingCompletedAt && !setup.data.complete) navigate('/onboarding', { replace: true });
    else force((n) => n + 1);
  }, [settings.data, settings.error, setup.data, setup.error, navigate]);

  return relevant;
}

/** Opens the wizard from the start (used by the "Run setup wizard" buttons). */
export function useStartOnboarding(): () => void {
  const navigate = useNavigate();
  return () => {
    clearOnboardingSession();
    navigate('/onboarding');
  };
}

/**
 * Marks the onboarding as completed (or skipped) on the server – afterwards there is no more
 * auto-redirect – and navigates to the given path.
 */
export function useCompleteOnboarding() {
  const qc = useQueryClient();
  const t = useT();
  const navigate = useNavigate();
  return useAction((_to: string) => rpc('settings.update', { general: { onboardingCompletedAt: new Date().toISOString() } }), {
    error: t('onboarding.finishFailed'),
    onSuccess: (settings, to) => {
      qc.setQueryData(qk.settings, settings);
      clearOnboardingSession();
      navigate(to, { replace: true });
    },
  });
}
