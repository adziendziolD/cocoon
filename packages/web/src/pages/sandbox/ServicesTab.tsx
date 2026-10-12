import { useState } from 'react';
import { SERVICE_KINDS, type Sandbox, type ServiceConnection, type ServiceInfo } from '@cocoon/protocol';
import { Database, Eraser, FlaskConical, Plus, RefreshCw, Settings, Unplug } from 'lucide-react';
import { qk } from '../../api/keys';
import { useServiceConnections, useServices } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Button, ButtonLink } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ConfirmDialog } from '../../components/Dialog';
import { Select } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { SecretValue, ServiceStatusBadge } from '../../components/ServiceBits';
import { ErrorState, LoadingState } from '../../components/States';
import { rich, useT } from '../../i18n';
import { serviceLabel } from '../../lib/services';

export function ServicesTab({ sandbox: s }: { sandbox: Sandbox }) {
  const t = useT();
  const services = useServices();
  const noNetwork = s.network === 'none';
  const connections = useServiceConnections(s.id);
  const [toAdd, setToAdd] = useState('');
  const [confirm, setConfirm] = useState<{ kind: 'reset' | 'detach'; conn: ServiceConnection } | null>(null);

  const invalidate = [qk.serviceConnections(s.id), qk.sandbox(s.id), qk.services];
  const attach = useAction((serviceId: string) => rpc('services.attach', { sandboxId: s.id, serviceId }), {
    success: (c) => t('sandboxServices.attached', { name: c.label }),
    error: t('sandboxServices.attachFailed'),
    invalidate,
    onSuccess: () => setToAdd(''),
  });
  const reset = useAction((c: ServiceConnection) => rpc('services.reset', { sandboxId: s.id, serviceId: c.serviceId }), {
    success: (_, c) => t('sandboxServices.resetDone', { name: c.label }),
    error: t('sandboxServices.resetFailed'),
    invalidate,
    onSuccess: () => setConfirm(null),
  });
  const detach = useAction((c: ServiceConnection) => rpc('services.detach', { sandboxId: s.id, serviceId: c.serviceId }), {
    success: (_, c) => t('sandboxServices.detached', { name: c.label }),
    error: t('sandboxServices.detachFailed'),
    invalidate,
    onSuccess: () => setConfirm(null),
  });

  if (services.isLoading || connections.isLoading) return <LoadingState />;
  if (services.error) return <ErrorState error={services.error} onRetry={() => services.refetch()} />;
  if (connections.error) return <ErrorState error={connections.error} onRetry={() => connections.refetch()} />;

  const all = services.data ?? [];
  const conns = connections.data ?? [];
  const attachedIds = new Set([...conns.map((c) => c.serviceId), ...s.services]);
  const available = all.filter((x) => !attachedIds.has(x.id));
  const byId = new Map(all.map((x) => [x.id, x]));

  return (
    <div className="space-y-5">
      {noNetwork && (
        <Callout tone="warning" title={t('sandboxServices.noNetwork')} />
      )}

      <Card>
        <CardHeader
          icon={<Database className="size-4.5" />}
          title={t('sandboxServices.title')}
          description={t('sandboxServices.description')}
          actions={
            <ButtonLink to="/settings/services" size="sm" icon={<Settings className="size-3.5" />}>
              {t('sandboxServices.toSettings')}
            </ButtonLink>
          }
        />
        {all.length === 0 ? (
          <CardBody className="py-8 text-center text-sm text-fg-muted">{t('sandboxServices.noServices')}</CardBody>
        ) : (
          <>
            {conns.length === 0 ? (
              <CardBody className="py-6 text-center text-sm text-fg-muted">{t('sandboxServices.empty')}</CardBody>
            ) : (
              <ul className="divide-y divide-line">
                {conns.map((c) => (
                  <ConnectionRow
                    key={c.serviceId}
                    conn={c}
                    service={byId.get(c.serviceId)}
                    all={all}
                    disabled={noNetwork}
                    retrying={attach.isPending && attach.variables === c.serviceId}
                    onRetry={() => attach.mutate(c.serviceId)}
                    onReset={() => setConfirm({ kind: 'reset', conn: c })}
                    onDetach={() => setConfirm({ kind: 'detach', conn: c })}
                  />
                ))}
              </ul>
            )}
            {available.length > 0 && (
              <CardBody className="flex flex-wrap items-center gap-2 border-t border-line">
                <span className="text-sm font-medium text-fg">{t('sandboxServices.addLabel')}</span>
                <Select value={toAdd} onChange={(e) => setToAdd(e.target.value)} disabled={noNetwork} className="w-auto min-w-56">
                  <option value="">{t('sandboxServices.addPlaceholder')}</option>
                  {available.map((x) => (
                    <option key={x.id} value={x.id}>
                      {serviceLabel(x, all)}
                    </option>
                  ))}
                </Select>
                <Button
                  size="md"
                  variant="primary"
                  icon={<Plus className="size-4" />}
                  disabled={!toAdd || noNetwork}
                  loading={attach.isPending && attach.variables === toAdd}
                  onClick={() => attach.mutate(toAdd)}
                >
                  {t('common.add')}
                </Button>
              </CardBody>
            )}
          </>
        )}
      </Card>

      {all.length > 0 && <p className="text-xs text-fg-muted">{t('sandboxServices.restartNote')}</p>}

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && (confirm.kind === 'reset' ? reset.mutate(confirm.conn) : detach.mutate(confirm.conn))}
        loading={reset.isPending || detach.isPending}
        danger
        title={confirm?.kind === 'reset' ? t('sandboxServices.resetTitle') : t('sandboxServices.detachTitle')}
        confirmLabel={confirm?.kind === 'reset' ? t('sandboxServices.reset') : t('sandboxServices.detach')}
        message={rich(confirm?.kind === 'reset' ? t('sandboxServices.resetText') : t('sandboxServices.detachText'), {
          name: <strong className="text-fg">{confirm?.conn.label}</strong>,
        })}
      />
    </div>
  );
}

