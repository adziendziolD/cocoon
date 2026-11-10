import { useState } from 'react';
import { Link2, Plus, Trash2, UserCheck, UserX } from 'lucide-react';
import type { SetupLink, UserInfo, UserRole } from '@cocoon/protocol';
import { qk } from '../../api/keys';
import { useUsers } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { CodeBlock } from '../../components/CodeBlock';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { Field, Input, Select } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { ErrorState, LoadingState } from '../../components/States';
import { rich, useT } from '../../i18n';
import { formatDateTime, formatRelative } from '../../lib/format';
import { useIdentity } from '../../lib/identity';
import type { Tone } from '../../lib/status';

const displayName = (user: Pick<UserInfo, 'username' | 'displayName'>) => user.displayName || user.username;

export function UsersSettings() {
  const t = useT();
  const users = useUsers();
  const { identity } = useIdentity();
  const [createOpen, setCreateOpen] = useState(false);
  const [link, setLink] = useState<{ name: string; setup: SetupLink } | null>(null);
  const [toReset, setToReset] = useState<UserInfo | null>(null);
  const [toDelete, setToDelete] = useState<UserInfo | null>(null);

  const update = useAction((v: { user: UserInfo; role?: UserRole; disabled?: boolean }) => rpc('users.update', { userId: v.user.id, role: v.role, disabled: v.disabled }), {
    error: t('users.updateFailed'),
    invalidate: [qk.users],
    success: (_user, v) => (v.role ? t('users.roleChanged', { name: displayName(v.user) }) : v.disabled ? t('users.disabled') : t('users.enabled')),
  });
  const reset = useAction((user: UserInfo) => rpc('users.reset_password', { userId: user.id }), {
    error: t('users.resetFailed'),
    invalidate: [qk.users],
    onSuccess: (result, user) => {
      setToReset(null);
      setLink({ name: displayName(user), setup: result.setup });
    },
  });
  const remove = useAction((user: UserInfo) => rpc('users.delete', { userId: user.id }), {
    success: t('users.deleted'),
    error: t('users.deleteFailed'),
    invalidate: [qk.users],
    onSuccess: () => setToDelete(null),
  });

  return (
    <div className="space-y-6">
      <Callout tone="info" title={t('users.rolesTitle')}>
        {t('users.rolesText')}
      </Callout>

      <Card>
        <CardHeader
          title={t('users.title')}
          description={t('users.description')}
          actions={
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setCreateOpen(true)}>
              {t('users.new')}
            </Button>
          }
        />
        {users.isLoading ? (
          <LoadingState />
        ) : users.error ? (
          <ErrorState error={users.error} className="m-4" onRetry={() => users.refetch()} />
        ) : !users.data?.length ? (
          <CardBody className="text-sm text-fg-muted">{t('users.empty')}</CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {users.data.map((user) => {
              const self = identity.user?.id === user.id;
              return (
                <UserRow
                  key={user.id}
                  user={user}
                  self={self}
                  busy={update.isPending}
                  onRole={(role) => update.mutate({ user, role })}
                  onDisabled={(disabled) => update.mutate({ user, disabled })}
                  onReset={() => setToReset(user)}
                  onDelete={() => setToDelete(user)}
                />
              );
            })}
          </ul>
        )}
      </Card>

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(user, setup) => {
          setCreateOpen(false);
          setLink({ name: displayName(user), setup });
        }}
      />
      <LinkDialog link={link} onClose={() => setLink(null)} />
      <ConfirmDialog
        open={!!toReset}
        onClose={() => setToReset(null)}
        onConfirm={() => toReset && reset.mutate(toReset)}
        loading={reset.isPending}
        danger
        title={t('users.reset.title')}
        confirmLabel={t('users.reset.confirm')}
        message={rich(t('users.reset.message'), { name: <strong className="text-fg">{toReset && displayName(toReset)}</strong> })}
      />
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && remove.mutate(toDelete)}
        loading={remove.isPending}
        danger
        title={t('users.delete.title')}
        confirmLabel={t('users.action.delete')}
        message={rich(t('users.delete.message'), { name: <strong className="text-fg">{toDelete && displayName(toDelete)}</strong> })}
      />
    </div>
  );
}

