import { useState } from 'react';
import { defaultBaseUrlEnv, DEFAULT_ENV_FILE, type EnvScopeRef, type EnvTarget, type EnvVar } from '@cocoon/protocol';
import { FileText, KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { qk } from '../api/keys';
import { useEnvScope } from '../api/queries';
import { rpc } from '../api/rpc';
import { useAction } from '../api/useAction';
import { useT } from '../i18n';
import { Badge } from './Badge';
import { Button, IconButton } from './Button';
import { Card, CardBody, CardHeader } from './Card';
import { Dialog } from './Dialog';
import { Checkbox, Field, Input, Select, Textarea } from './Field';
import { SecretInput } from './SecretInput';
import { ErrorState, LoadingState } from './States';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Draft {
  name: string;
  value: string;
  target: EnvTarget;
  secret: boolean;
  proxyHost: string;
  /** Editing an existing variable: the value may stay empty (keeps the stored one). */
  existing: boolean;
}

const emptyDraft = (): Draft => ({ name: '', value: '', target: 'env', secret: true, proxyHost: '', existing: false });
const draftOf = (v: EnvVar): Draft => ({ name: v.name, value: v.value ?? '', target: v.target, secret: v.secret, proxyHost: v.proxyHost ?? '', existing: true });

/**
 * Variables of one level (workspace, repository or sandbox): add, change, remove, paste a .env file.
 * Values of secrets are write-only – the server never sends them back.
 */
export function EnvScopeEditor({ scope, title, description }: { scope: EnvScopeRef; title: string; description?: string }) {
  const t = useT();
  const query = useEnvScope(scope);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const invalidate = [qk.envAll];

  const remove = useAction((name: string) => rpc('env.unset', { ...scope, names: [name] }), {
    success: (_, name) => t('env.editor.removed', { name }),
    error: t('env.editor.removeFailed'),
    invalidate,
  });
  const saveFilePath = useAction((path: string) => rpc('env.set', { ...scope, vars: [], filePath: path }), {
    success: t('env.editor.filePathSaved'),
    error: t('env.editor.saveFailed'),
    invalidate,
    onSuccess: () => setFilePath(null),
  });

  return (
    <Card>
      <CardHeader
        icon={<KeyRound className="size-4.5" />}
        title={title}
        description={description}
        actions={
          <>
            <Button size="sm" icon={<FileText className="size-3.5" />} onClick={() => setImportOpen(true)}>
              {t('env.import.button')}
            </Button>
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setDraft(emptyDraft())}>
              {t('env.editor.add')}
            </Button>
          </>
        }
      />
      {query.isLoading ? (
        <LoadingState />
      ) : query.error || !query.data ? (
        <ErrorState error={query.error} title={t('env.loadFailed')} onRetry={() => query.refetch()} />
      ) : (
        <>
          {query.data.vars.length === 0 ? (
            <CardBody className="py-6 text-center text-sm text-fg-muted">{t('env.editor.empty')}</CardBody>
          ) : (
            <ul className="divide-y divide-line">
              {query.data.vars.map((v) => (
                <li key={v.name} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{v.name}</code>
                  <span className="max-w-[40%] truncate font-mono text-xs text-fg-muted">{v.secret ? `•••••••• (${t('env.editor.hidden')})` : v.value}</span>
                  {v.target !== 'env' && <Badge tone="blue">{v.target === 'file' ? t('env.editor.fileOnly') : t('env.editor.bothTargets')}</Badge>}
                  {v.proxyHost && (
                    <Badge tone="green" title={t('env.editor.proxyHint', { baseUrl: v.baseUrlEnv ?? defaultBaseUrlEnv(v.name) })}>
                      <ShieldCheck className="size-3" /> {t('env.editor.proxied', { host: v.proxyHost })}
                    </Badge>
                  )}
                  <IconButton label={t('env.editor.edit')} icon={<Pencil className="size-4" />} onClick={() => setDraft(draftOf(v))} />
                  <IconButton label={t('common.remove')} icon={<Trash2 className="size-4" />} onClick={() => remove.mutate(v.name)} disabled={remove.isPending} />
                </li>
              ))}
            </ul>
          )}
          <CardBody className="border-t border-line py-3">
            <Field label={t('env.editor.filePath')} hint={t('env.editor.filePathHint', { default: DEFAULT_ENV_FILE })}>
              <div className="flex gap-2">
                <Input
                  value={filePath ?? query.data.filePath ?? ''}
                  placeholder={DEFAULT_ENV_FILE}
                  onChange={(e) => setFilePath(e.target.value)}
                  className="max-w-xs font-mono"
                />
                <Button size="md" disabled={filePath === null} loading={saveFilePath.isPending} onClick={() => saveFilePath.mutate(filePath ?? '')}>
                  {t('common.save')}
                </Button>
              </div>
            </Field>
          </CardBody>
        </>
      )}
      {draft && <VarDialog scope={scope} draft={draft} onClose={() => setDraft(null)} />}
      {importOpen && <ImportDialog scope={scope} onClose={() => setImportOpen(false)} />}
    </Card>
  );
}

