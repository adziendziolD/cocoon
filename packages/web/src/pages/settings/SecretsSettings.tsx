import { useState } from 'react';
import { isGithubTokenName, KNOWN_SECRETS, localize, type SecretInfo } from '@cocoon/protocol';
import { ExternalLink, KeyRound, Plug, Plus, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { qk } from '../../api/keys';
import { useSecrets, useSettings } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { useSaveSecret } from '../../api/useSaveSecret';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardHeader } from '../../components/Card';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { SecretInput } from '../../components/SecretInput';
import { ErrorState, LoadingState } from '../../components/States';
import { rich, useLanguage, useT } from '../../i18n';
import { formatRelative } from '../../lib/format';
import { secretLabel } from '../../lib/secrets';

const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function SecretsSettings() {
  const t = useT();
  const { lang } = useLanguage();
  const secrets = useSecrets();
  const settings = useSettings();
  const [addOpen, setAddOpen] = useState(false);
  const [addGithubOpen, setAddGithubOpen] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);

  const del = useAction((name: string) => rpc('secrets.delete', { name }), {
    success: (_, name) => t('secrets.deleted', { name: secretLabel(name, lang) }),
    error: t('common.deleteFailed'),
    invalidate: [qk.secrets, qk.setup],
    onSuccess: () => setToDelete(null),
  });

  if (secrets.isLoading) return <LoadingState />;
  if (secrets.error) return <ErrorState error={secrets.error} onRetry={() => secrets.refetch()} />;

  const byName = new Map((secrets.data ?? []).map((s) => [s.name, s]));
  const githubTokens = (secrets.data ?? []).filter((s) => s.name !== 'GITHUB_TOKEN' && isGithubTokenName(s.name));
  const custom = (secrets.data ?? []).filter((s) => !(s.name in KNOWN_SECRETS) && !isGithubTokenName(s.name));
  // Secret name -> labels of the API providers that use it as their key.
  const providersBySecret = new Map<string, string[]>();
  for (const p of Object.values(settings.data?.providers ?? {})) {
    if (p.secret) providersBySecret.set(p.secret, [...(providersBySecret.get(p.secret) ?? []), p.label]);
  }
  const providersLink = (
    <Link to="/settings/providers" className="font-medium text-accent hover:underline">
      {t('secrets.providersLink')}
    </Link>
  );

  return (
    <div className="space-y-6">
      <Callout tone="info" title={t('secrets.intro.title')}>
        {t('secrets.intro.text')} {rich(t('secrets.intro.providers'), { link: providersLink })}
      </Callout>

      <Card>
        <CardHeader title={t('secrets.known.title')} description={t('secrets.known.description')} />
        <ul className="divide-y divide-line">
          {Object.entries(KNOWN_SECRETS).map(([name, meta]) => (
            <SecretRow
              key={name}
              name={name}
              label={localize(meta.label, lang)}
              description={localize(meta.description, lang)}
              helpUrl={meta.helpUrl}
              info={byName.get(name)}
              onDelete={() => setToDelete(name)}
            />
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title={t('secrets.github.title')}
          description={t('secrets.github.description')}
          actions={
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAddGithubOpen(true)}>
              {t('common.add')}
            </Button>
          }
        />
        {githubTokens.length === 0 ? (
          <p className="px-5 py-4 text-sm text-fg-muted">{t('secrets.github.empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {githubTokens.map((s) => (
              <SecretRow key={s.name} name={s.name} info={s} onDelete={() => setToDelete(s.name)} />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={t('secrets.custom.title')}
          description={t('secrets.custom.description')}
          actions={
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAddOpen(true)}>
              {t('common.add')}
            </Button>
          }
        />
        {custom.length === 0 ? (
          <p className="px-5 py-4 text-sm text-fg-muted">{t('secrets.custom.empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {custom.map((s) => (
              <SecretRow key={s.name} name={s.name} info={s} providers={providersBySecret.get(s.name)} onDelete={() => setToDelete(s.name)} />
            ))}
          </ul>
        )}
      </Card>

      <AddSecretDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <AddSecretDialog open={addGithubOpen} onClose={() => setAddGithubOpen(false)} github />
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete)}
        loading={del.isPending}
        danger
        title={t('secrets.delete.title')}
        confirmLabel={t('common.delete')}
        message={rich(t('secrets.delete.message'), { name: <strong className="text-fg">{toDelete && secretLabel(toDelete, lang)}</strong> })}
      />
    </div>
  );
}

function SecretRow({
  name,
  label,
  description,
  helpUrl,
  info,
  providers,
  onDelete,
}: {
  name: string;
  label?: string;
  description?: string;
  helpUrl?: string;
  info?: SecretInfo;
  /** Labels of API providers using this secret as their key. */
  providers?: string[];
  onDelete: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const isSet = !!info?.set;
  const fromEnv = info?.source === 'env';
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <KeyRound className="mt-0.5 size-4 text-fg-subtle" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{label ?? name}</span>
            {label && <span className="font-mono text-xs text-fg-subtle">{name}</span>}
            {isSet ? <Badge tone="green">{t('secrets.row.set')}</Badge> : <Badge tone="gray">{t('secrets.row.notSet')}</Badge>}
            {providers?.map((p) => (
              <Link key={p} to="/settings/providers" className="hover:opacity-80">
                <Badge tone="blue">
                  <Plug className="size-3" />
                  {t('secrets.row.provider', { label: p })}
                </Badge>
              </Link>
            ))}
          </div>
          {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
          {isSet && (
            <p className="mt-1 text-xs text-fg-subtle">
              <span className="font-mono">{info?.preview ?? '••••'}</span>
              {fromEnv ? t('secrets.row.fromEnv') : info?.updatedAt ? t('secrets.row.savedAt', { time: formatRelative(info.updatedAt) }) : ''}
            </p>
          )}
          {helpUrl && (
            <a href={helpUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline">
              {t('secrets.row.whereToGet')} <ExternalLink className="size-3" />
            </a>
          )}
        </div>
        {!editing && (
          <div className="flex gap-2">
            <Button size="sm" variant={isSet ? 'secondary' : 'primary'} onClick={() => setEditing(true)}>
              {isSet ? t('secrets.row.replace') : t('secrets.row.setValue')}
            </Button>
            {isSet && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="size-3.5" />}
                onClick={onDelete}
                disabled={fromEnv}
                title={fromEnv ? t('secrets.row.envNoDelete') : t('common.delete')}
              >
                {t('common.delete')}
              </Button>
            )}
          </div>
        )}
      </div>
      {editing && <SecretEditor name={name} onDone={() => setEditing(false)} overridesEnv={fromEnv} />}
    </li>
  );
}

function SecretEditor({ name, onDone, overridesEnv }: { name: string; onDone: () => void; overridesEnv?: boolean }) {
  const t = useT();
  const [value, setValue] = useState('');
  const save = useSaveSecret(name, { onSuccess: onDone });
  return (
    <form
      className="mt-3 ml-7 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) save.mutate(value.trim());
      }}
    >
      <div className="flex gap-2">
        <SecretInput value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('secrets.editor.placeholder')} autoFocus />
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!value.trim()}>
          {t('common.save')}
        </Button>
        <Button onClick={onDone}>{t('common.cancel')}</Button>
      </div>
      <p className="text-xs text-fg-subtle">
        {t('secrets.editor.neverShown')}
        {overridesEnv ? t('secrets.editor.overridesEnv') : ''}
      </p>
    </form>
  );
}

