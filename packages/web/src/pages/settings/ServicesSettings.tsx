import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { localize, SERVICE_IDLE_MINUTES, SERVICE_KINDS, type ServiceInfo, type ServiceKind, type ServiceKindInfo } from '@cocoon/protocol';
import { Check, Database, ExternalLink, FlaskConical, KeyRound, Mail, Play, Plus, Server, Square, Trash2, Zap } from 'lucide-react';
import { qk } from '../../api/keys';
import { useServices } from '../../api/queries';
import { describeError, rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { CodeBlock } from '../../components/CodeBlock';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { Checkbox, ChoiceCard, Field, Input, Select, Toggle } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { SecretInput } from '../../components/SecretInput';
import { SecretValue, ServiceStatusBadge } from '../../components/ServiceBits';
import { ErrorState, LoadingState, Spinner } from '../../components/States';
import { useToast } from '../../components/Toast';
import { rich, useLanguage, useT } from '../../i18n';
import { useBackend } from '../../lib/backend';
import { serviceLabel } from '../../lib/services';

const KINDS = Object.keys(SERVICE_KINDS) as ServiceKind[];
const CATEGORIES: Array<ServiceKindInfo['category']> = ['database', 'mock'];

/** Whether CoCoon can run containers for managed services (not with bubblewrap). */
function useManagedSupported() {
  const backend = useBackend();
  return { supported: backend.kind !== 'bwrap' && backend.capabilities.images !== false, name: backend.name ?? '' };
}

export function ServicesSettings() {
  const t = useT();
  const services = useServices();
  const [adding, setAdding] = useState<ServiceKind | null>(null);

  if (services.isLoading) return <LoadingState />;
  if (services.error) return <ErrorState error={services.error} onRetry={() => services.refetch()} />;
  const list = services.data ?? [];

  return (
    <div className="space-y-6">
      <Callout tone="info" title={t('services.introTitle')}>
        <p>{t('services.intro')}</p>
        <p className="mt-1.5">{t('services.introAgents')}</p>
      </Callout>

      <Card>
        <CardHeader icon={<Server className="size-4.5" />} title={t('services.listTitle')} description={t('services.listDescription')} />
        {list.length === 0 ? (
          <CardBody className="py-8 text-center text-sm text-fg-muted">{t('services.empty')}</CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((s) => (
              <ServiceRow key={s.id} service={s} all={list} />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader icon={<Plus className="size-4.5" />} title={t('services.catalogTitle')} description={t('services.catalogDescription')} />
        <CardBody className="space-y-5">
          {CATEGORIES.map((cat) => (
            <section key={cat}>
              <h3 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-fg">
                {cat === 'database' ? <Database className="size-4 text-fg-muted" /> : <FlaskConical className="size-4 text-fg-muted" />}
                {t(`services.category.${cat}`)}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {KINDS.filter((k) => SERVICE_KINDS[k].category === cat).map((k) => (
                  <CatalogCard key={k} kind={k} added={list.some((s) => s.kind === k)} onAdd={() => setAdding(k)} />
                ))}
              </div>
            </section>
          ))}
        </CardBody>
      </Card>

      {adding && <AddServiceDialog kind={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

function CatalogCard({ kind, added, onAdd }: { kind: ServiceKind; added: boolean; onAdd: () => void }) {
  const t = useT();
  const { lang } = useLanguage();
  const info = SERVICE_KINDS[kind];
  const managed = useManagedSupported();
  const unavailable = info.category === 'mock' && !managed.supported;
  return (
    <div className="flex flex-col rounded-xl border border-line bg-surface-2/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{info.label}</span>
        {added && (
          <Badge tone="green">
            <Check className="size-3" /> {t('services.added')}
          </Badge>
        )}
      </div>
      <p className="mt-1 flex-1 text-sm leading-relaxed text-fg-muted">{localize(info.description, lang)}</p>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant={added ? 'secondary' : 'primary'} icon={<Plus className="size-3.5" />} onClick={onAdd} disabled={unavailable}>
          {added ? t('services.addAnother') : t('common.add')}
        </Button>
        {unavailable && <span className="text-xs text-fg-subtle">{t('services.mockNeedsContainers')}</span>}
      </div>
    </div>
  );
}

function ServiceRow({ service: s, all }: { service: ServiceInfo; all: ServiceInfo[] }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const info = SERVICE_KINDS[s.kind];
  const name = serviceLabel(s, all);
  const [credsOpen, setCredsOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const setCache = (next: ServiceInfo) => qc.setQueryData<ServiceInfo[]>(qk.services, (old) => old?.map((x) => (x.id === next.id ? next : x)));

  const update = useAction((attach: 'all' | 'manual') => rpc('services.update', { serviceId: s.id, attach }), {
    success: (_, attach) => (attach === 'all' ? t('services.autoAttachOn') : t('services.autoAttachOff')),
    error: t('services.updateFailed'),
    onSuccess: setCache,
  });
  const updateAutoStop = useAction((autoStop: boolean) => rpc('services.update', { serviceId: s.id, autoStop }), {
    success: (_, autoStop) => (autoStop ? t('services.autoStopOn') : t('services.autoStopOff')),
    error: t('services.updateFailed'),
    onSuccess: setCache,
  });
  const start = useAction(() => rpc('services.start', { serviceId: s.id }), { success: t('services.started'), error: t('services.startFailed'), onSuccess: setCache });
  const stop = useAction(() => rpc('services.stop', { serviceId: s.id }), { success: t('services.stopped'), error: t('services.stopFailed'), onSuccess: setCache });
  const test = useAction(() => rpc('services.test', { serviceId: s.id }), {
    error: t('services.testFailed'),
    invalidate: [qk.services],
    onSuccess: (r) => {
      if (r.ok) toast.success(r.version ? t('services.testOkVersion', { version: r.version }) : t('services.testOk'));
      else toast.error(t('services.testFailed'), r.error);
    },
  });
  const remove = useAction(() => rpc('services.remove', { serviceId: s.id, deleteData: s.mode === 'managed' && deleteData }), {
    success: t('services.remove.success'),
    error: t('services.remove.failed'),
    invalidate: [qk.services, qk.serviceConnectionsAll, qk.sandboxes],
    onSuccess: () => setRemoveOpen(false),
  });

  const busy = s.status === 'starting' || s.status === 'pulling';
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        {info.category === 'database' ? <Database className="mt-0.5 size-4 text-fg-subtle" /> : <FlaskConical className="mt-0.5 size-4 text-fg-subtle" />}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{name}</span>
            <ServiceStatusBadge status={s.status} />
            <Badge tone="gray">{t(`services.mode.${s.mode}`)}</Badge>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-muted">
            {s.version && <span>{t('services.version', { version: s.version })}</span>}
            {s.mode === 'external' && s.host && (
              <span className="font-mono">
                {s.host}:{s.port ?? info.port}
              </span>
            )}
            <span>{t('services.sandboxCount', { count: s.sandboxes.length })}</span>
          </div>
          {s.error && (s.status === 'error' || s.status === 'unsupported') && (
            <p className="text-xs break-words text-red-600 dark:text-red-400">{s.error}</p>
          )}
          <div className="pt-1">
            <Toggle
              checked={s.attach === 'all'}
              onChange={(v) => update.mutate(v ? 'all' : 'manual')}
              disabled={update.isPending}
              label={t('services.autoAttach')}
              description={t('services.autoAttachHint')}
            />
          </div>
          {s.mode === 'managed' && (
            <div className="pt-1">
              <Toggle
                checked={s.autoStop !== false}
                onChange={(v) => updateAutoStop.mutate(v)}
                disabled={updateAutoStop.isPending}
                label={t('services.autoStop')}
                description={t('services.autoStopHint', { minutes: SERVICE_IDLE_MINUTES })}
              />
            </div>
          )}
        </div>
        <div className="flex basis-full flex-wrap items-center gap-1.5 pl-7">
          {s.mode === 'managed' && s.status === 'idle' && (
            <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} loading={start.isPending} onClick={() => start.mutate()}>
              {t('services.start')}
            </Button>
          )}
          {s.mode === 'managed' &&
            (s.status === 'running' || s.status === 'idle' || busy ? (
              <Button size="sm" icon={<Square className="size-3.5" />} loading={stop.isPending} onClick={() => stop.mutate()}>
                {t('services.stop')}
              </Button>
            ) : s.status !== 'unsupported' ? (
              <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} loading={start.isPending} onClick={() => start.mutate()}>
                {t('services.start')}
              </Button>
            ) : null)}
          <Button size="sm" icon={<Zap className="size-3.5" />} loading={test.isPending} onClick={() => test.mutate()} disabled={busy}>
            {t('services.test')}
          </Button>
          {info.category === 'database' && (
            <Button size="sm" icon={<KeyRound className="size-3.5" />} onClick={() => setCredsOpen(true)} disabled={s.status !== 'running'}>
              {t('services.credentials')}
            </Button>
          )}
          {s.webUrl && (
            <a
              href={s.webUrl}
              target="_blank"
              rel="noreferrer"
              title={t('services.webHint')}
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-fg ring-1 ring-line-strong ring-inset hover:bg-surface-2"
            >
              {s.kind === 'mailpit' ? <Mail className="size-3.5" /> : <ExternalLink className="size-3.5" />}
              {s.kind === 'mailpit' ? t('services.openMailbox') : t('services.openWeb')}
            </a>
          )}
          <IconButton
            label={t('common.remove')}
            icon={<Trash2 className="size-4" />}
            onClick={() => {
              setDeleteData(false);
              setRemoveOpen(true);
            }}
          />
        </div>
      </div>

      {credsOpen && <CredentialsDialog service={s} name={name} onClose={() => setCredsOpen(false)} />}

      <ConfirmDialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        danger
        title={t('services.remove.title')}
        confirmLabel={t('common.remove')}
        message={
          <div className="space-y-3">
            <p>{rich(t('services.remove.text'), { name: <strong className="text-fg">{name}</strong> })}</p>
            {s.mode === 'managed' && (
              <Checkbox checked={deleteData} onChange={setDeleteData} label={t('services.remove.deleteData')} description={t('services.remove.deleteDataHint')} />
            )}
          </div>
        }
      />
    </li>
  );
}

function CredentialsDialog({ service, name, onClose }: { service: ServiceInfo; name: string; onClose: () => void }) {
  const t = useT();
  const creds = useQuery({
    queryKey: qk.serviceCredentials(service.id),
    queryFn: () => rpc('services.credentials', { serviceId: service.id }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const c = creds.data;
  return (
    <Dialog open onClose={onClose} title={t('services.cred.title', { name })} description={t('services.cred.description')} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      {creds.isLoading ? (
        <LoadingState />
      ) : creds.error || !c ? (
        <ErrorState error={creds.error} onRetry={() => creds.refetch()} />
      ) : (
        <div className="space-y-3">
          <Field label={t('services.cred.url')}>
            <SecretValue value={c.url} secret={c.password} />
          </Field>
          <Field label={t('services.cred.host')}>
            <SecretValue value={`${c.host}:${c.port}`} />
          </Field>
          {c.user && (
            <Field label={t('services.cred.user')}>
              <SecretValue value={c.user} />
            </Field>
          )}
          {c.password && (
            <Field label={t('services.cred.password')}>
              <SecretValue value={c.password} mask />
            </Field>
          )}
          <Callout tone="warning">{t('services.cred.serverOnly')}</Callout>
          <CodeBlock title={t('services.cred.tunnel')} code={`ssh -N -L ${c.port}:127.0.0.1:${c.port} <user>@<cocoon-server>`} />
        </div>
      )}
    </Dialog>
  );
}

function AddServiceDialog({ kind, onClose }: { kind: ServiceKind; onClose: () => void }) {
  const t = useT();
  const { lang } = useLanguage();
  const toast = useToast();
  const qc = useQueryClient();
  const info = SERVICE_KINDS[kind];
  const managedInfo = useManagedSupported();
  const canExternal = info.category === 'database';
  const [mode, setMode] = useState<'managed' | 'external'>(managedInfo.supported || !canExternal ? 'managed' : 'external');
  const [image, setImage] = useState(info.images[0]?.ref ?? '');
  const [attachAll, setAttachAll] = useState(true);
  const [attachExisting, setAttachExisting] = useState(true);
  const [autoStop, setAutoStop] = useState(true);
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState(String(info.port));
  const [adminUser, setAdminUser] = useState(info.defaultAdminUser ?? '');
  const [adminPassword, setAdminPassword] = useState('');
  const [tls, setTls] = useState(false);
  const [touched, setTouched] = useState(false);

  // Once system.info has loaded, switch away from an impossible mode.
  useEffect(() => {
    if (!managedInfo.supported && canExternal) setMode('external');
  }, [managedInfo.supported, canExternal]);

  const add = useMutation({
    mutationFn: () =>
      rpc('services.add', {
        kind,
        mode,
        attach: attachAll ? 'all' : 'manual',
        attachExisting: attachAll && attachExisting,
        ...(mode === 'managed'
          ? { image: image || undefined, autoStop }
          : {
              host: host.trim(),
              port: Number(port) || info.port,
              adminUser: info.externalAuth ? adminUser.trim() || undefined : undefined,
              adminPassword: info.externalAuth ? adminPassword || undefined : undefined,
              tls,
            }),
      }),
    onSuccess: (s) => {
      qc.setQueryData<ServiceInfo[]>(qk.services, (old) => (old ? [...old.filter((x) => x.id !== s.id), s] : old));
      void qc.invalidateQueries({ queryKey: qk.services });
      void qc.invalidateQueries({ queryKey: qk.sandboxes });
      toast.success(mode === 'managed' ? t('services.add.successManaged', { name: info.label }) : t('services.add.success', { name: info.label }));
      onClose();
    },
  });

  const hostError = touched && mode === 'external' && !host.trim() ? t('services.add.hostRequired') : undefined;
  const impossible = mode === 'managed' && !managedInfo.supported;
  const submit = () => {
    setTouched(true);
    if (mode === 'external' && !host.trim()) return;
    add.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={!add.isPending}
      title={t('services.add.title', { name: info.label })}
      description={localize(info.description, lang)}
      footer={
        <>
          <Button onClick={onClose} disabled={add.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={submit} loading={add.isPending} disabled={impossible}>
            {t('services.add.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {canExternal ? (
          <div className="space-y-2.5">
            <div className="text-sm font-medium text-fg">{t('services.add.how')}</div>
            <ChoiceCard
              selected={mode === 'managed'}
              onSelect={() => setMode('managed')}
              disabled={!managedInfo.supported}
              icon={<Server className="size-5" />}
              title={t('services.add.managed')}
              description={managedInfo.supported ? t('services.add.managedText') : t('services.add.managedUnavailable', { name: managedInfo.name })}
            />
            <ChoiceCard
              selected={mode === 'external'}
              onSelect={() => setMode('external')}
              icon={<Database className="size-5" />}
              title={t('services.add.external')}
              description={t('services.add.externalText')}
            />
          </div>
        ) : (
          !managedInfo.supported && <Callout tone="warning">{t('services.add.managedUnavailableMock', { name: managedInfo.name })}</Callout>
        )}

        {mode === 'managed' && managedInfo.supported && info.images.length > 1 && (
          <Field label={t('services.add.version')} htmlFor="svc-image">
            <Select id="svc-image" value={image} onChange={(e) => setImage(e.target.value)}>
              {info.images.map((img, i) => (
                <option key={img.ref} value={img.ref}>
                  {img.label}
                  {i === 0 ? ` (${t('common.default')})` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {mode === 'external' && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <Field label={t('services.add.host')} htmlFor="svc-host" hint={t('services.add.hostHint')} error={hostError}>
                <Input id="svc-host" value={host} invalid={!!hostError} onChange={(e) => setHost(e.target.value)} placeholder="localhost" />
              </Field>
              <Field label={t('services.add.port')} htmlFor="svc-port">
                <Input id="svc-port" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
              </Field>
            </div>
            {info.externalAuth && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('services.add.adminUser')} htmlFor="svc-user">
                    <Input id="svc-user" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} autoComplete="off" />
                  </Field>
                  <Field label={t('services.add.adminPassword')} htmlFor="svc-pass">
                    <SecretInput id="svc-pass" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
                  </Field>
                </div>
                <p className="-mt-2 text-xs leading-relaxed text-fg-muted">{t('services.add.adminHint')}</p>
              </>
            )}
            <Checkbox checked={tls} onChange={setTls} label={t('services.add.tls')} />
          </div>
        )}

        {!impossible && (
          <div className="space-y-3 rounded-xl border border-line px-4 py-3">
            <Toggle checked={attachAll} onChange={setAttachAll} label={t('services.add.attachAll')} description={t('services.add.attachAllHint')} />
            {attachAll && (
              <Toggle
                checked={attachExisting}
                onChange={setAttachExisting}
                label={t('services.add.attachExisting')}
                description={t('services.add.attachExistingHint')}
              />
            )}
            {mode === 'managed' && (
              <Toggle
                checked={autoStop}
                onChange={setAutoStop}
                label={t('services.autoStop')}
                description={t('services.autoStopHint', { minutes: SERVICE_IDLE_MINUTES })}
              />
            )}
          </div>
        )}

        {add.isPending && mode === 'external' && (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <Spinner /> {t('services.add.testing')}
          </p>
        )}
        {add.error && (
          <Callout tone="danger" title={t('services.add.failed')}>
            {describeError(add.error)}
          </Callout>
        )}
      </div>
    </Dialog>
  );
}
