import type { GithubIssue, GithubIssues, MethodParams, MethodResult, Task } from '@cocoon/protocol';
import { CocoonError } from './errors.ts';
import { t } from './i18n.ts';
import { parseGithubRepo } from './sandbox/git-auth.ts';
import type { SecretsService } from './secrets.ts';
import type { TaskService } from './tasks.ts';
import type { WorkspaceService } from './workspaces.ts';

const CACHE_MS = 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const BUG_LABEL = /\bbug\b|defect|regression|fehler/i;

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: (string | { name?: string })[];
  user?: { login?: string } | null;
  created_at: string;
  comments?: number;
  pull_request?: unknown;
  type?: { name?: string } | null;
}

/** Bug if GitHub's issue type or a label says so; everything else (enhancement, feature, question, …) is a feature. */
export function classifyIssue(raw: Pick<RawIssue, 'labels' | 'type'>): GithubIssue['kind'] {
  const names = [raw.type?.name, ...raw.labels.map((label) => (typeof label === 'string' ? label : label.name))];
  return names.some((name) => name && BUG_LABEL.test(name)) ? 'bug' : 'feature';
}

/** Issues only (the GitHub API lists pull requests as issues too). */
export function parseIssues(repo: string, raw: RawIssue[]): GithubIssue[] {
  return raw
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      repo,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      url: issue.html_url,
      kind: classifyIssue(issue),
      labels: issue.labels.map((label) => (typeof label === 'string' ? label : label.name)).filter((name): name is string => !!name),
      author: issue.user?.login ?? undefined,
      createdAt: issue.created_at,
      comments: issue.comments ?? 0,
    }));
}

/** Task title and description for an imported issue. */
export function taskFromIssue(issue: GithubIssue): { title: string; description: string } {
  const title = issue.title.length > 200 ? `${issue.title.slice(0, 199)}…` : issue.title;
  const body = issue.body.trim();
  return { title, description: `${body ? `${body}\n\n` : ''}---\nGitHub ${issue.repo}#${issue.number}: ${issue.url}` };
}

/** Reads the open issues of a workspace's GitHub repositories and imports them as tasks. */
export class IssueService {
  private readonly cache = new Map<string, { at: number; issues: GithubIssue[] }>();

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly tasks: TaskService,
    private readonly secrets: SecretsService,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async list({ workspaceId, refresh }: MethodParams<'github.issues'>): Promise<GithubIssues> {
    const workspace = this.workspaces.get(workspaceId);
    const sources = [...(workspace.repos ?? (workspace.repo ? [workspace.repo] : []))];
    const repos = [...new Set(sources.flatMap((source) => parseGithubRepo(source.url) ?? []).map(({ owner, repo }) => `${owner}/${repo}`))];
    const token = this.secrets.githubToken({ workspaceId });
    const imported = new Map<string, Task>();
    for (const task of this.tasks.list(workspaceId)) if (task.issue) imported.set(`${task.issue.repo}#${task.issue.number}`, task);

    const issues: GithubIssue[] = [];
    const errors: GithubIssues['errors'] = [];
    await Promise.all(
      repos.map(async (repo) => {
        try {
          for (const issue of await this.load(repo, token, Boolean(refresh))) {
            issues.push({ ...issue, taskId: imported.get(`${repo}#${issue.number}`)?.id });
          }
        } catch (err) {
          errors.push({ repo, message: (err as Error).message });
        }
      }),
    );
    issues.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { repos, issues, errors };
  }

  async import({ workspaceId, issues: wanted, status }: MethodParams<'github.import_issues'>): Promise<MethodResult<'github.import_issues'>> {
    const { issues } = await this.list({ workspaceId });
    const created: Task[] = [];
    let skipped = 0;
    for (const { repo, number } of wanted) {
      const issue = issues.find((x) => x.repo === repo && x.number === number);
      if (!issue || issue.taskId) {
        skipped++;
        continue;
      }
      // Sequential: every task takes the next task number of the workspace.
      created.push(this.tasks.create({ workspaceId, status, ...taskFromIssue(issue) }, { repo, number, url: issue.url }));
      issue.taskId = created.at(-1)!.id;
    }
    return { tasks: created, skipped };
  }

  private async load(repo: string, token: string | undefined, refresh: boolean): Promise<GithubIssue[]> {
    const key = `${repo}|${token ? 'auth' : 'anon'}`;
    const cached = this.cache.get(key);
    if (cached && !refresh && Date.now() - cached.at < CACHE_MS) return cached.issues;

    const issues: GithubIssue[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.fetchFn(`https://api.github.com/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=${PAGE_SIZE}&page=${page}`, {
        headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      const json: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = String((json as { message?: unknown }).message ?? res.status);
        throw new CocoonError('bad_request', t('error.github', { message: !token && res.status === 404 ? `${message} – ${t('error.issuesNeedToken')}` : message }));
      }
      const raw = json as RawIssue[];
      issues.push(...parseIssues(repo, raw));
      if (raw.length < PAGE_SIZE) break;
    }
    this.cache.set(key, { at: Date.now(), issues });
    return issues;
  }
}
