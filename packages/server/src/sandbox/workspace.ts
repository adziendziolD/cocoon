import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import type { FileEntry, MethodParams, MethodResult, SandboxRepo } from '@cocoon/protocol';
import { CocoonError } from '../errors.ts';
import type { SecretsService } from '../secrets.ts';
import type { SandboxDriver } from './driver.ts';
import { STAGING_DIR } from '../agents/tmux.ts';
import { githubAuthEnv, parseGithubRepo } from './git-auth.ts';
import { BASELINE_TAG, reposOf, type SandboxManager } from './manager.ts';
import { singleFileTar } from './tar.ts';
import { t } from '../i18n.ts';

const TYPE_MAP: Record<string, FileEntry['type']> = { f: 'file', d: 'dir', l: 'symlink' };

/** Files, patches and git operations inside a sandbox workspace. */
export class WorkspaceService {
  private readonly owners = new Map<string, { uid: number; gid: number }>();

  constructor(
    private readonly sandboxes: SandboxManager,
    private readonly driver: SandboxDriver,
    private readonly secrets: SecretsService,
  ) {}

  resolve(sandboxId: string, path: string): string {
    const { workdir } = this.sandboxes.record(sandboxId);
    return path.startsWith('/') ? posix.normalize(path) : posix.join(workdir, path);
  }

  // ── files ──────────────────────────────────────────────────────────────────

  async list(sandboxId: string, path: string): Promise<MethodResult<'files.list'>> {
    const dir = this.resolve(sandboxId, path);
    const out = await this.sandboxes.sh(
      sandboxId,
      `[ -d "$P" ] || { echo "$MSG" >&2; exit 1; }; find "$P" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n'`,
      { P: dir, MSG: t('error.dirNotFound', { path: dir }) },
    );
    const entries = out
      .split('\n')
      .filter(Boolean)
      .map((line): FileEntry => {
        const [type = '', size = '0', mtime = '0', ...name] = line.split('\t');
        return {
          name: name.join('\t'),
          type: TYPE_MAP[type] ?? 'other',
          size: Number(size),
          modifiedAt: new Date(Number(mtime) * 1000).toISOString(),
        };
      })
      .sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    return { path: dir, entries };
  }

  async read(sandboxId: string, path: string, maxBytes: number): Promise<MethodResult<'files.read'>> {
    const file = this.resolve(sandboxId, path);
    const out = await this.sandboxes.sh(
      sandboxId,
      `[ -f "$P" ] || { echo "$MSG" >&2; exit 1; }; stat -c %s "$P"; head -c "$MAX" "$P" | base64 -w0`,
      { P: file, MAX: String(maxBytes), MSG: t('error.fileNotFound', { path: file }) },
    );
    const nl = out.indexOf('\n');
    const size = Number(out.slice(0, nl));
    const bytes = Buffer.from(out.slice(nl + 1).trim(), 'base64');
    const text = decodeUtf8(bytes);
    return {
      path: file,
      size,
      truncated: size > bytes.length,
      ...(text === undefined ? { content: bytes.toString('base64'), encoding: 'base64' as const } : { content: text, encoding: 'utf8' as const }),
    };
  }

  async write({ sandboxId, path, content, encoding = 'utf8' }: MethodParams<'files.write'>): Promise<void> {
    const file = this.resolve(sandboxId, path);
    const handle = this.sandboxes.runningHandle(sandboxId);
    const owner = await this.owner(sandboxId);
    const staged = `upload-${randomBytes(6).toString('hex')}`;
    await this.driver.putArchive(handle, STAGING_DIR, singleFileTar(staged, Buffer.from(content, encoding), owner));
    await this.sandboxes.sh(sandboxId, 'mkdir -p "$(dirname "$F")" && mv -f "$S" "$F"', { S: `${STAGING_DIR}/${staged}`, F: file });
  }

  async mkdir(sandboxId: string, path: string): Promise<void> {
    await this.sandboxes.sh(sandboxId, 'mkdir -p -- "$P"', { P: this.resolve(sandboxId, path) });
  }

