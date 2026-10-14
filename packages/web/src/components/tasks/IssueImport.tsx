import { useEffect, useMemo, useState } from 'react';
import type { GithubIssue, Workspace } from '@cocoon/protocol';
import { Bug, ExternalLink, MessageSquare, RefreshCw, Sparkles } from 'lucide-react';
import { qk } from '../../api/keys';
import { useGithubIssues } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Checkbox } from '../Field';
import { Callout } from '../HelpText';
import { ErrorState, LoadingState } from '../States';
import { Tabs } from '../Tabs';

type Kind = GithubIssue['kind'];
const keyOf = (issue: Pick<GithubIssue, 'repo' | 'number'>) => `${issue.repo}#${issue.number}`;

/** Two badges (new bugs / new features from GitHub) for a workspace's task list; clicking one opens the import list. */
export function IssueBadges({ workspace }: { workspace: Workspace }) {
  const t = useT();
  const issues = useGithubIssues(workspace.id);
  const [open, setOpen] = useState<Kind | null>(null);
  // Without a GitHub repository there is nothing to show.
  if (!issues.data?.repos.length) return null;

  const fresh = issues.data.issues.filter((x) => !x.taskId);
  const bugs = fresh.filter((x) => x.kind === 'bug').length;
  const features = fresh.length - bugs;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <IssueBadge count={bugs} tone="red" icon={<Bug className="size-3.5" />} label={t('issues.bugs')} title={t('issues.badgeBugs', { count: bugs })} onClick={() => setOpen('bug')} />
        <IssueBadge
          count={features}
          tone="blue"
          icon={<Sparkles className="size-3.5" />}
          label={t('issues.features')}
          title={t('issues.badgeFeatures', { count: features })}
          onClick={() => setOpen('feature')}
        />
      </div>
      <IssueImportDialog workspace={workspace} kind={open ?? 'bug'} open={open !== null} onKind={setOpen} onClose={() => setOpen(null)} />
    </>
  );
}

function IssueBadge({ count, tone, icon, label, title, onClick }: { count: number; tone: 'red' | 'blue'; icon: React.ReactNode; label: string; title: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title={title} className="rounded-full focus-visible:outline-2 focus-visible:outline-accent">
      <Badge tone={count > 0 ? tone : 'gray'} className="cursor-pointer px-2.5 py-1 hover:brightness-95">
        {icon}
        {label}
        <span className="font-semibold tabular-nums">{count}</span>
      </Badge>
    </button>
  );
}

function IssueImportDialog({ workspace, kind, open, onKind, onClose }: { workspace: Workspace; kind: Kind; open: boolean; onKind: (kind: Kind) => void; onClose: () => void }) {
  const t = useT();
  const issues = useGithubIssues(workspace.id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [queued, setQueued] = useState(false);
  useEffect(() => {
    if (open) setSelected(new Set());
  }, [open]);

  const fresh = useMemo(() => (issues.data?.issues ?? []).filter((x) => !x.taskId), [issues.data]);
  const bugs = fresh.filter((x) => x.kind === 'bug');
  const features = fresh.filter((x) => x.kind === 'feature');
  const shown = kind === 'bug' ? bugs : features;
  const chosen = fresh.filter((x) => selected.has(keyOf(x)));
  const allShown = shown.length > 0 && shown.every((x) => selected.has(keyOf(x)));

  const toggle = (issue: GithubIssue, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(keyOf(issue));
      else next.delete(keyOf(issue));
      return next;
    });
  const toggleAll = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const issue of shown) if (on) next.add(keyOf(issue));
      else next.delete(keyOf(issue));
      return next;
    });

  const refresh = useAction(() => rpc('github.issues', { workspaceId: workspace.id, refresh: true }), {
    error: t('issues.loadFailed'),
    invalidate: [qk.githubIssues(workspace.id)],
  });
  const importIssues = useAction(
    () => rpc('github.import_issues', { workspaceId: workspace.id, status: queued ? 'queued' : 'backlog', issues: chosen.map(({ repo, number }) => ({ repo, number })) }),
    {
      error: t('issues.importFailed'),
      success: (result) => t('issues.imported', { count: result.tasks.length }),
      invalidate: [qk.githubIssues(workspace.id), qk.tasks, qk.workspaces],
      onSuccess: onClose,
    },
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!importIssues.isPending}
      size="lg"
      title={t('issues.title')}
      description={t('issues.description')}
      footer={
        <>
          <Button onClick={onClose} disabled={importIssues.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={importIssues.isPending} disabled={chosen.length === 0} onClick={() => importIssues.mutate()}>
            {t('issues.import', { count: chosen.length })}
          </Button>
        </>
      }
    >
      <Tabs
        tabs={[
          { id: 'bug', label: t('issues.bugs'), icon: <Bug className="size-4" />, count: bugs.length },
          { id: 'feature', label: t('issues.features'), icon: <Sparkles className="size-4" />, count: features.length },
        ]}
        value={kind}
        onChange={onKind}
      />
      {issues.isLoading ? (
        <LoadingState />
      ) : issues.error ? (
        <ErrorState error={issues.error} onRetry={() => void issues.refetch()} title={t('issues.loadFailed')} />
      ) : (
        <div className="space-y-3">
          {issues.data?.errors.map((e) => (
            <Callout key={e.repo} tone="warning">
              {e.repo}: {e.message}
            </Callout>
          ))}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Checkbox checked={allShown} onChange={toggleAll} disabled={shown.length === 0} label={t('issues.selectAll')} />
            <span className="flex-1" />
            <span className="text-fg-muted">{t('issues.selected', { count: chosen.length })}</span>
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={refresh.isPending} onClick={() => refresh.mutate()}>
              {t('issues.refresh')}
            </Button>
          </div>
          {shown.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-fg-muted">{t('issues.empty')}</p>
          ) : (
            <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {shown.map((issue) => (
                <li key={keyOf(issue)} className={cn('px-3 py-2.5', selected.has(keyOf(issue)) && 'bg-accent/5')}>
                  <Checkbox
                    checked={selected.has(keyOf(issue))}
                    onChange={(on) => toggle(issue, on)}
                    label={
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium">{issue.title}</span>
                        {issue.labels.map((label) => (
                          <Badge key={label}>{label}</Badge>
                        ))}
                      </span>
                    }
                    description={
                      <span className="flex flex-wrap items-center gap-x-3">
                        <span>{keyOf(issue)}</span>
                        {issue.author && <span>{t('issues.by', { author: issue.author })}</span>}
                        {issue.comments > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <MessageSquare className="size-3" /> {t('issues.comments', { count: issue.comments })}
                          </span>
                        )}
                        <a href={issue.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                          {t('issues.open')} <ExternalLink className="size-3" />
                        </a>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
          <Checkbox checked={queued} onChange={setQueued} label={t('issues.importQueued')} />
        </div>
      )}
    </Dialog>
  );
}
