import { useState } from 'react';
import type { PortMode, Sandbox, SandboxPort } from '@cocoon/protocol';
import { ExternalLink, Globe, Network, Plus, X } from 'lucide-react';
import { qk } from '../../api/keys';
import { useSandboxPorts, useSystemInfo } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { CopyButton } from '../../components/CodeBlock';
import { ConfirmDialog } from '../../components/Dialog';
import { Input } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { ErrorState, LoadingState } from '../../components/States';
import { rich, useT } from '../../i18n';

/** Ports that can be reached from outside the sandbox (listening on all addresses) or that were opened. */
export function visiblePorts(ports: SandboxPort[] | undefined): SandboxPort[] {
  return (ports ?? []).filter((p) => p.opened || p.address === 'all');
}

export function PortsTab({ sandbox: s }: { sandbox: Sandbox }) {
  const t = useT();
  const info = useSystemInfo();
  const enabled = info.data?.ports?.enabled ?? false;
  const shareAllowed = info.data?.ports?.share ?? false;
  const ports = useSandboxPorts(s.id, enabled);
  const [manual, setManual] = useState('');
  const [confirmShare, setConfirmShare] = useState<number | null>(null);

  const invalidate = [qk.ports(s.id)];
  const open = useAction((v: { port: number; mode: PortMode }) => rpc('ports.open', { sandboxId: s.id, ...v }), {
    success: (_r, v) => (v.mode === 'shared' ? t('ports.shared', { port: v.port }) : undefined),
    error: t('ports.openFailed'),
    invalidate,
    onSuccess: () => {
      setManual('');
      setConfirmShare(null);
    },
  });
  const close = useAction((port: number) => rpc('ports.close', { sandboxId: s.id, port }), {
    success: (_r, port) => t('ports.closed', { port }),
    error: t('ports.closeFailed'),
    invalidate,
  });
  const preview = useAction(
    // The window is opened synchronously in the click handler (popup blockers), then pointed to the one-time link.
    async (v: { port: number; win: Window | null }) => {
      try {
        const list = ports.data ?? [];
        if (!list.find((p) => p.port === v.port)?.opened) await rpc('ports.open', { sandboxId: s.id, port: v.port, mode: 'preview' });
        const { url } = await rpc('ports.preview_link', { sandboxId: s.id, port: v.port, origin: window.location.origin });
        if (v.win) v.win.location.href = url;
        else window.open(url, '_blank', 'noopener');
        return url;
      } catch (err) {
        v.win?.close();
        throw err;
      }
    },
    { error: t('ports.previewFailed'), invalidate, onSuccess: () => undefined },
  );
  const openPreview = (port: number) => preview.mutate({ port, win: window.open('about:blank', '_blank') });

  if (!info.data) return <LoadingState />;
  if (!enabled) return <Callout tone="warning">{t('ports.unavailable', { name: info.data.driver })}</Callout>;
  if (s.network === 'none') return <Callout tone="warning">{t('ports.noNetwork')}</Callout>;
  if (ports.error) return <ErrorState error={ports.error} onRetry={() => ports.refetch()} />;
  if (!ports.data) return <LoadingState />;

  const shown = visiblePorts(ports.data);
  const internal = ports.data.filter((p) => !p.opened && p.address === 'loopback');
  const code = (c: string) => <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-fg">{c}</code>;
  const manualPort = Number(manual);
  const manualValid = Number.isInteger(manualPort) && manualPort >= 1 && manualPort <= 65535;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader icon={<Network className="size-5" />} title={t('ports.title')} description={t('ports.description')} />
        <CardBody className="space-y-4">
          {shown.length === 0 ? (
            <p className="text-sm text-fg-muted">{rich(t('ports.empty'), { host: code('--host 0.0.0.0') })}</p>
          ) : (
            <ul className="divide-y divide-line">
              {shown.map((p) => (
                <PortRow
                  key={p.port}
                  port={p}
                  shareAllowed={shareAllowed}
                  busy={open.isPending || close.isPending || preview.isPending}
                  onPreview={() => openPreview(p.port)}
                  onShare={() => setConfirmShare(p.port)}
                  onUnshare={() => open.mutate({ port: p.port, mode: 'preview' })}
                  onClose={() => close.mutate(p.port)}
                />
              ))}
            </ul>
          )}
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (manualValid) open.mutate({ port: manualPort, mode: 'preview' });
            }}
          >
            <div className="w-28">
              <Input value={manual} onChange={(e) => setManual(e.target.value.replace(/\D/g, ''))} placeholder="5173" className="font-mono" inputMode="numeric" aria-label={t('ports.openManual')} />
            </div>
            <Button type="submit" size="sm" icon={<Plus className="size-3.5" />} disabled={!manualValid} loading={open.isPending && open.variables?.port === manualPort}>
              {t('ports.openManual')}
            </Button>
            <span className="text-xs text-fg-subtle">{t('ports.openManualHint')}</span>
          </form>
        </CardBody>
      </Card>

      {internal.length > 0 && (
        <Callout tone="info" title={t('ports.internalTitle')}>
          <p>{rich(t('ports.internalText'), { host: code('--host 0.0.0.0') })}</p>
          <p className="mt-1 font-mono text-xs">{internal.map((p) => p.port).join(', ')}</p>
        </Callout>
      )}

      <ConfirmDialog
        open={confirmShare !== null}
        onClose={() => setConfirmShare(null)}
        onConfirm={() => confirmShare !== null && open.mutate({ port: confirmShare, mode: 'shared' })}
        loading={open.isPending}
        title={t('ports.shareTitle', { port: confirmShare ?? '' })}
        message={t('ports.shareMessage')}
        confirmLabel={t('ports.shareConfirm')}
        danger
      />
    </div>
  );
}

function PortRow({
  port: p,
  shareAllowed,
  busy,
  onPreview,
  onShare,
  onUnshare,
  onClose,
}: {
  port: SandboxPort;
  shareAllowed: boolean;
  busy: boolean;
  onPreview: () => void;
  onShare: () => void;
  onUnshare: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const shared = p.opened?.mode === 'shared';
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-fg">{p.port}</span>
          {p.opened?.name && <span className="text-sm text-fg-muted">{p.opened.name}</span>}
          {p.listening ? <Badge tone="green">{t('ports.listening')}</Badge> : <Badge tone="gray">{t('ports.notListening')}</Badge>}
          {p.opened && (shared ? <Badge tone="amber">{t('ports.modeShared')}</Badge> : <Badge tone="accent">{t('ports.modePreview')}</Badge>)}
          {p.address === 'loopback' && <Badge tone="amber">{t('ports.loopbackOnly')}</Badge>}
        </div>
        {shared && p.opened?.url && (
          <div className="mt-1 flex items-center gap-2 font-mono text-xs text-fg-muted">
            {p.opened.url}
            <CopyButton text={p.opened.url} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={onPreview} disabled={busy}>
          {t('ports.openPreview')}
        </Button>
        {shareAllowed &&
          (shared ? (
            <Button size="sm" onClick={onUnshare} disabled={busy}>
              {t('ports.unshare')}
            </Button>
          ) : (
            <Button size="sm" icon={<Globe className="size-3.5" />} onClick={onShare} disabled={busy}>
              {t('ports.share')}
            </Button>
          ))}
        {p.opened && (
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={onClose} disabled={busy}>
            {t('ports.close')}
          </Button>
        )}
      </div>
    </li>
  );
}