  async delete(sandboxId: string, path: string): Promise<void> {
    const target = this.resolve(sandboxId, path);
    const { workdir } = this.sandboxes.record(sandboxId);
    if (target === '/' || target === workdir) throw new CocoonError('bad_request', t('error.cannotDeleteDir'));
    await this.sandboxes.sh(sandboxId, 'rm -rf -- "$P"', { P: target });
  }

  async archive(sandboxId: string, path: string): Promise<Readable> {
    return this.driver.getArchive(this.sandboxes.runningHandle(sandboxId), this.resolve(sandboxId, path));
  }

  // ── repositories ───────────────────────────────────────────────────────────

  /**
   * The repository a git operation targets: the given folder, or the only repository. With several repositories
   * and no folder given, the caller must choose.
   */
  private repo(sandboxId: string, path: string | undefined): { repo?: SandboxRepo; dir: string } {
    const record = this.sandboxes.record(sandboxId);
    const repos = reposOf(record);
    const dirOf = (repo?: SandboxRepo) => (repo?.path ? posix.join(record.workdir, repo.path) : record.workdir);
    if (path !== undefined) {
      const wanted = path.replace(/^\.\/?|\/+$/g, '');
      const repo = repos.find((r) => r.path === wanted);
      if (repo) return { repo, dir: dirOf(repo) };
      // The workspace folder itself (sandboxes without a repository have an empty baseline repository there).
      if (wanted === '' && !repos.some((r) => r.path === '')) return { dir: record.workdir };
      throw new CocoonError('not_found', t('error.repoNotFound', { path: path || '.', repos: repos.map((r) => r.path || '.').join(', ') }));
    }
    if (repos.length <= 1) return { repo: repos[0], dir: dirOf(repos[0]) };
    throw new CocoonError('bad_request', t('error.repoRequired', { repos: repos.map((r) => r.path || '.').join(', ') }));
  }

  /** Runs a shell script inside a repository folder. */
  private git(sandboxId: string, dir: string, script: string, env: Record<string, string> = {}, timeoutMs?: number): Promise<string> {
    return this.sandboxes.sh(sandboxId, `cd "$REPO_DIR" && { ${script}
}`, { REPO_DIR: dir, ...env }, timeoutMs);
  }

  async repos(sandboxId: string): Promise<MethodResult<'git.repos'>> {
    const record = this.sandboxes.record(sandboxId);
    const repos = reposOf(record);
    const targets = repos.length ? repos : [{ path: '', url: undefined } as Partial<SandboxRepo> & { path: string }];
    return Promise.all(
      targets.map(async (repo) => {
        const dir = repo.path ? posix.join(record.workdir, repo.path) : record.workdir;
        const pushedBranch = record.pushedBranches?.[repo.path] ?? (repo.path ? undefined : record.pushedBranch);
        try {
          const out = await this.git(sandboxId, dir, 'git rev-parse --abbrev-ref HEAD; git rev-parse --short HEAD; git status --porcelain=v1 -uall | wc -l');
          const [branch = '', head = '', changes = '0'] = out.split('\n');
          return { path: repo.path, url: repo.url, branch, head, changes: Number(changes.trim()), pushedBranch };
        } catch (err) {
          return { path: repo.path, url: repo.url, branch: '', head: '', changes: 0, pushedBranch, error: (err as Error).message };
        }
      }),
    );
  }

  // ── patches ────────────────────────────────────────────────────────────────

  async diff(sandboxId: string, path?: string): Promise<MethodResult<'sandbox.diff'>> {
    const repos = reposOf(this.sandboxes.record(sandboxId));
    if (path !== undefined || repos.length <= 1) {
      const { dir } = this.repo(sandboxId, path);
      return this.repoDiff(sandboxId, dir, '');
    }
    // Several repositories: one patch whose paths start with the repository folder (applies from the workspace folder).
    const parts = await Promise.all(repos.map(async (repo) => ({ repo, ...(await this.repoDiff(sandboxId, this.repo(sandboxId, repo.path).dir, repo.path)) })));
    return {
      patch: parts.map((p) => p.patch).join(''),
      files: parts.flatMap((p) => p.files),
      repos: parts.map((p) => ({ path: p.repo.path, files: p.files.map((f) => (p.repo.path ? f.slice(p.repo.path.length + 1) : f)) })),
    };
  }

