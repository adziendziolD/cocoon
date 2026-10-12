import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Sandbox } from '@cocoon/protocol';
import { Trash2 } from 'lucide-react';
import { qk } from '../../api/keys';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { SandboxStatusBadge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader, DetailList } from '../../components/Card';
import { ConfirmDialog } from '../../components/Dialog';
import { formatDateTime, formatMemory } from '../../lib/format';
import { backendDescription, useBackend } from '../../lib/backend';
import { runtimeInfo } from '../../lib/runtimes';
import { networkModeMeta, sandboxStatusMeta } from '../../lib/status';
import { useT } from '../../i18n';
import { StartStopButton } from '../../components/StartStopButton';
import { repoDir } from '../../lib/repos';
import { SandboxReposCard } from './RepoDialogs';

export function ManageTab({ sandbox: s }: { sandbox: Sandbox }) {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const t = useT();
  const rt = runtimeInfo(t, s.runtime);
  const net = networkModeMeta(t, s.network);
  const backend = useBackend();
  const caps = backend.capabilities;

  const del = useAction(() => rpc('sandbox.delete', { sandboxId: s.id }), {
    success: t('manage.delete.success', { name: s.name }),
    error: t('manage.delete.error'),
    invalidate: [qk.sandboxes, qk.agents, qk.setup],
    onSuccess: () => navigate('/sandboxes'),
  });

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="min-w-0 space-y-5">
        <Card>
          <CardHeader title={t('manage.details.title')} description={t('manage.details.description')} />
          <CardBody className="py-2">
            <DetailList
              items={[
                { label: t('manage.details.status'), value: <SandboxStatusBadge status={s.status} />, hint: sandboxStatusMeta(t, s.status).explanation },
                { label: t('manage.details.network'), value: net.label, hint: net.description },
                {
                  label: t('manage.details.repo'),
                  value:
                    s.repos.length > 1 ? (
                      <ul className="space-y-0.5">
                        {s.repos.map((r) => (
                          <li key={r.path} className="font-mono text-[13px] break-all">
                            <span className="text-fg">{repoDir(r.path, s.workdir)}</span> <span className="text-fg-muted">← {r.url}</span>
                          </li>
                        ))}
                      </ul>
                    ) : s.repo ? (
                      <span className="font-mono text-[13px] break-all">{s.repo.url}</span>
                    ) : (
                      t('manage.details.noRepo')
                    ),
                  hint: s.repos.length <= 1 && s.repo?.ref ? t('manage.details.branch', { ref: s.repo.ref }) : undefined,
                },
                {
                  label: t('manage.details.resources'),
                  value: `${s.resources.cpus ?? '–'} CPU · ${formatMemory(s.resources.memoryMb)}${s.resources.pids ? ` · ${t('manage.details.maxPids', { count: s.resources.pids })}` : ''}`,
                  hint: caps.resourceLimits ? undefined : t('backend.noResourceLimitsShort'),
                },
                caps.runtimes || !backend.kind
                  ? { label: t('manage.details.runtime'), value: rt.label, hint: rt.description }
                  : { label: t('manage.details.runtime'), value: backend.name ?? '–', hint: backendDescription(t, backend.kind) },
                ...(caps.images ? [{ label: t('manage.details.image'), value: <span className="font-mono text-[13px]">{s.image}</span> }] : []),
                { label: t('manage.details.workdir'), value: <span className="font-mono text-[13px]">{s.workdir}</span> },
                { label: t('manage.details.created'), value: formatDateTime(s.createdAt) },
                { label: t('manage.details.id'), value: <span className="font-mono text-[13px]">{s.id}</span> },
                ...(s.error ? [{ label: t('manage.details.error'), value: <span className="text-red-600 dark:text-red-400">{s.error}</span> }] : []),
              ]}
            />
          </CardBody>
        </Card>
        <SandboxReposCard sandbox={s} />
      </div>

      <div className="space-y-5">
        <Card>
          <CardHeader title={t('manage.startStop.title')} />
          <CardBody className="space-y-3 text-sm text-fg-muted">
            <p>{t('manage.startStop.text')}</p>
            <StartStopButton sandbox={s} />
          </CardBody>
        </Card>
        <Card className="border-red-500/30">
          <CardHeader title={<span className="text-red-700 dark:text-red-400">{t('manage.delete.title')}</span>} />
          <CardBody className="space-y-3 text-sm text-fg-muted">
            <p>{t('manage.delete.text')}</p>
            <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>
              {t('manage.delete.button')}
            </Button>
          </CardBody>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => del.mutate()}
        loading={del.isPending}
        danger
        title={t('manage.delete.confirmTitle')}
        confirmLabel={t('manage.delete.confirmLabel')}
        typeToConfirm={s.name}
        message={t('manage.delete.confirmMessage')}
      />
    </div>
  );
}
