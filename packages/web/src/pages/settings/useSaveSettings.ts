import { useQueryClient } from '@tanstack/react-query';
import type { MethodParams, Settings } from '@cocoon/protocol';
import { qk } from '../../api/keys';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { useT } from '../../i18n';

type Patch = MethodParams<'settings.update'>;
type Section = NonNullable<MethodParams<'settings.reset'>['section']>;

/** Saves a partial settings patch and writes the returned settings straight into the cache. */
export function useSaveSettings(success?: string, onSaved?: (settings: Settings) => void) {
  const qc = useQueryClient();
  const t = useT();
  return useAction((patch: Patch) => rpc('settings.update', patch), {
    success: success ?? t('saveSettings.saved'),
    error: t('saveSettings.saveFailed'),
    invalidate: [qk.setup],
    onSuccess: (settings) => {
      qc.setQueryData(qk.settings, settings);
      onSaved?.(settings);
    },
  });
}

export function useResetSettings(onReset?: (settings: Settings) => void) {
  const qc = useQueryClient();
  const t = useT();
  return useAction((section: Section) => rpc('settings.reset', { section }), {
    success: t('saveSettings.resetDone'),
    error: t('saveSettings.resetFailed'),
    onSuccess: (settings) => {
      qc.setQueryData(qk.settings, settings);
      onReset?.(settings);
    },
  });
}
