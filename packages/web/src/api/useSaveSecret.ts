import { useLanguage, useT } from '../i18n';
import { secretLabel } from '../lib/secrets';
import { qk } from './keys';
import { rpc } from './rpc';
import { useAction } from './useAction';

/** Stores a secret (API key / token) with the usual toast and cache refresh. */
export function useSaveSecret(name: string, opts: { silent?: boolean; onSuccess?: () => void } = {}) {
  const t = useT();
  const { lang } = useLanguage();
  return useAction((value: string) => rpc('secrets.set', { name, value }), {
    success: opts.silent ? undefined : t('secrets.saved', { name: secretLabel(name, lang) }),
    error: t('common.saveFailed'),
    invalidate: [qk.secrets, qk.setup],
    onSuccess: () => opts.onSuccess?.(),
  });
}