function ConnectionRow({
  conn: c,
  service,
  all,
  disabled,
  retrying,
  onRetry,
  onReset,
  onDetach,
}: {
  conn: ServiceConnection;
  service: ServiceInfo | undefined;
  all: ServiceInfo[];
  disabled: boolean;
  retrying: boolean;
  onRetry: () => void;
  onReset: () => void;
  onDetach: () => void;
}) {
  const t = useT();
  const info = SERVICE_KINDS[c.kind];
  const envNames = Object.keys(c.env).sort();
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        {info.category === 'database' ? <Database className="mt-0.5 size-4 text-fg-subtle" /> : <FlaskConical className="mt-0.5 size-4 text-fg-subtle" />}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{service ? serviceLabel(service, all) : c.label}</span>
            {service && service.status !== 'running' && <ServiceStatusBadge status={service.status} />}
          </div>
          {c.error ? (
            <Callout
              tone="danger"
              title={t('sandboxServices.provisionFailed')}
              action={
                <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={retrying} disabled={disabled} onClick={onRetry}>
                  {t('common.retry')}
                </Button>
              }
            >
              {c.error}
            </Callout>
          ) : (
            <>
              <div>
                <div className="mb-1 text-xs text-fg-subtle">{t('sandboxServices.url')}</div>
                <SecretValue value={c.url} secret={c.password} />
              </div>
              {(c.database || c.user) && (
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-fg-muted">
                  {c.database && (
                    <span>
                      {t('sandboxServices.database')}: <span className="font-mono text-fg">{c.database}</span>
                    </span>
                  )}
                  {c.user && (
                    <span>
                      {t('sandboxServices.user')}: <span className="font-mono text-fg">{c.user}</span>
                    </span>
                  )}
                </div>
              )}
            </>
          )}
          {envNames.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-fg-subtle">{t('sandboxServices.env')}</div>
              <div className="flex flex-wrap gap-1">
                {envNames.map((n) => (
                  <span key={n} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
                    {n}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex basis-full flex-wrap gap-1.5 pl-7">
          {info.isolation !== 'shared' && !c.error && (
            <Button size="sm" icon={<Eraser className="size-3.5" />} onClick={onReset} disabled={disabled}>
              {t('sandboxServices.reset')}
            </Button>
          )}
          <Button size="sm" icon={<Unplug className="size-3.5" />} onClick={onDetach}>
            {t('sandboxServices.detach')}
          </Button>
        </div>
      </div>
    </li>
  );
}