  private async repoDiff(sandboxId: string, dir: string, prefix: string): Promise<{ patch: string; files: string[] }> {
    const p = prefix ? `${prefix}/` : '';
    const out = await this.git(
      sandboxId,
      dir,
      `git add -A && git diff --cached --binary --src-prefix="a/$P" --dst-prefix="b/$P" ${BASELINE_TAG} && printf '\\0' && git diff --cached --name-only ${BASELINE_TAG}`,
      { P: p },
    );
    const sep = out.lastIndexOf('\0');
    return { patch: out.slice(0, sep), files: out.slice(sep + 1).split('\n').filter(Boolean).map((f) => p + f) };
  }

  async applyPatch(sandboxId: string, patch: string, path?: string): Promise<MethodResult<'sandbox.apply_patch'>> {
    const { dir } = this.repo(sandboxId, path);
    const file = `${STAGING_DIR}/patch-${randomBytes(6).toString('hex')}.patch`;
    await this.write({ sandboxId, path: file, content: patch, encoding: 'utf8' });
    const res = await this.sandboxes.exec(sandboxId, ['sh', '-c', 'cd "$REPO_DIR" && git apply --whitespace=nowarn "$F"; code=$?; rm -f "$F"; exit $code'], {
      env: { F: file, REPO_DIR: dir },
    });
    return { applied: res.exitCode === 0, output: (res.stdout + res.stderr).trim() };
  }

  // ── git ────────────────────────────────────────────────────────────────────

