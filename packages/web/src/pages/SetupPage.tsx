import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { PASSWORD_MIN_LENGTH } from '@cocoon/protocol';
import { completeSetup, formMessage, setupInfo } from '../api/authApi';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input } from '../components/Field';
import { Callout } from '../components/HelpText';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { PasswordInput } from '../components/PasswordInput';
import { LoadingState } from '../components/States';
import { useT } from '../i18n';
import { clearPendingSetup, setToken } from '../lib/auth';

/**
 * Opened with the link an admin shares (`/#setup=<token>`): a new user, or a user whose password was reset, chooses a
 * password and is signed in. The admin never sees the password.
 */
export function SetupPage({ token }: { token: string }) {
  const t = useT();
  const info = useQuery({ queryKey: ['setup-info', token], queryFn: () => setupInfo(token), retry: false, staleTime: Infinity });

  return (
    <div className="relative flex min-h-full items-center justify-center bg-gradient-to-b from-accent-soft to-canvas p-4">
      <LanguageSwitcher className="absolute top-4 right-4" />
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg">
            <KeyRound className="size-6" />
          </div>
          <h1 className="text-2xl font-semibold text-fg">{t('choosePassword.title')}</h1>
          {info.data && <p className="mt-1 text-fg-muted">{t('choosePassword.greeting', { name: info.data.displayName || info.data.username })}</p>}
        </div>
        <Card className="p-6">
          {info.isPending ? (
            <LoadingState label={t('choosePassword.checking')} className="py-4" />
          ) : info.isError ? (
            <div className="space-y-4">
              <Callout tone="danger" title={t('choosePassword.invalidTitle')}>
                {formMessage(info.error)}
              </Callout>
              <Button className="w-full" onClick={clearPendingSetup}>
                {t('choosePassword.toLogin')}
              </Button>
            </div>
          ) : (
            <SetupForm token={token} username={info.data.username} />
          )}
        </Card>
      </div>
    </div>
  );
}

function SetupForm({ token, username }: { token: string; username: string }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const tooShort = [...password].length < PASSWORD_MIN_LENGTH;
  const mismatch = again.length > 0 && password !== again;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (tooShort || password !== again) return;
    setLoading(true);
    setError(null);
    try {
      const session = await completeSetup(token, password);
      setToken(session.token);
      clearPendingSetup();
    } catch (err) {
      setError(formMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* Lets password managers file the new password under the right account. */}
      <Input type="text" name="username" autoComplete="username" value={username} readOnly hidden aria-hidden tabIndex={-1} />
      <Field label={t('choosePassword.newPassword')} htmlFor="new-password" error={error} hint={t('choosePassword.hint', { min: PASSWORD_MIN_LENGTH })}>
        <PasswordInput id="new-password" name="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" invalid={!!error} autoFocus />
      </Field>
      <Field label={t('choosePassword.confirm')} htmlFor="confirm-password" error={mismatch ? t('choosePassword.mismatch') : undefined}>
        <PasswordInput id="confirm-password" name="confirm-password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" invalid={mismatch} />
      </Field>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} disabled={tooShort || password !== again}>
        {t('choosePassword.submit')}
      </Button>
      {password.length > 0 && tooShort && <p className="text-center text-xs text-fg-muted">{t('choosePassword.tooShort', { min: PASSWORD_MIN_LENGTH })}</p>}
    </form>
  );
}
