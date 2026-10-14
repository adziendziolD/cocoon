import { normalizeRepoUrl, type EnvFileStatus, type EnvOrigin, type Sandbox } from '@cocoon/protocol';
import { FileLock2, ShieldCheck } from 'lucide-react';
import { qk } from '../../api/keys';
import { useResolvedEnv, useWorkspaces } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { EnvScopeEditor } from '../../components/EnvScopeEditor';
import { Callout } from '../../components/HelpText';
import { ErrorState, LoadingState } from '../../components/States';
import { useT } from '../../i18n';

const levelTone = { workspace: 'accent', repo: 'blue', sandbox: 'green', agent: 'amber' } as const;

export function EnvTab({ sandbox: s }: { sandbox: Sandbox }) {
  const t = useT();
  const resolved = useResolvedEnv(s.id);
  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find((w) => w.id === s.workspaceId);
  const apply = useAction(() => rpc('env.apply', { sandboxId: s.id }), {
    success: t('env.files.applied'),
    error: t('env.files.applyFailed'),
    invalidate: [qk.envResolved(s.id)],
  });
  const repos = [...new Map(s.repos.map((r) => [normalizeRepoUrl(r.url), r])).values()];

  const origin = (o: EnvOrigin) => (
    <Badge tone={levelTone[o.scope]} title={o.label}>
      {t(`env.level.${o.scope}`)}
    </Badge>
  );

  return (
    <div className="space-y-5">
      <Callout tone="info">{t('env.intro')}</Callout>

      <Card>
        <CardHeader icon={<ShieldCheck className="size-4.5" />} title={t('env.merged.title')} description={t('env.merged.description')} />
        {resolved.isLoading ? (
          <LoadingState />
        ) : resolved.error || !resolved.data ? (
          <ErrorState error={resolved.error} onRetry={() => resolved.refetch()} />
        ) : resolved.data.vars.length === 0 ? (
          <CardBody className="py-6 text-center text-sm text-fg-muted">{t('env.merged.empty')}</CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {resolved.data.vars.map((v) => (
              <li key={v.name} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                <code className="min-w-0 flex-1 truncate font-mono text-sm">{v.name}</code>
                <span className="max-w-[35%] truncate font-mono text-xs text-fg-muted">{v.secret ? '••••••••' : v.value}</span>
                {origin(v.origin)}
                {v.overrides.length > 0 && (
                  <span className="text-xs text-fg-subtle">{t('env.merged.overrides', { levels: v.overrides.map((o) => t(`env.level.${o.scope}`)).join(', ') })}</span>
                )}
                {v.proxyHost && <Badge tone="green">{t('env.editor.proxied', { host: v.proxyHost })}</Badge>}
                {v.skipped && (
                  <Badge tone="amber" title={v.skipped}>
                    {t('env.merged.skipped')}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          icon={<FileLock2 className="size-4.5" />}
          title={t('env.files.title')}
          description={t('env.files.description')}
          actions={
            <Button size="sm" disabled={s.status !== 'running'} loading={apply.isPending} onClick={() => apply.mutate()} title={s.status === 'running' ? t('env.files.applyHint') : t('env.files.needsRunning')}>
              {t('env.files.apply')}
            </Button>
          }
        />
        <CardBody className="py-3">
          {(resolved.data?.files.length ?? 0) === 0 ? (
            <p className="text-sm text-fg-muted">{t('env.files.none')}</p>
          ) : (
            <ul className="space-y-1.5">
              {resolved.data!.files.map((f) => (
                <FileLine key={`${f.folder}/${f.path}`} file={f} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <EnvScopeEditor scope={{ scope: 'sandbox', id: s.id }} title={t('env.title.sandbox')} description={t('env.desc.sandbox')} />
      {repos.map((r) => {
        const id = normalizeRepoUrl(r.url);
        return <EnvScopeEditor key={id} scope={{ scope: 'repo', id }} title={t('env.title.repo', { name: id })} description={t('env.desc.repo')} />;
      })}
      {workspace && <EnvScopeEditor scope={{ scope: 'workspace', id: workspace.id }} title={t('env.title.workspace', { name: workspace.name })} description={t('env.desc.workspace')} />}
    </div>
  );
}

function FileLine({ file }: { file: EnvFileStatus }) {
  const t = useT();
  const tone = file.status === 'error' ? 'red' : file.status === 'skipped' ? 'amber' : file.status === 'unchanged' ? 'gray' : 'green';
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <code className="font-mono">{file.folder ? `${file.folder}/${file.path}` : file.path}</code>
      <Badge tone={tone}>{t(`env.files.status.${file.status}`)}</Badge>
      {file.message && <span className="text-xs text-fg-muted">{file.message}</span>}
    </li>
  );
}
