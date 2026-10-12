import { useEffect, useRef } from 'react';
import type { CocoonUpdateInfo, ImageUpdateInfo, ToolUpdateInfo, UpdateState, UpdateStatus, UpdateTarget } from '@cocoon/protocol';
import { ArrowUpCircle, Bot, Boxes, Package, RefreshCw, RotateCcw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../../api/keys';
import { useAgents, useSystemInfo, useUpdateStatus } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Badge } from '../../components/Badge';
import { BuildLog, imageLabel } from '../../components/BuildLog';
import { Button, ButtonLink } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { CodeBlock } from '../../components/CodeBlock';
import { Callout } from '../../components/HelpText';
import { ErrorState, LoadingState } from '../../components/States';
import { useT, type MessageKey } from '../../i18n';
import { formatRelative } from '../../lib/format';
import type { Tone } from '../../lib/status';

const STATE: Record<UpdateState, { tone: Tone; label: MessageKey }> = {
  current: { tone: 'green', label: 'updates.state.current' },
  outdated: { tone: 'amber', label: 'updates.state.outdated' },
  missing: { tone: 'gray', label: 'updates.state.missing' },
  unknown: { tone: 'gray', label: 'updates.state.unknown' },
};

const TARGET_LABEL: Record<UpdateTarget, MessageKey> = {
  cocoon: 'updates.target.cocoon',
  tools: 'updates.target.tools',
  images: 'updates.target.images',
};

function StateBadge({ state }: { state: UpdateState }) {
  const t = useT();
  return <Badge tone={STATE[state].tone}>{t(STATE[state].label)}</Badge>;
}

/** Starts update.apply for some targets (or everything outdated). */
function useApply() {
  const t = useT();
  return useAction((targets: UpdateTarget[] | undefined) => rpc('update.apply', { targets }), {
    success: t('updates.started'),
    error: t('updates.startFailed'),
    invalidate: [qk.updates],
  });
}

/** After a restart the server reports a new start time: then load the (possibly updated) web interface again. */
function useReloadAfterRestart(waiting: boolean) {
  const info = useSystemInfo();
  const startedAt = useRef<string | undefined>(undefined);
  if (!startedAt.current && info.data?.startedAt) startedAt.current = info.data.startedAt;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      rpc('system.info')
        .then((next) => {
          if (next.startedAt && startedAt.current && next.startedAt !== startedAt.current) window.location.reload();
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting]);
}

export function UpdatesSettings() {
  const t = useT();
  const qc = useQueryClient();
  const status = useUpdateStatus();
  const apply = useApply();
  const check = useAction(() => rpc('update.status', { refresh: true }), {
    error: t('updates.checkFailed'),
    onSuccess: (s) => qc.setQueryData(qk.updates, s),
  });
  const restart = useAction(() => rpc('system.restart'), { error: t('updates.restartFailed'), invalidate: [qk.updates] });
  const s = status.data;
  useReloadAfterRestart(!!s && (s.restarting || (s.restartRequired && s.canRestart)));

  if (status.error) return <ErrorState error={status.error} onRetry={() => status.refetch()} />;
  if (!s) return <LoadingState />;

  const busy = s.running || s.restarting || apply.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          icon={<ArrowUpCircle className="size-5" />}
          title={t('updates.title')}
          description={t('updates.description')}
          actions={
            <>
              <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={check.isPending} disabled={busy} onClick={() => check.mutate()}>
                {t('updates.check')}
              </Button>
              {s.available.length > 0 && (
                <Button size="sm" variant="primary" icon={<ArrowUpCircle className="size-3.5" />} loading={busy} onClick={() => apply.mutate(undefined)}>
                  {t('updates.updateAll')}
                </Button>
              )}
            </>
          }
        />
        <CardBody className="space-y-3">
          <p className="text-sm text-fg-muted">{t('updates.checkedAt', { time: formatRelative(s.checkedAt) })}</p>
          <Summary status={s} onRestart={() => restart.mutate()} restarting={restart.isPending} />
        </CardBody>
      </Card>

      <CocoonCard info={s.cocoon} busy={busy} onUpdate={() => apply.mutate(['cocoon'])} />
      <ToolsCard tools={s.tools} busy={busy} onUpdate={() => apply.mutate(['tools'])} />
      {s.images.length > 0 && <ImagesCard images={s.images} busy={busy} onUpdate={() => apply.mutate(['images'])} />}
    </div>
  );
}

function Summary({ status: s, onRestart, restarting }: { status: UpdateStatus; onRestart: () => void; restarting: boolean }) {
  const t = useT();
  if (s.restarting) return <Callout tone="info">{t('updates.restarting')}</Callout>;
  if (s.running) return <Callout tone="info">{t('updates.running')}</Callout>;
  if (s.restartRequired && !s.canRestart) {
    return (
      <Callout tone="warning" title={t('updates.restartManual.title')}>
        <p>{t('updates.restartManual.text')}</p>
        <CodeBlock className="mt-2" code="pnpm start" />
      </Callout>
    );
  }
  if (s.restartRequired) {
    return (
      <Callout
        tone="warning"
        title={t('updates.restartManual.title')}
        action={
          <Button size="sm" variant="warning" icon={<RotateCcw className="size-3.5" />} loading={restarting} onClick={onRestart}>
            {t('updates.restartNow')}
          </Button>
        }
      />
    );
  }
  if (s.available.length) return <Callout tone="warning">{t('updates.available', { items: s.available.map((x) => t(TARGET_LABEL[x])).join(', ') })}</Callout>;
  return <Callout tone="success">{t('updates.allCurrent')}</Callout>;
}

