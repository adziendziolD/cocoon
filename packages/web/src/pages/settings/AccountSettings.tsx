import { useState, type FormEvent } from 'react';
import { KeyRound, LogOut, UserCircle } from 'lucide-react';
import { PASSWORD_MIN_LENGTH } from '@cocoon/protocol';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ConfirmDialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { PasswordInput } from '../../components/PasswordInput';
import { useT } from '../../i18n';
import { formatDateTime } from '../../lib/format';
import { identityName, useIdentity, useSignOut } from '../../lib/identity';

/** Settings → My account: who is signed in, the own password and signing out. Open to every role. */
export function AccountSettings() {
  const t = useT();
  const { identity, isAdmin } = useIdentity();
  const signOut = useSignOut();
  const [confirm, setConfirm] = useState<'here' | 'everywhere' | null>(null);
  const isUser = identity.kind === 'user';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={t('account.who.title')} icon={<UserCircle className="size-4.5" />} />
        <CardBody className="flex flex-wrap items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-base font-semibold text-accent uppercase">
            {isUser ? identityName(identity, '?').charAt(0) : <KeyRound className="size-5" />}
          </span>
          <div className="min-w-0 flex-1">
            {isUser ? (
              <>
                <div className="font-medium text-fg">{identityName(identity, '')}</div>
                <div className="font-mono text-xs text-fg-subtle">{identity.user?.username}</div>
              </>
            ) : (
              <div className="font-medium text-fg">{t('account.who.token', { name: identity.tokenName ?? '' })}</div>
            )}
            {identity.sessionExpiresAt && <div className="mt-1 text-xs text-fg-muted">{t('account.who.until', { date: formatDateTime(identity.sessionExpiresAt) })}</div>}
          </div>
          <Badge tone={isAdmin ? 'accent' : 'gray'}>{isAdmin ? t('users.role.admin') : t('users.role.member')}</Badge>
        </CardBody>
      </Card>

      {isUser ? (
        <PasswordCard username={identity.user?.username ?? ''} />
      ) : (
        <Callout tone="info">{t('account.password.tokenOnly')}</Callout>
      )}

      <Card>
        <CardHeader title={t('account.signOut.title')} />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <p className="flex-1 text-sm text-fg-muted">{isUser ? t('account.signOut.textUser') : t('account.signOut.textToken')}</p>
            <Button icon={<LogOut className="size-4" />} onClick={() => setConfirm('here')}>
              {t('account.signOut.button')}
            </Button>
          </div>
          {isUser && (
            <div className="flex flex-wrap items-center gap-4 border-t border-line pt-4">
              <p className="flex-1 text-sm text-fg-muted">{t('account.signOut.everywhereText')}</p>
              <Button icon={<LogOut className="size-4" />} onClick={() => setConfirm('everywhere')}>
                {t('account.signOut.everywhere')}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => signOut(confirm === 'everywhere')}
        title={confirm === 'everywhere' ? t('account.signOut.confirmEverywhereTitle') : t('account.signOut.confirmTitle')}
        confirmLabel={confirm === 'everywhere' ? t('account.signOut.everywhere') : t('account.signOut.button')}
        message={confirm === 'everywhere' ? t('account.signOut.confirmEverywhere') : isUser ? t('account.signOut.textUser') : t('account.signOut.textToken')}
      />
    </div>
  );
}

function PasswordCard({ username }: { username: string }) {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const tooShort = [...next].length < PASSWORD_MIN_LENGTH;
  const mismatch = again.length > 0 && next !== again;
  const change = useAction(() => rpc('auth.change_password', { currentPassword: current, newPassword: next }), {
    success: t('account.password.success'),
    error: t('account.password.failed'),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setAgain('');
    },
  });
  const ready = current.length > 0 && !tooShort && next === again;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) change.mutate();
  };

  return (
    <Card>
      <CardHeader title={t('account.password.title')} description={t('account.password.description')} icon={<KeyRound className="size-4.5" />} />
      <CardBody>
        <form onSubmit={submit} className="max-w-md space-y-4">
          {/* Lets password managers file the new password under the right account. */}
          <Input type="text" name="username" autoComplete="username" value={username} readOnly hidden aria-hidden tabIndex={-1} />
          <Field label={t('account.password.current')} htmlFor="current-password">
            <PasswordInput id="current-password" name="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label={t('account.password.new')} htmlFor="new-password" hint={t('choosePassword.hint', { min: PASSWORD_MIN_LENGTH })}>
            <PasswordInput id="new-password" name="new-password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label={t('account.password.confirm')} htmlFor="confirm-password" error={mismatch ? t('choosePassword.mismatch') : undefined}>
            <PasswordInput id="confirm-password" name="confirm-password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" invalid={mismatch} />
          </Field>
          <Button type="submit" variant="primary" loading={change.isPending} disabled={!ready}>
            {t('account.password.submit')}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