  async gitStatus(sandboxId: string, path?: string): Promise<MethodResult<'git.status'>> {
    const { repo, dir } = this.repo(sandboxId, path);
    const record = this.sandboxes.record(sandboxId);
    const out = await this.git(
      sandboxId,
      dir,
      `git rev-parse --abbrev-ref HEAD; git rev-parse --short HEAD; git remote get-url origin 2>/dev/null || echo; git status --porcelain=v1 -uall`,
    );
    const [branch = '', head = '', remote = '', ...rest] = out.split('\n');
    return {
      branch,
      head,
      remoteUrl: remote || undefined,
      pushedBranch: record.pushedBranches?.[repo?.path ?? ''] ?? (repo?.path ? undefined : record.pushedBranch),
      files: rest.filter(Boolean).map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) })),
    };
  }

  async commit(sandboxId: string, message: string, path?: string): Promise<string> {
    const { dir } = this.repo(sandboxId, path);
    const out = await this.git(
      sandboxId,
      dir,
      'git add -A && { git diff --cached --quiet && { echo "$EMPTY" >&2; exit 1; } || true; } && git commit -q -m "$MSG" && git rev-parse --short HEAD',
      { MSG: message, EMPTY: t('error.nothingToCommit') },
    );
    return out.trim();
  }

  async push(sandboxId: string, branch: string, path?: string): Promise<MethodResult<'git.push'>> {
    const { repo, dir } = this.repo(sandboxId, path);
    const { remoteUrl } = await this.gitStatus(sandboxId, path);
    if (!remoteUrl) throw new CocoonError('bad_request', t('error.noRemote'));
    const token = this.secrets.resolve('GITHUB_TOKEN');
    if (!token && remoteUrl.includes('github.com')) {
      throw new CocoonError('bad_request', t('error.pushNeedsToken'));
    }
    await this.git(sandboxId, dir, 'git push --quiet origin "HEAD:refs/heads/$BRANCH"', { BRANCH: branch, ...githubAuthEnv(remoteUrl, token) }, 300_000);
    const record = this.sandboxes.record(sandboxId);
    const key = repo?.path ?? '';
    this.sandboxes.update(sandboxId, { pushedBranches: { ...record.pushedBranches, [key]: branch }, ...(key ? {} : { pushedBranch: branch }) });
    return { branch, remoteUrl };
  }

  async createPullRequest({ sandboxId, branch, title, body, base, repo: path }: MethodParams<'git.create_pr'>): Promise<MethodResult<'git.create_pr'>> {
    const { remoteUrl } = await this.gitStatus(sandboxId, path);
    const repo = remoteUrl && parseGithubRepo(remoteUrl);
    if (!repo) throw new CocoonError('bad_request', t('error.prGithubOnly'));
    const token = this.secrets.resolve('GITHUB_TOKEN');
    if (!token) throw new CocoonError('bad_request', t('error.prNeedsToken'));

    const gh = async (path: string, init?: RequestInit) => {
      const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const errors = Array.isArray(json.errors) ? ` (${json.errors.map((e: { message?: string }) => e.message).join(', ')})` : '';
        throw new CocoonError('bad_request', t('error.github', { message: `${String(json.message ?? res.status)}${errors}` }));
      }
      return json;
    };
    const baseBranch = base ?? String((await gh(''))['default_branch']);
    const pr = await gh('/pulls', { method: 'POST', body: JSON.stringify({ title, body: body ?? '', head: branch, base: baseBranch }) });
    return { url: String(pr.html_url), number: Number(pr.number) };
  }

  /** Switches every repository of the sandbox to a new branch (keeps the work; used for task sandboxes). */
  async checkoutBranch(sandboxId: string, branch: string): Promise<void> {
    const record = this.sandboxes.record(sandboxId);
    const paths = reposOf(record).map((r) => r.path);
    for (const path of paths.length ? paths : ['']) {
      const { dir } = this.repo(sandboxId, path);
      await this.git(sandboxId, dir, 'git checkout -q -B "$BRANCH"', { BRANCH: branch });
    }
  }

  /**
   * Opens a pull request, or returns the open one for the branch if it already exists (e.g. opened by a review agent).
   * Repositories outside GitHub get no pull request (undefined) – the pushed branch is all there is.
   */
  async ensurePullRequest(params: MethodParams<'git.create_pr'>): Promise<MethodResult<'git.create_pr'> | undefined> {
    const { remoteUrl } = await this.gitStatus(params.sandboxId, params.repo);
    if (!remoteUrl || !parseGithubRepo(remoteUrl)) return undefined;
    try {
      return await this.createPullRequest(params);
    } catch (err) {
      if (!/already exists/i.test((err as Error).message)) throw err;
      const { remoteUrl } = await this.gitStatus(params.sandboxId, params.repo);
      const repo = remoteUrl && parseGithubRepo(remoteUrl);
      const token = this.secrets.resolve('GITHUB_TOKEN');
      if (!repo || !token) throw err;
      const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls?state=open&head=${repo.owner}:${encodeURIComponent(params.branch)}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      });
      const [pr] = (await res.json().catch(() => [])) as { html_url?: string; number?: number }[];
      if (!pr?.html_url) throw err;
      return { url: pr.html_url, number: Number(pr.number) };
    }
  }

  /**
   * Commits all changes of every repository and pushes the ones with new commits to `branch`.
   * Throws (and pushes nothing further) if a repository with work in it cannot be pushed, so no work gets lost.
   */
  async publish(sandboxId: string, message: string, branch: string): Promise<{ pushed: string[] }> {
    const record = this.sandboxes.record(sandboxId);
    const paths = reposOf(record).map((r) => r.path);
    const pushed: string[] = [];
    for (const path of paths.length ? paths : ['']) {
      const { dir } = this.repo(sandboxId, path);
      const ahead = await this.git(
        sandboxId,
        dir,
        `git add -A && { git diff --cached --quiet || git commit -q -m "$MSG"; } && git rev-list --count ${BASELINE_TAG}..HEAD`,
        { MSG: message },
      );
      if (Number(ahead.trim()) === 0) continue;
      await this.push(sandboxId, branch, path);
      pushed.push(path);
    }
    return { pushed };
  }

  private async owner(sandboxId: string): Promise<{ uid: number; gid: number }> {
    const cached = this.owners.get(sandboxId);
    if (cached) return cached;
    const [uid = '0', gid = '0'] = (await this.sandboxes.sh(sandboxId, 'id -u; id -g')).trim().split('\n');
    const owner = { uid: Number(uid), gid: Number(gid) };
    this.owners.set(sandboxId, owner);
    return owner;
  }
}

function decodeUtf8(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