function UserRow({
  user,
  self,
  busy,
  onRole,
  onDisabled,
  onReset,
  onDelete,
}: {
  user: UserInfo;
  self: boolean;
  busy: boolean;
  onRole: (role: UserRole) => void;
  onDisabled: (disabled: boolean) => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const expired = user.status === 'invited' && user.setupExpiresAt !== undefined && Date.parse(user.setupExpiresAt) <= Date.now();
  const status: { tone: Tone; label: string } =
    user.status === 'disabled'
      ? { tone: 'gray', label: t('users.status.disabled') }
      : user.status === 'invited'
        ? expired
          ? { tone: 'red', label: t('users.status.expired') }
          : { tone: 'amber', label: t('users.status.invited') }
        : { tone: 'green', label: t('users.status.active') };

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent uppercase">{displayName(user).charAt(0)}</span>
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-fg">{displayName(user)}</span>
          {self && <Badge tone="blue">{t('users.you')}</Badge>}
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <div className="mt-0.5 text-xs text-fg-subtle">
          <span className="font-mono">{user.username}</span>
          {' · '}
          {user.status === 'invited' && user.setupExpiresAt
            ? t('users.linkUntil', { date: formatDateTime(user.setupExpiresAt) })
            : user.lastLoginAt
              ? t('users.lastLogin', { time: formatRelative(user.lastLoginAt) })
              : t('users.neverLoggedIn')}
          {user.sessions > 0 && ` · ${t('users.sessions', { count: user.sessions })}`}
        </div>
      </div>
      <div className="w-36 shrink-0">
        <Select value={user.role} onChange={(e) => onRole(e.target.value as UserRole)} disabled={self || busy} aria-label={t('users.roleLabel', { name: displayName(user) })}>
          <option value="member">{t('users.role.member')}</option>
          <option value="admin">{t('users.role.admin')}</option>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" icon={<Link2 className="size-3.5" />} onClick={onReset} disabled={self}>
          {t('users.action.newLink')}
        </Button>
        {user.status === 'disabled' ? (
          <Button size="sm" variant="ghost" icon={<UserCheck className="size-3.5" />} onClick={() => onDisabled(false)} disabled={busy}>
            {t('users.action.enable')}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon={<UserX className="size-3.5" />} onClick={() => onDisabled(true)} disabled={self || busy}>
            {t('users.action.disable')}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={onDelete} disabled={self}>
          {t('users.action.delete')}
        </Button>
      </div>
    </li>
  );
}

function CreateUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (user: UserInfo, setup: SetupLink) => void }) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const close = () => {
    setUsername('');
    setName('');
    setRole('member');
    onClose();
  };
  const create = useAction(() => rpc('users.create', { username: username.trim(), displayName: name.trim() || undefined, role }), {
    success: t('users.create.success'),
    error: t('users.create.failed'),
    invalidate: [qk.users],
    onSuccess: (result) => {
      onCreated(result.user, result.setup);
      setUsername('');
      setName('');
      setRole('member');
    },
  });
  const ready = username.trim().length >= 3;

  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={t('users.create.title')}
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!ready} loading={create.isPending} onClick={() => create.mutate()}>
            {t('users.create.submit')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) create.mutate();
        }}
      >
        <Callout tone="tip">{t('users.create.hint')}</Callout>
        <Field label={t('users.create.username')} hint={t('users.create.usernameHint')}>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={64} autoCapitalize="none" spellCheck={false} autoComplete="off" />
        </Field>
        <Field label={t('users.create.displayName')} optional>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
        </Field>
        <Field label={t('users.create.role')}>
          <Select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            <option value="member">{t('users.role.member')}</option>
            <option value="admin">{t('users.role.admin')}</option>
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}

/** Shows a one-time setup link. It is kept nowhere: closing the dialog loses it (a new one is one click away). */
function LinkDialog({ link, onClose }: { link: { name: string; setup: SetupLink } | null; onClose: () => void }) {
  const t = useT();
  const url = link ? `${window.location.origin}/#setup=${link.setup.token}` : '';
  return (
    <Dialog
      open={!!link}
      onClose={onClose}
      dismissable={false}
      title={t('users.link.title', { name: link?.name ?? '' })}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('users.link.done')}
        </Button>
      }
    >
      {link && (
        <div className="space-y-3">
          <Callout tone="warning" title={t('users.link.onlyNowTitle')}>
            {t('users.link.onlyNowText', { name: link.name, date: formatDateTime(link.setup.expiresAt) })}
          </Callout>
          <CodeBlock code={url} />
        </div>
      )}
    </Dialog>
  );
}
