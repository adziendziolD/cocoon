import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { Sandbox } from '@cocoon/protocol';
import { ExternalLink, FileDown, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequest, Plus, RefreshCw, Trash2, UploadCloud } from 'lucide-react';
import { qk } from '../../api/keys';
import { useDiff, useGitRepos, useGitStatus, useSecrets } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Badge } from '../../components/Badge';
import { Button, buttonClasses } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { CopyButton } from '../../components/CodeBlock';
import { Dialog } from '../../components/Dialog';
import { DiffView } from '../../components/DiffView';
import { EmptyState } from '../../components/EmptyState';
import { Field, Input, Textarea } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { ErrorState, LoadingState } from '../../components/States';
import { downloadText } from '../../lib/base64';
import { isSecretSet } from '../../lib/secrets';
import { cn } from '../../lib/cn';
import { repoDir, repoLabel } from '../../lib/repos';
import { gitStatusLabel } from '../../lib/status';
import { rich, useT } from '../../i18n';
import { AddRepoDialog, addRepoBlocked, RemoveRepoDialog } from './RepoDialogs';

const BRANCH_RE = /^[\w./-]+$/;

function statusTone(code: string) {
  const c = code.trim();
  if (c === '??' || c.startsWith('A')) return 'green' as const;
  if (c.startsWith('D')) return 'red' as const;
  return 'blue' as const;
}

/** Selector value for "all repositories" (repository folders never contain a NUL). */
const ALL = '\0all';

export function ChangesTab({ sandbox }: { sandbox: Sandbox }) {
  const t = useT();
  const multi = sandbox.repos.length > 1;
  const [selected, setSelected] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const paths = sandbox.repos.map((r) => r.path);
  // Several repositories: every git call names one; default is the first. Single repository: as before, no `repo`.
  const current = !multi ? undefined : selected === ALL || (selected !== null && paths.includes(selected)) ? selected : paths[0]!;

  return (
    <div className="space-y-5">
      <Callout tone="tip">
        {rich(t('changes.intro'), { green: <strong>{t('changes.intro.green')}</strong>, red: <strong>{t('changes.intro.red')}</strong> })}
      </Callout>

      {multi && <RepoSelector sandbox={sandbox} value={current!} onChange={setSelected} onAdd={() => setAddOpen(true)} />}

      {current === ALL ? (
        <AllRepos sandbox={sandbox} onSelect={setSelected} />
      ) : (
        <RepoChanges key={current ?? ''} sandbox={sandbox} repo={current} onRemoved={() => setSelected(null)} />
      )}

      <AddRepoDialog sandbox={sandbox} open={addOpen} onClose={() => setAddOpen(false)} onAdded={setSelected} />
    </div>
  );
}

/** Pills for the repositories of a sandbox, each with its number of changed files, plus "Alle". */
function RepoSelector({ sandbox, value, onChange, onAdd }: { sandbox: Sandbox; value: string; onChange: (repo: string) => void; onAdd: () => void }) {
  const t = useT();
  const repos = useGitRepos(sandbox.id);
  const blocked = addRepoBlocked(t, sandbox);
  const pill = (active: boolean) =>
    cn(
      'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors',
      active ? 'border-accent bg-accent-soft text-fg' : 'border-line text-fg-muted hover:bg-surface-2 hover:text-fg',
    );
  return (
    <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={t('sandboxRepos.selector')}>
      <span className="mr-1 text-sm font-medium text-fg">{t('sandboxRepos.selector')}</span>
      {sandbox.repos.map((r) => {
        const s = repos.data?.find((x) => x.path === r.path);
        return (
          <button key={r.path} type="button" role="tab" aria-selected={value === r.path} onClick={() => onChange(r.path)} className={pill(value === r.path)} title={r.url}>
            <FolderGit2 className="size-3.5" />
            <span className={r.path ? 'font-mono text-[13px]' : undefined}>{repoLabel(t, r.path)}</span>
            {s?.error ? (
              <Badge tone="red">!</Badge>
            ) : s ? (
              <Badge tone={s.changes ? 'blue' : 'gray'} title={t('sandboxRepos.changes', { count: s.changes })}>
                {s.changes}
              </Badge>
            ) : null}
          </button>
        );
      })}
      <button type="button" role="tab" aria-selected={value === ALL} onClick={() => onChange(ALL)} className={pill(value === ALL)}>
        {t('sandboxRepos.all')}
      </button>
      <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={onAdd} disabled={!!blocked} title={blocked}>
        {t('sandboxRepos.add.button')}
      </Button>
    </div>
  );
}