function VarDialog({ scope, draft: initial, onClose }: { scope: EnvScopeRef; draft: Draft; onClose: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const proxied = draft.proxyHost.trim() !== '';
  const nameOk = ENV_NAME.test(draft.name) && (!proxied || /^[A-Z][A-Z0-9_]*$/.test(draft.name));
  const valueOk = draft.existing || draft.value !== '';

  const save = useAction(
    () =>
      rpc('env.set', {
        ...scope,
        vars: [
          {
            name: draft.name,
            value: draft.value === '' && draft.existing ? undefined : draft.value,
            target: draft.target,
            secret: proxied ? true : draft.secret,
            proxyHost: proxied ? draft.proxyHost.trim() : null,
          },
        ],
      }),
    { success: t('env.editor.saved', { name: draft.name }), error: t('env.editor.saveFailed'), invalidate: [qk.envAll], onSuccess: onClose },
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={draft.existing ? t('env.editor.edit') : t('env.editor.add')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!nameOk || !valueOk} loading={save.isPending} onClick={() => save.mutate()}>
            {t('env.editor.save')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (nameOk && valueOk) save.mutate();
        }}
      >
        <Field label={t('env.editor.name')}>
          <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={draft.existing} placeholder="STRIPE_API_KEY" className="font-mono" invalid={draft.name !== '' && !nameOk} />
        </Field>
        <Field label={t('env.editor.value')} hint={draft.secret || proxied ? t('env.editor.valueHint') : undefined}>
          {draft.secret || proxied ? (
            <SecretInput value={draft.value} onChange={(e) => set({ value: e.target.value })} placeholder={draft.existing ? t('env.editor.valueKeep') : undefined} />
          ) : (
            <Input value={draft.value} onChange={(e) => set({ value: e.target.value })} placeholder={draft.existing ? t('env.editor.valueKeep') : undefined} className="font-mono" />
          )}
        </Field>
        <Field label={t('env.editor.target')} hint={t('env.editor.targetHint')}>
          <Select value={draft.target} onChange={(e) => set({ target: e.target.value as EnvTarget })}>
            <option value="env">{t('env.editor.target.env')}</option>
            <option value="file">{t('env.editor.target.file')}</option>
            <option value="both">{t('env.editor.target.both')}</option>
          </Select>
        </Field>
        <Field label={t('env.editor.proxy')} optional hint={proxied ? t('env.editor.proxyHint', { baseUrl: defaultBaseUrlEnv(draft.name || 'NAME') }) : undefined}>
          <Input value={draft.proxyHost} onChange={(e) => set({ proxyHost: e.target.value })} placeholder={t('env.editor.proxyPlaceholder')} className="font-mono" />
        </Field>
        <Checkbox checked={proxied ? true : draft.secret} disabled={proxied} onChange={(v) => set({ secret: v })} label={t('env.editor.secret')} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function ImportDialog({ scope, onClose }: { scope: EnvScopeRef; onClose: () => void }) {
  const t = useT();
  const [content, setContent] = useState('');
  const [target, setTarget] = useState<EnvTarget>('env');
  const [replace, setReplace] = useState(false);
  const run = useAction(() => rpc('env.import', { ...scope, content, target, replace }), {
    success: (res) => [t('env.import.done', { count: res.imported.length }), res.errors.length ? t('env.import.errors', { count: res.errors.length, line: res.errors[0]?.line || 1 }) : ''].filter(Boolean).join(' · '),
    error: t('env.import.failed'),
    invalidate: [qk.envAll],
    onSuccess: onClose,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('env.import.title')}
      description={t('env.import.description')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!content.trim()} loading={run.isPending} onClick={() => run.mutate()}>
            {t('env.import.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('env.import.content')}>
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={10} spellCheck={false} autoComplete="off" className="font-mono" placeholder={'DATABASE_URL=postgres://…\nSENTRY_DSN=…'} />
        </Field>
        <Field label={t('env.editor.target')}>
          <Select value={target} onChange={(e) => setTarget(e.target.value as EnvTarget)}>
            <option value="env">{t('env.editor.target.env')}</option>
            <option value="file">{t('env.editor.target.file')}</option>
            <option value="both">{t('env.editor.target.both')}</option>
          </Select>
        </Field>
        <Checkbox checked={replace} onChange={setReplace} label={t('env.import.replace')} />
      </div>
    </Dialog>
  );
}
