import { useRef, useState, type FormEvent } from 'react';
import { KeyRound, LogIn } from 'lucide-react';
import { formMessage, login } from '../api/authApi';
import { describeError, rpc } from '../api/rpc';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Field, Input } from '../components/Field';
import { Callout } from '../components/HelpText';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { PasswordInput } from '../components/PasswordInput';
import { rich, useT } from '../i18n';
import { getLoginMode, setLoginMode, setToken, wasSessionExpired, type LoginMode } from '../lib/auth';

export function LoginPage() {
  const t = useT();
  const [mode, setMode] = useState<LoginMode>(getLoginMode);
  const expired = wasSessionExpired();

  const switchMode = () => {
    const next = mode === 'password' ? 'token' : 'password';
    setLoginMode(next);
    setMode(next);
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
          {mode === 'password' ? <PasswordForm /> : <TokenForm />}
        </Card>
        <p className="mt-4 text-center text-sm">
          <button type="button" onClick={switchMode} className="text-accent hover:underline">
            {mode === 'password' ? t('login.useToken') : t('login.usePassword')}
          </button>
        </p>
        <p className="mt-2 text-center text-xs text-fg-subtle">{t('login.storedLocally')}</p>
      </div>
    </div>
  );
}

function PasswordForm() {
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const passwordField = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setLoading(true);
    setError(null);
    const submitted = password;
    try {
      const session = await login(username.trim(), submitted);
      setToken(session.token);
    } catch (err) {
      setError(formMessage(err));
      // A wrong password is cleared, unless the person has already started typing the next one.
      setPassword((current) => (current === submitted ? '' : current));
      passwordField.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label={t('login.usernameLabel')} htmlFor="username">
        <Input id="username" name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus invalid={!!error} />
      </Field>
      <Field label={t('login.passwordLabel')} htmlFor="password" error={error} hint={error ? undefined : t('login.passwordHint')}>
        <PasswordInput ref={passwordField} id="password" name="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" invalid={!!error} />
      </Field>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} disabled={!username.trim() || !password} icon={<LogIn className="size-4" />}>
        {t('login.submit')}
      </Button>
    </form>
  );
}

/** Admin and API tokens: unchanged. The token is checked with a cheap call before it is kept. */
function TokenForm() {
  const t = useT();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    <form onSubmit={submit} className="space-y-4">
      <Field
        label={t('login.tokenLabel')}
        htmlFor="token"
        error={error}
        hint={rich(t('login.tokenHint'), { file: <code className="rounded bg-surface-2 px-1">.data/admin-token.txt</code> })}
      >
        <PasswordInput id="token" value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('login.tokenPlaceholder')} autoComplete="current-password" className="font-mono" invalid={!!error} autoFocus />
      </Field>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} disabled={!value.trim()} icon={<LogIn className="size-4" />}>
        {t('login.submit')}
      </Button>
    </form>
  );
}