/** "Alle": the combined patch grouped by repository, and an overview to pick a repository for commit / push / PR. */
function AllRepos({ sandbox, onSelect }: { sandbox: Sandbox; onSelect: (repo: string) => void }) {
  const t = useT();
  const repos = useGitRepos(sandbox.id);
  const diff = useDiff(sandbox.id);
  const patch = diff.data?.patch ?? '';
  const refresh = () => {
    void repos.refetch();
    void diff.refetch();
  };
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <section className="min-w-0 xl:order-1">
        <h2 className="mb-3 text-base font-semibold text-fg">{t('changes.detail.title')}</h2>
        {diff.isLoading ? (
          <LoadingState />
        ) : diff.error ? (
          <ErrorState error={diff.error} onRetry={() => diff.refetch()} />
        ) : !patch.trim() ? (
          <EmptyState icon={<GitCommitHorizontal className="size-6" />} title={t('changes.detail.emptyTitle')}>
            {t('changes.detail.emptyText')}
          </EmptyState>
        ) : (
          <DiffView patch={patch} groups={sandbox.repos.map((r) => r.path)} groupLabel={(p) => <span className={p ? 'font-mono' : undefined}>{repoLabel(t, p)}</span>} />
        )}
      </section>
      <div className="space-y-4 xl:order-2">
        <Card>
          <CardHeader
            title={t('sandboxRepos.card.title')}
            description={t('sandboxRepos.all.pick')}
            actions={<Button size="sm" variant="ghost" icon={<RefreshCw className={repos.isFetching || diff.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />} onClick={refresh}>{t('changes.refresh')}</Button>}
          />
          {repos.isLoading ? (
            <LoadingState />
          ) : repos.error ? (
            <ErrorState error={repos.error} onRetry={() => repos.refetch()} className="m-4" />
          ) : (
            <ul className="divide-y divide-line">
              {(repos.data ?? []).map((r) => (
                <li key={r.path}>
                  <button type="button" onClick={() => onSelect(r.path)} className="flex w-full items-start gap-3 px-5 py-3 text-left text-sm hover:bg-surface-2/60">
                    <FolderGit2 className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[13px] text-fg">{repoDir(r.path, sandbox.workdir)}</span>
                        <Badge tone={r.changes ? 'blue' : 'gray'}>{t('sandboxRepos.changes', { count: r.changes })}</Badge>
                      </div>
                      {r.url && <div className="mt-0.5 truncate font-mono text-xs text-fg-muted">{r.url}</div>}
                      {r.error ? (
                        <div className="mt-0.5 text-xs text-red-600 dark:text-red-400">{r.error}</div>
                      ) : (
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-fg-muted">
                          <span className="inline-flex items-center gap-1">
                            <GitBranch className="size-3" /> <span className="font-mono">{r.branch}</span>
                          </span>
                          {r.pushedBranch && <span>{t('sandboxRepos.pushedTo', { branch: r.pushedBranch })}</span>}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <Action
            icon={<FileDown className="size-4" />}
            title={t('changes.patch.title')}
            text={t('sandboxRepos.all.patchText')}
            button={
              <Button size="sm" disabled={!patch.trim()} onClick={() => downloadText(`${sandbox.name}.patch`, patch, 'text/x-diff')}>
                {t('changes.patch.button')}
              </Button>
            }
          />
        </Card>
      </div>
    </div>
  );
}

/** Changes, commit, push and pull request of one repository (`repo` undefined = the only repository). */
function RepoChanges({ sandbox, repo, onRemoved }: { sandbox: Sandbox; repo?: string; onRemoved: () => void }) {
  const git = useGitStatus(sandbox.id, repo);
  const diff = useDiff(sandbox.id, repo);
  const secrets = useSecrets();
  const t = useT();
  const [dialog, setDialog] = useState<'commit' | 'push' | 'pr' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const pushedBranch = git.data?.pushedBranch ?? '';
  const repoInfo = repo === undefined ? sandbox.repo : sandbox.repos.find((r) => r.path === repo);
  /** Shown in dialog titles with several repositories. */
  const repoName = repo === undefined ? undefined : repoLabel(t, repo);
  const patchName = repo ? `${sandbox.name}-${repo.replace(/\//g, '-')}.patch` : `${sandbox.name}.patch`;

  const hasToken = isSecretSet(secrets.data, 'GITHUB_TOKEN');
  const hasRemote = !!(git.data?.remoteUrl || repoInfo);
  const remoteHint = !hasRemote
    ? t('changes.remoteHint.noRepo')
    : !hasToken
      ? t('changes.remoteHint.noToken')
      : undefined;
  const uncommitted = git.data?.files.length ?? 0;
  const patch = diff.data?.patch ?? '';

  const qc = useQueryClient();
  const refresh = () => {
    void git.refetch();
    void diff.refetch();
    // Keeps the change counts of the repository selector in sync.
    if (repo !== undefined) void qc.invalidateQueries({ queryKey: qk.gitRepos(sandbox.id) });
  };

  return (
    <>
      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-5 xl:order-1">
          <Card>
            <CardHeader
              title={t('changes.files.title')}
              description={git.data ? t('changes.files.uncommitted', { count: uncommitted }) : undefined}
              actions={<Button size="sm" variant="ghost" icon={<RefreshCw className={git.isFetching || diff.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />} onClick={refresh}>{t('changes.refresh')}</Button>}
            />
            {git.isLoading ? (
              <LoadingState />
            ) : git.error ? (
              <ErrorState error={git.error} onRetry={() => git.refetch()} className="m-4" />
            ) : uncommitted === 0 ? (
              <CardBody className="text-sm text-fg-muted">{t('changes.files.none')} {patch ? t('changes.files.allCommitted') : ''}</CardBody>
            ) : (
              <ul className="divide-y divide-line">
                {git.data!.files.map((f) => (
                  <li key={f.path} className="flex items-center gap-3 px-5 py-2 text-sm">
                    <Badge tone={statusTone(f.status)} className="w-24 justify-center">
                      {gitStatusLabel(t, f.status)}
                    </Badge>
                    <span className="min-w-0 truncate font-mono text-[13px] text-fg">{f.path}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <section>
            <h2 className="mb-3 text-base font-semibold text-fg">{t('changes.detail.title')}</h2>
            {diff.isLoading ? (
              <LoadingState />
            ) : diff.error ? (
              <ErrorState error={diff.error} onRetry={() => diff.refetch()} />
            ) : !patch.trim() ? (
              <EmptyState icon={<GitCommitHorizontal className="size-6" />} title={t('changes.detail.emptyTitle')}>
                {t('changes.detail.emptyText')}
              </EmptyState>
            ) : (
              <DiffView patch={patch} />
            )}
          </section>
        </div>

        <div className="space-y-4 xl:order-2">
          <Card>
            <CardHeader title={t('changes.actions.title')} />
            <div className="divide-y divide-line">
              {repo !== undefined && (
                <div className="px-5 py-3 text-sm">
                  <div className="flex items-center gap-2 text-fg">
                    <FolderGit2 className="size-4 text-fg-muted" /> <span className="font-mono text-[13px]">{repoDir(repo, sandbox.workdir)}</span>
                  </div>
                  {repoInfo?.url && <div className="mt-0.5 truncate pl-6 font-mono text-xs text-fg-muted">{repoInfo.url}</div>}
                </div>
              )}
              {git.data && (
                <div className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm text-fg-muted">
                  <GitBranch className="size-4" /> {t('changes.branch')} <span className="font-mono text-fg">{git.data.branch}</span>
                  <span className="font-mono text-xs text-fg-subtle">{git.data.head.slice(0, 7)}</span>
                </div>
              )}
              <Action
                icon={<FileDown className="size-4" />}
                title={t('changes.patch.title')}
                text={t('changes.patch.text')}
                button={
                  <Button size="sm" disabled={!patch.trim()} onClick={() => downloadText(patchName, patch, 'text/x-diff')}>
                    {t('changes.patch.button')}
                  </Button>
                }
              />
              <Action
                icon={<GitCommitHorizontal className="size-4" />}
                title={t('changes.commit.title')}
                text={t('changes.commit.text')}
                button={
                  <Button size="sm" disabled={uncommitted === 0} onClick={() => setDialog('commit')}>
                    {t('changes.commit.button')}
                  </Button>
                }
              />
              <Action
                icon={<UploadCloud className="size-4" />}
                title={t('changes.push.title')}
                text={t('changes.push.text')}
                hint={remoteHint ?? (uncommitted > 0 ? t('changes.push.uncommittedHint', { count: uncommitted }) : undefined)}
                button={
                  <Button size="sm" disabled={!!remoteHint} onClick={() => setDialog('push')}>
                    {t('changes.push.button')}
                  </Button>
                }
              />
              <Action
                icon={<GitPullRequest className="size-4" />}
                title={t('changes.pr.title')}
                text={t('changes.pr.text')}
                hint={remoteHint ?? (!pushedBranch ? t('changes.pr.pushFirst') : undefined)}
                button={
                  <Button size="sm" disabled={!!remoteHint} onClick={() => setDialog('pr')}>
                    {t('changes.pr.button')}
                  </Button>
                }
              />
            </div>
          </Card>
          {!hasToken && hasRemote && (
            <Link to="/settings/secrets" className={buttonClasses('secondary', 'sm', 'w-full')}>
              {t('changes.addToken')}
            </Link>
          )}
          {repo && (
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} className="w-full text-red-600 dark:text-red-400" onClick={() => setRemoving(repo)} disabled={sandbox.status !== 'running'}>
              {t('sandboxRepos.remove.button')}
            </Button>
          )}
        </div>
      </div>

      <CommitDialog open={dialog === 'commit'} onClose={() => setDialog(null)} sandbox={sandbox} repo={repo} repoName={repoName} />
      <PushDialog
        open={dialog === 'push'}
        onClose={() => setDialog(null)}
        sandbox={sandbox}
        repo={repo}
        repoName={repoName}
        defaultBranch={pushedBranch || `cocoon/${sandbox.name}`}
        onPushed={() => void git.refetch()}
      />
      <PrDialog
        open={dialog === 'pr'}
        onClose={() => setDialog(null)}
        sandbox={sandbox}
        repo={repo}
        repoName={repoName}
        defaultBase={repoInfo?.ref ?? ''}
        defaultBranch={pushedBranch || `cocoon/${sandbox.name}`}
      />
      <RemoveRepoDialog sandbox={sandbox} repo={removing} onClose={() => setRemoving(null)} onRemoved={onRemoved} />
    </>
  );
}

/** Dialog title with the repository folder appended (several repositories). */
const withRepo = (title: string, repoName?: string) => (repoName ? `${title} · ${repoName}` : title);

function Action({ icon, title, text, hint, button }: { icon: ReactNode; title: string; text: string; hint?: string; button: ReactNode }) {
  return (
    <div className="px-5 py-3.5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-fg-muted">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">{title}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{text}</p>
          {hint && <p className="mt-1 text-xs leading-relaxed text-amber-700 dark:text-amber-400">{hint}</p>}
        </div>
        <div className="shrink-0">{button}</div>
      </div>
    </div>
  );
}

function CommitDialog({ open, onClose, sandbox, repo, repoName }: { open: boolean; onClose: () => void; sandbox: Sandbox; repo?: string; repoName?: string }) {
  const t = useT();
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (open) setMessage('');
  }, [open]);
  const commit = useAction((msg: string) => rpc('git.commit', { sandboxId: sandbox.id, message: msg, repo }), {
    success: (r) => t('changes.commitDialog.success', { sha: r.sha.slice(0, 7) }),
    error: t('changes.commitDialog.error'),
    invalidate: [qk.git(sandbox.id), qk.diff(sandbox.id)],
    onSuccess: onClose,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={withRepo(t('changes.commit.title'), repoName)}
      description={t('changes.commitDialog.description')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!message.trim()} loading={commit.isPending} onClick={() => commit.mutate(message.trim())}>
            {t('changes.commit.title')}
          </Button>
        </>
      }
    >
      <Field label={t('changes.commitDialog.message')} hint={t('changes.commitDialog.messageHint')}>
        <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
      </Field>
    </Dialog>
  );
}

function PushDialog({
  open,
  onClose,
  sandbox,
  repo,
  repoName,
  defaultBranch,
  onPushed,
}: {
  open: boolean;
  onClose: () => void;
  sandbox: Sandbox;
  repo?: string;
  repoName?: string;
  defaultBranch: string;
  onPushed: (b: string) => void;
}) {
  const t = useT();
  const [branch, setBranch] = useState(defaultBranch);
  useEffect(() => {
    if (open) setBranch(defaultBranch);
  }, [open, defaultBranch]);
  const invalid = !BRANCH_RE.test(branch);
  const push = useAction((b: string) => rpc('git.push', { sandboxId: sandbox.id, branch: b, repo }), {
    success: (r) => t('changes.pushDialog.success', { branch: r.branch }),
    error: t('changes.pushDialog.error'),
    invalidate: [qk.git(sandbox.id)],
    onSuccess: (r) => {
      onPushed(r.branch);
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={withRepo(t('changes.push.title'), repoName)}
      description={t('changes.pushDialog.description')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={<UploadCloud className="size-4" />} disabled={invalid} loading={push.isPending} onClick={() => push.mutate(branch)}>
            {t('changes.pushDialog.submit')}
          </Button>
        </>
      }
    >
      <Field
        label={t('changes.pushDialog.branch')}
        error={invalid ? t('changes.pushDialog.branchInvalid') : undefined}
        hint={t('changes.pushDialog.branchHint')}
      >
        <Input value={branch} onChange={(e) => setBranch(e.target.value)} className="font-mono" invalid={invalid} />
      </Field>
    </Dialog>
  );
}

function PrDialog({
  open,
  onClose,
  sandbox,
  repo,
  repoName,
  defaultBranch,
  defaultBase,
}: {
  open: boolean;
  onClose: () => void;
  sandbox: Sandbox;
  repo?: string;
  repoName?: string;
  defaultBranch: string;
  defaultBase: string;
}) {
  const t = useT();
  const [form, setForm] = useState({ branch: defaultBranch, title: '', body: '', base: '' });
  const [result, setResult] = useState<{ url: string; number: number } | null>(null);
  useEffect(() => {
    if (open) {
      setForm({ branch: defaultBranch, title: '', body: '', base: defaultBase });
      setResult(null);
    }
  }, [open, defaultBranch, defaultBase]);
  const pr = useAction(() => rpc('git.create_pr', { sandboxId: sandbox.id, branch: form.branch, title: form.title.trim(), body: form.body.trim() || undefined, base: form.base.trim() || undefined, repo }), {
    success: (r) => t('changes.prDialog.success', { number: String(r.number) }),
    error: t('changes.prDialog.error'),
    onSuccess: setResult,
  });

  if (result) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title={t('changes.prDialog.success', { number: String(result.number) })}
        footer={
          <>
            <Button onClick={onClose}>{t('common.close')}</Button>
            <a href={result.url} target="_blank" rel="noreferrer" className={buttonClasses('primary')}>
              {t('changes.prDialog.openOnGithub')} <ExternalLink className="size-4" />
            </a>
          </>
        }
      >
        <p className="text-sm text-fg-muted">{t('changes.prDialog.doneText')}</p>
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-gray-950 px-3 py-2 font-mono text-xs text-gray-200">
          <span className="min-w-0 flex-1 truncate">{result.url}</span>
          <CopyButton text={result.url} />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={withRepo(t('changes.pr.title'), repoName)}
      description={t('changes.prDialog.description')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={<GitPullRequest className="size-4" />} disabled={!form.title.trim() || !form.branch.trim()} loading={pr.isPending} onClick={() => pr.mutate(undefined)}>
            {t('changes.pr.title')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('changes.prDialog.from')} hint={t('changes.prDialog.fromHint')}>
            <Input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} className="font-mono" />
          </Field>
          <Field label={t('changes.prDialog.into')} optional hint={t('changes.prDialog.intoHint')}>
            <Input value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} className="font-mono" placeholder="main" />
          </Field>
        </div>
        <Field label={t('changes.prDialog.titleLabel')}>
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('changes.prDialog.titlePlaceholder')} />
        </Field>
        <Field label={t('changes.prDialog.body')} optional hint={t('changes.prDialog.bodyHint')}>
          <Textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={5} />
        </Field>
      </div>
    </Dialog>
  );
}