function CocoonCard({ info, busy, onUpdate }: { info: CocoonUpdateInfo; busy: boolean; onUpdate: () => void }) {
  const t = useT();
  const installed = [info.version, info.commit].filter(Boolean).join(' · ');
  const latest = info.latestCommit ? [info.latestVersion, info.latestCommit].filter(Boolean).join(' · ') : undefined;
  return (
    <Card>
      <CardHeader
        icon={<Package className="size-5" />}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t('updates.target.cocoon')} <StateBadge state={info.state} />
          </span>
        }
        description={t('updates.cocoon.description')}
        actions={
          info.state === 'outdated' && (
            <Button size="sm" variant="primary" loading={busy} disabled={!!info.blocked} onClick={onUpdate}>
              {t('updates.update')}
            </Button>
          )
        }
      />
      <CardBody className="space-y-3">
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-fg-muted">{t('updates.cocoon.installed')}</dt>
          <dd className="font-mono text-fg">{installed}</dd>
          {latest && (
            <>
              <dt className="text-fg-muted">{t('updates.cocoon.latest')}</dt>
              <dd className="font-mono text-fg">{latest}</dd>
            </>
          )}
          {info.branch && (
            <>
              <dt className="text-fg-muted">{t('updates.cocoon.branch')}</dt>
              <dd className="font-mono text-fg">{info.upstream ? `${info.branch} → ${info.upstream}` : info.branch}</dd>
            </>
          )}
        </dl>
        {info.blocked && <Callout tone="warning">{t(`updates.cocoon.blocked.${info.blocked}`)}</Callout>}
        {info.error && <Callout tone="danger">{t('updates.cocoon.checkError', { error: info.error })}</Callout>}
        {info.ahead > 0 && info.behind === 0 && <p className="text-xs text-fg-muted">{t('updates.cocoon.ahead', { count: info.ahead })}</p>}
        {info.changes.length > 0 && (
          <details className="text-sm" open={info.changes.length <= 8}>
            <summary className="cursor-pointer font-medium text-fg-muted hover:text-fg">{t('updates.cocoon.newCommits', { count: info.behind })}</summary>
            <ul className="mt-2 space-y-1">
              {info.changes.map((c) => (
                <li key={c.commit} className="flex gap-2">
                  <code className="shrink-0 font-mono text-xs text-fg-subtle">{c.commit}</code>
                  <span className="text-fg">{c.subject}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <BuildLog kind="cocoon" />
      </CardBody>
    </Card>
  );
}

function ToolsCard({ tools, busy, onUpdate }: { tools: ToolUpdateInfo[]; busy: boolean; onUpdate: () => void }) {
  const t = useT();
  const agents = useAgents();
  const runningAgents = (agents.data ?? []).filter((a) => a.status !== 'exited').length;
  const outdated = tools.some((tool) => tool.state === 'outdated');
  return (
    <Card>
      <CardHeader
        icon={<Bot className="size-5" />}
        title={t('updates.target.tools')}
        description={t('updates.tools.description')}
        actions={
          tools.length > 0 && (
            <Button size="sm" variant={outdated ? 'primary' : 'secondary'} loading={busy} onClick={onUpdate}>
              {t('updates.update')}
            </Button>
          )
        }
      />
      <CardBody className="space-y-3">
        {tools.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-fg-muted">{t('updates.tools.none')}</p>
            <ButtonLink to="/settings/sandbox" size="sm">
              {t('updates.tools.manage')}
            </ButtonLink>
          </div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-fg-muted">
                  <th className="pb-1 font-medium">{t('updates.tools.tool')}</th>
                  <th className="pb-1 font-medium">{t('updates.tools.installed')}</th>
                  <th className="pb-1 font-medium">{t('updates.tools.latest')}</th>
                  <th className="pb-1" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {tools.map((tool) => (
                  <tr key={tool.tool}>
                    <td className="py-1.5 font-medium text-fg">{tool.label}</td>
                    <td className="py-1.5 font-mono text-xs text-fg">{tool.installed ?? '–'}</td>
                    <td className="py-1.5 font-mono text-xs text-fg" title={tool.error}>
                      {tool.latest ?? '–'}
                    </td>
                    <td className="py-1.5 text-right">
                      <StateBadge state={tool.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {outdated && runningAgents > 0 && <Callout tone="warning">{t('updates.tools.runningAgents', { count: runningAgents })}</Callout>}
          </>
        )}
        <BuildLog kind="agents" />
      </CardBody>
    </Card>
  );
}

function ImagesCard({ images, busy, onUpdate }: { images: ImageUpdateInfo[]; busy: boolean; onUpdate: () => void }) {
  const t = useT();
  const updatable = images.some((img) => img.state === 'outdated' || img.reason === 'untracked');
  return (
    <Card>
      <CardHeader
        icon={<Boxes className="size-5" />}
        title={t('updates.target.images')}
        description={t('updates.images.description')}
        actions={
          updatable && (
            <Button size="sm" variant="primary" loading={busy} onClick={onUpdate}>
              {t('updates.update')}
            </Button>
          )
        }
      />
      <CardBody className="space-y-4">
        {images.map((img) => (
          <div key={img.kind}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-fg">{imageLabel(t, img.kind)}</span>
              {img.reason !== 'custom' && <StateBadge state={img.state} />}
            </div>
            <div className="mt-0.5 font-mono text-xs text-fg-subtle">
              {[img.ref, img.base && t('updates.images.base', { base: img.base }), img.builtAt && t('updates.images.built', { time: formatRelative(img.builtAt) })]
                .filter(Boolean)
                .join(' · ')}
            </div>
            {img.reason && <p className="mt-1 text-sm text-fg-muted">{t(`updates.images.reason.${img.reason}`)}</p>}
            <BuildLog kind={img.kind} className="mt-3" />
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
