import { useState } from 'react';
import type { DeniedConnection, Settings } from '@cocoon/protocol';
import { Ban, Check, Plus, RefreshCw, RotateCcw, X } from 'lucide-react';
import { useDenied, useSandboxes, useSettings } from '../../api/queries';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ConfirmDialog } from '../../components/Dialog';
import { Input, Toggle } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { SaveBar } from '../../components/SaveBar';
import { ErrorState, LoadingState } from '../../components/States';
import { rich, useT } from '../../i18n';
import { formatRelative } from '../../lib/format';
import { networkModeMeta } from '../../lib/status';
import { useDraft } from '../../lib/useDraft';
import { useResetSettings, useSaveSettings } from './useSaveSettings';

type Egress = Settings['egress'];
const DOMAIN_RE = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$|^localhost$/i;

/** True if `host` is already covered by an allowlist entry (exact or *.domain). */
function isAllowed(host: string, list: string[]): boolean {
  return list.some((e) => (e.startsWith('*.') ? host === e.slice(2) || host.endsWith(e.slice(1)) : e === host));
}

export function NetworkSettings() {
  const t = useT();
  const settings = useSettings();
  const { draft, setDraft, dirty, reset } = useDraft<Egress>(settings.data?.egress);
  const [input, setInput] = useState('');
  const [privateInput, setPrivateInput] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const save = useSaveSettings(t('network.settings.saved'), (s) => reset(s.egress));
  const allow = useSaveSettings(t('network.settings.allowed'), (s) => !dirty && reset(s.egress));
  const resetSection = useResetSettings((s) => {
    reset(s.egress);
    setConfirmReset(false);
  });

  if (settings.error) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  if (!draft) return <LoadingState />;

  const candidate = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const inputErr = candidate && !DOMAIN_RE.test(candidate) ? t('network.settings.invalidDomain') : undefined;
  const add = () => {
    if (!candidate || inputErr) return;
    if (!draft.allowlist.includes(candidate)) setDraft({ ...draft, allowlist: [...draft.allowlist, candidate] });
    setInput('');
  };

  const allowHost = (host: string) => {
    const server = settings.data?.egress.allowlist ?? [];
    if (dirty) setDraft({ ...draft, allowlist: [...draft.allowlist, host] });
    allow.mutate({ egress: { allowlist: [...server, host] } });
  };

  const allowPrivateHost = (host: string) => {
    const server = settings.data?.egress.allowPrivate ?? [];
    if (dirty) setDraft({ ...draft, allowPrivate: [...draft.allowPrivate, host] });
    allow.mutate({ egress: { allowPrivate: [...server, host] } });
  };

  const privateCandidate = privateInput.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const privateErr = privateCandidate && !DOMAIN_RE.test(privateCandidate) ? t('network.settings.invalidDomain') : undefined;
  const addPrivate = () => {
    if (!privateCandidate || privateErr) return;
    if (!draft.allowPrivate.includes(privateCandidate)) setDraft({ ...draft, allowPrivate: [...draft.allowPrivate, privateCandidate] });
    setPrivateInput('');
  };

  return (
    <div className="space-y-6">
      <Callout tone="info">
        {rich(t('network.settings.intro'), { mode: <strong>{t('network.settings.quoted', { text: networkModeMeta(t, 'egress').short })}</strong> })}
      </Callout>

      <Card>
        <CardHeader
          title={t('network.settings.allowlist.title')}
          description={t('network.settings.allowlist.description')}
          actions={
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setConfirmReset(true)}>
              {t('network.settings.allowlist.resetButton')}
            </Button>
          }
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {draft.allowlist.map((d) => (
              <span key={d} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-1 pr-1 pl-3 font-mono text-xs text-fg">
                {d}
                <button
                  onClick={() => setDraft({ ...draft, allowlist: draft.allowlist.filter((x) => x !== d) })}
                  className="rounded-full p-0.5 text-fg-subtle hover:bg-red-500/10 hover:text-red-600"
                  aria-label={t('network.settings.allowlist.removeAria', { domain: d })}
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
            {draft.allowlist.length === 0 && <span className="text-sm text-fg-muted">{t('network.settings.allowlist.empty')}</span>}
          </div>
          <div>
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
                placeholder={t('network.settings.allowlist.placeholder')}
                className="max-w-md font-mono"
                invalid={!!inputErr}
              />
              <Button icon={<Plus className="size-4" />} onClick={add} disabled={!candidate || !!inputErr}>
                {t('common.add')}
              </Button>
            </div>
            <p className={inputErr ? 'mt-1.5 text-xs text-red-600' : 'mt-1.5 text-xs text-fg-muted'}>
              {inputErr ??
                rich(t('network.settings.allowlist.help'), {
                  exact: <code className="font-mono">example.com</code>,
                  wildcard: <code className="font-mono">*.example.com</code>,
                  sub1: <code className="font-mono">api.example.com</code>,
                  sub2: <code className="font-mono">cdn.example.com</code>,
                })}
            </p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('network.settings.private.title')} description={t('network.settings.private.description')} />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {draft.allowPrivate.map((d) => (
              <span key={d} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-1 pr-1 pl-3 font-mono text-xs text-fg">
                {d}
                <button
                  onClick={() => setDraft({ ...draft, allowPrivate: draft.allowPrivate.filter((x) => x !== d) })}
                  className="rounded-full p-0.5 text-fg-subtle hover:bg-red-500/10 hover:text-red-600"
                  aria-label={t('network.settings.allowlist.removeAria', { domain: d })}
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
            {draft.allowPrivate.length === 0 && <span className="text-sm text-fg-muted">{t('network.settings.private.empty')}</span>}
          </div>
          <div>
            <div className="flex gap-2">
              <Input
                value={privateInput}
                onChange={(e) => setPrivateInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addPrivate())}
                placeholder={t('network.settings.allowlist.placeholder')}
                className="max-w-md font-mono"
                invalid={!!privateErr}
              />
              <Button icon={<Plus className="size-4" />} onClick={addPrivate} disabled={!privateCandidate || !!privateErr}>
                {t('common.add')}
              </Button>
            </div>
            {privateErr && <p className="mt-1.5 text-xs text-red-600">{privateErr}</p>}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('network.settings.proxy.title')} />
        <CardBody>
          <Toggle
            checked={draft.credentialProxy}
            onChange={(v) => setDraft({ ...draft, credentialProxy: v })}
            label={t('network.settings.proxy.label')}
            description={t('network.settings.proxy.description')}
          />
          {!draft.credentialProxy && (
            <Callout tone="warning" className="mt-4">
              {t('network.settings.proxy.offWarning')}
            </Callout>
          )}
        </CardBody>
      </Card>

      <SaveBar visible={dirty} onSave={() => save.mutate({ egress: draft })} onDiscard={() => reset()} saving={save.isPending} />

      <DeniedCard
        allowlist={settings.data?.egress.allowlist ?? []}
        allowPrivate={settings.data?.egress.allowPrivate ?? []}
        onAllow={allowHost}
        onAllowPrivate={allowPrivateHost}
        allowing={allow.isPending}
      />

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => resetSection.mutate('egress')}
        loading={resetSection.isPending}
        title={t('network.settings.reset.title')}
        confirmLabel={t('network.settings.reset.confirm')}
        message={t('network.settings.reset.message')}
      />
    </div>
  );
}

interface DeniedCardProps {
  allowlist: string[];
  allowPrivate: string[];
  onAllow: (host: string) => void;
  onAllowPrivate: (host: string) => void;
  allowing: boolean;
}

function DeniedCard({ allowlist, allowPrivate, onAllow, onAllowPrivate, allowing }: DeniedCardProps) {
  const t = useT();
  const denied = useDenied();
  const sandboxes = useSandboxes();
  const sbName = (id?: string) => (id ? (sandboxes.data?.find((s) => s.id === id)?.name ?? id) : undefined);

  // Group by host, newest first.
  const grouped = new Map<string, { host: string; count: number; last: string; reason?: DeniedConnection['reason']; sandboxes: Set<string> }>();
  for (const d of denied.data ?? []) {
    const g = grouped.get(d.host) ?? { host: d.host, count: 0, last: d.at, reason: d.reason, sandboxes: new Set<string>() };
    g.count++;
    if (d.at > g.last) {
      g.last = d.at;
      g.reason = d.reason;
    }
    const n = sbName(d.sandboxId);
    if (n) g.sandboxes.add(n);
    grouped.set(d.host, g);
  }
  const rows = [...grouped.values()].sort((a, b) => b.last.localeCompare(a.last));

  return (
    <Card>
      <CardHeader
        title={t('network.settings.denied.title')}
        description={t('network.settings.denied.description')}
        actions={
          <Button size="sm" variant="ghost" icon={<RefreshCw className={denied.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />} onClick={() => denied.refetch()}>
            {t('network.settings.denied.refresh')}
          </Button>
        }
      />
      {denied.isLoading ? (
        <LoadingState />
      ) : denied.error ? (
        <ErrorState error={denied.error} className="m-4" onRetry={() => denied.refetch()} />
      ) : rows.length === 0 ? (
        <CardBody className="flex items-center gap-2 text-sm text-fg-muted">
          <Check className="size-4 text-emerald-500" /> {t('network.settings.denied.empty')}
        </CardBody>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => {
            const already = isAllowed(r.host, allowlist);
            return (
              <li key={r.host} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Ban className="size-4 text-red-500" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm text-fg">{r.host}</div>
                  <div className="text-xs text-fg-subtle">
                    {t('network.settings.denied.meta', { count: r.count, time: formatRelative(r.last) })}
                    {r.sandboxes.size > 0 && ` · ${[...r.sandboxes].join(', ')}`}
                  </div>
                  {r.reason && <div className="text-xs text-red-600">{t(`network.settings.denied.reason.${r.reason}`)}</div>}
                </div>
                {r.reason === 'private' ? (
                  isAllowed(r.host, allowPrivate) ? (
                    <span className="text-xs text-emerald-600">{t('network.settings.denied.alreadyAllowed')}</span>
                  ) : (
                    <Button size="sm" icon={<Check className="size-3.5" />} onClick={() => onAllowPrivate(r.host)} disabled={allowing}>
                      {t('network.settings.denied.allowPrivate')}
                    </Button>
                  )
                ) : r.reason ? null : already ? (
                  <span className="text-xs text-emerald-600">{t('network.settings.denied.alreadyAllowed')}</span>
                ) : (
                  <Button size="sm" icon={<Check className="size-3.5" />} onClick={() => onAllow(r.host)} disabled={allowing}>
                    {t('network.settings.denied.allow')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
