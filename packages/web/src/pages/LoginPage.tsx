import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, LogIn } from 'lucide-react';
import { describeError, rpc } from '../api/rpc';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input } from '../components/Field';
import { Callout } from '../components/HelpText';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { rich, useT } from '../i18n';
import { setToken, wasSessionExpired } from '../lib/auth';

export function LoginPage() {
  const t = useT();
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const expired = wasSessionExpired();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      await rpc('system.info', {}, token);
      setToken(token);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-full items-center justify-center bg-gradient-to-b from-accent-soft to-canvas p-4">
      <LanguageSwitcher className="absolute top-4 right-4" />
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg">
            <KeyRound className="size-6" />
          </div>
          <h1 className="text-2xl font-semibold text-fg">{t('login.welcome')}</h1>
          <p className="mt-1 text-fg-muted">{t('login.tagline')}</p>
        </div>
        <Card className="p-6">
          {expired && (
            <Callout tone="warning" className="mb-4" title={t('login.expiredTitle')}>
              {t('login.expiredText')}
            </Callout>
          )}
          <form onSubmit={submit} className="space-y-4">
            <Field
              label={t('login.tokenLabel')}
              htmlFor="token"
              error={error}
              hint={rich(t('login.tokenHint'), { file: <code className="rounded bg-surface-2 px-1">.data/admin-token.txt</code> })}
            >
              <div className="relative">
                <Input
                  id="token"
                  type={show ? 'text' : 'password'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={t('login.tokenPlaceholder')}
                  autoComplete="current-password"
                  className="pr-10 font-mono"
                  invalid={!!error}
                  autoFocus
                />
                <button type="button" onClick={() => setShow((s) => !s)} className="absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-subtle hover:text-fg" aria-label={show ? t('common.hide') : t('common.show')}>
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </Field>
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} disabled={!value.trim()} icon={<LogIn className="size-4" />}>
              {t('login.submit')}
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-xs text-fg-subtle">{t('login.storedLocally')}</p>
      </div>
    </div>
  );
}