function AddSecretDialog({ open, onClose, github = false }: { open: boolean; onClose: () => void; github?: boolean }) {
  const t = useT();
  const [name, setName] = useState(github ? 'GITHUB_TOKEN_' : '');
  const [value, setValue] = useState('');
  const nameErr = name && !NAME_RE.test(name) ? t('secrets.add.invalidName') : github && name && name !== 'GITHUB_TOKEN' && !isGithubTokenName(name) ? t('secrets.github.invalidName') : undefined;
  const save = useAction(() => rpc('secrets.set', { name, value }), {
    success: t('secrets.add.success'),
    error: t('common.saveFailed'),
    invalidate: [qk.secrets],
    onSuccess: () => {
      setName(github ? 'GITHUB_TOKEN_' : '');
      setValue('');
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={github ? t('secrets.github.add') : t('secrets.add.title')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!name || !!nameErr || !value} loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('common.name')} error={nameErr} hint={t('secrets.add.nameHint')}>
          <Input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder={github ? 'GITHUB_TOKEN_COMPANY' : t('secrets.add.namePlaceholder')} className="font-mono" invalid={!!nameErr} />
        </Field>
        <Field label={t('common.value')}>
          <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} className="font-mono" autoComplete="off" />
        </Field>
      </div>
    </Dialog>
  );
}
