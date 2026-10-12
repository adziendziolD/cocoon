import { useEffect, useState } from 'react';
import { planRepos, REPO_PATH, repoFolderName, type Sandbox } from '@cocoon/protocol';
import { FolderGit2, Loader2, Plus, Trash2 } from 'lucide-react';
import { qk } from '../../api/keys';
import { useGitRepos, useSecrets } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { rich, useT } from '../../i18n';
import { repoDir, repoLabel } from '../../lib/repos';
import { isRepoUrl } from '../../lib/sandboxForm';
import { isSecretSet } from '../../lib/secrets';

/** Why no repository can be added right now (undefined = it can). */
export function addRepoBlocked(t: ReturnType<typeof useT>, sandbox: Sandbox): string | undefined {
  if (sandbox.network === 'none') return t('sandboxRepos.add.noNetwork');
  if (sandbox.status !== 'running') return t('sandboxRepos.add.notRunning');
  return undefined;
}

/** Clones another repository into a running sandbox (sandbox.add_repo). Cloning can take a while. */
export function AddRepoDialog({ sandbox, open, onClose, onAdded }: { sandbox: Sandbox; open: boolean; onClose: () => void; onAdded?: (path: string) => void }) {
  const t = useT();
  const secrets = useSecrets();
  const [form, setForm] = useState({ url: '', ref: '', path: '' });
  useEffect(() => {
    if (open) setForm({ url: '', ref: '', path: '' });
  }, [open]);

  const url = form.url.trim();
  const path = form.path.trim().replace(/^\/+|\/+$/g, '');
  const taken = sandbox.repos.map((r) => r.path);
  // The project folder itself is always taken (by a repository or the empty starting repository).
  const target = url ? planRepos([{ url, path: path || undefined }], ['.', ...taken])[0]?.path : undefined;
  const urlError = url && !isRepoUrl(url) ? t('wizard.repoError') : undefined;
  const pathError =
    path && !REPO_PATH.test(path)
      ? t('repoRows.err.folder')
      : target && taken.some((p) => p && (p === target || target.startsWith(`${p}/`) || p.startsWith(`${target}/`)))
        ? t('repoRows.err.duplicate', { path: target })
        : undefined;
  const blocked = addRepoBlocked(t, sandbox);

  // `before` = folders at the time of the call (the sandbox event with the new repository can arrive before the response).
  const add = useAction((_: { before: string[] }) => rpc('sandbox.add_repo', { sandboxId: sandbox.id, url, ref: form.ref.trim() || undefined, path: path || undefined }), {
    success: (s, { before }) => t('sandboxRepos.add.success', { path: s.repos.find((r) => !before.includes(r.path))?.path ?? target ?? '' }),
    error: t('sandboxRepos.add.error'),
    invalidate: [qk.sandbox(sandbox.id), qk.sandboxes, qk.git(sandbox.id), qk.diff(sandbox.id), qk.filesAll(sandbox.id)],
    onSuccess: (s, { before }) => {
      onClose();
      const added = s.repos.find((r) => !before.includes(r.path));
      if (added) onAdded?.(added.path);
    },
  });

  if (add.isPending) {
    return (
      <Dialog open={open} onClose={onClose} title={t('sandboxRepos.add.title')} dismissable={false} size="md">
        <div className="flex flex-col items-center py-6 text-center">
          <Loader2 className="size-10 animate-spin text-accent" />
          <p className="mt-4 font-medium text-fg">{t('sandboxRepos.add.cloning')}</p>
          <p className="mt-1.5 max-w-sm text-sm text-fg-muted">{t('sandboxRepos.add.cloningText')}</p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={t('sandboxRepos.add.title')}
      description={t('sandboxRepos.add.description')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={<Plus className="size-4" />} disabled={!!blocked || !url || !!urlError || !!pathError} onClick={() => add.mutate({ before: taken })}>
            {t('sandboxRepos.add.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {blocked && <Callout tone="warning">{blocked}</Callout>}
        <Field label={t('repoRows.url')} htmlFor="add-repo-url" error={urlError}>
          <Input id="add-repo-url" value={form.url} placeholder={t('wizard.repoPlaceholder')} invalid={!!urlError} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('wizard.branchLabel')} optional htmlFor="add-repo-ref" hint={t('sandboxRepos.add.branchHint')}>
            <Input id="add-repo-ref" value={form.ref} placeholder="main" onChange={(e) => setForm({ ...form, ref: e.target.value })} />
          </Field>
          <Field label={t('repoRows.folder')} optional htmlFor="add-repo-path" error={pathError} hint={t('sandboxRepos.add.folderHint')}>
            <Input
              id="add-repo-path"
              value={form.path}
              className="font-mono"
              invalid={!!pathError}
              placeholder={url ? repoFolderName(url) : t('repoRows.folderPlaceholder')}
              onChange={(e) => setForm({ ...form, path: e.target.value })}
            />
          </Field>
        </div>
        {target && !pathError && (
          <p className="flex items-center gap-1.5 text-sm text-fg-muted">
            <FolderGit2 className="size-4" />
            {rich(t('sandboxRepos.add.target'), { dir: <span className="font-mono text-fg">{repoDir(target, sandbox.workdir)}</span> })}
          </p>
        )}
        {url && !isSecretSet(secrets.data, 'GITHUB_TOKEN') && <Callout tone="tip">{t('wizard.privateRepoTip')}</Callout>}
      </div>
    </Dialog>
  );
}

/** Confirms and removes a repository folder (sandbox.remove_repo). The repository in the project folder itself can't be removed. */
export function RemoveRepoDialog({ sandbox, repo, onClose, onRemoved }: { sandbox: Sandbox; repo: string | null; onClose: () => void; onRemoved?: () => void }) {
  const t = useT();
  const summary = useGitRepos(sandbox.id, repo !== null).data?.find((r) => r.path === repo);
  const remove = useAction((path: string) => rpc('sandbox.remove_repo', { sandboxId: sandbox.id, repo: path }), {
    success: (_, path) => t('sandboxRepos.remove.success', { path }),
    error: t('sandboxRepos.remove.error'),
    invalidate: [qk.sandbox(sandbox.id), qk.sandboxes, qk.git(sandbox.id), qk.diff(sandbox.id), qk.filesAll(sandbox.id)],
    onSuccess: () => {
      onClose();
      onRemoved?.();
    },
  });
  return (
    <ConfirmDialog
      open={repo !== null}
      onClose={onClose}
      onConfirm={() => repo !== null && remove.mutate(repo)}
      loading={remove.isPending}
      danger
      title={t('sandboxRepos.remove.title', { path: repo ?? '' })}
      confirmLabel={t('sandboxRepos.remove.confirm')}
      message={
        <div className="space-y-2">
          <p>{rich(t('sandboxRepos.remove.message'), { dir: <span className="font-mono text-fg">{repoDir(repo ?? '', sandbox.workdir)}</span> })}</p>
          {!!summary?.changes && <p className="font-medium text-red-700 dark:text-red-400">{t('sandboxRepos.remove.openChanges', { count: summary.changes })}</p>}
        </div>
      }
    />
  );
}

/** Repository list (folder → URL) with add / remove, on the manage tab. */
export function SandboxReposCard({ sandbox }: { sandbox: Sandbox }) {
  const t = useT();
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const multi = sandbox.repos.length > 1;
  const summaries = useGitRepos(sandbox.id, sandbox.status === 'running' && sandbox.repos.length > 0);
  const blocked = addRepoBlocked(t, sandbox);

  return (
    <Card>
      <CardHeader
        title={t('sandboxRepos.card.title')}
        description={t('sandboxRepos.card.description')}
        actions={
          <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!!blocked} title={blocked} onClick={() => setAddOpen(true)}>
            {t('sandboxRepos.add.button')}
          </Button>
        }
      />
      {sandbox.repos.length === 0 ? (
        <CardBody className="text-sm text-fg-muted">{t('sandboxRepos.card.empty')}</CardBody>
      ) : (
        <ul className="divide-y divide-line">
          {sandbox.repos.map((r) => {
            const s = summaries.data?.find((x) => x.path === r.path);
            return (
              <li key={r.path} className="flex items-start gap-3 px-5 py-3 text-sm">
                <FolderGit2 className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px] text-fg">{repoDir(r.path, sandbox.workdir)}</span>
                    {!r.path && multi && <Badge tone="gray">{repoLabel(t, '')}</Badge>}
                    {!!s?.changes && <Badge tone="blue">{t('sandboxRepos.changes', { count: s.changes })}</Badge>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-fg-muted">
                    {r.url}
                    {r.ref ? ` @ ${r.ref}` : ''}
                  </div>
                  {s?.error && <div className="mt-0.5 text-xs text-red-600 dark:text-red-400">{s.error}</div>}
                </div>
                {r.path ? (
                  <IconButton label={t('sandboxRepos.remove.button')} icon={<Trash2 className="size-3.5" />} onClick={() => setRemoving(r.path)} disabled={sandbox.status !== 'running'} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {blocked && sandbox.network === 'none' && <CardBody className="border-t border-line text-xs text-fg-muted">{blocked}</CardBody>}
      <AddRepoDialog sandbox={sandbox} open={addOpen} onClose={() => setAddOpen(false)} />
      <RemoveRepoDialog sandbox={sandbox} repo={removing} onClose={() => setRemoving(null)} />
    </Card>
  );
}
