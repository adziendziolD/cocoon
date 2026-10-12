import { planRepos, REPO_PATH, type RepoSource } from '@cocoon/protocol';
import type { TFunction } from '../i18n';
import { isRepoUrl } from './sandboxForm';

/** Default project folder inside a sandbox (the server setting can differ; sandboxes carry their own workdir). */
export const DEFAULT_WORKDIR = '/workspace';

/** One editable repository row (wizard, workspace form). Empty strings = not set. */
export interface RepoRow {
  url: string;
  ref: string;
  path: string;
}

export const emptyRepoRow = (): RepoRow => ({ url: '', ref: '', path: '' });

/** Rows for existing repositories (falls back to the older single `repo`); always at least one row. */
export function repoRowsFrom(repos?: RepoSource[], repo?: RepoSource): RepoRow[] {
  const list = repos?.length ? repos : repo ? [repo] : [];
  return list.length ? list.map((r) => ({ url: r.url, ref: r.ref ?? '', path: r.path ?? '' })) : [emptyRepoRow()];
}

export const hasRepoRows = (rows: RepoRow[]) => rows.some((r) => r.url.trim());

const cleanPath = (p: string) => p.trim().replace(/^\/+|\/+$/g, '');

/**
 * Repositories to send to the server. Rows without a URL are skipped. A single repository never gets a folder,
 * so it is cloned into the project folder itself (as before multi-repo support).
 */
export function reposFromRows(rows: RepoRow[]): RepoSource[] {
  const filled = rows.filter((r) => r.url.trim());
  return filled.map((r) => ({
    url: r.url.trim(),
    ref: r.ref.trim() || undefined,
    path: filled.length > 1 ? cleanPath(r.path) || undefined : undefined,
  }));
}

/** Where each row ends up ('' = the project folder itself); undefined for rows without a URL. */
export function plannedPaths(rows: RepoRow[]): Array<string | undefined> {
  const planned = planRepos(reposFromRows(rows));
  let i = 0;
  return rows.map((r) => (r.url.trim() ? planned[i++]?.path : undefined));
}

export interface RepoRowErrors {
  url?: string;
  path?: string;
}

/** Per-row errors: invalid URL, invalid folder name, folders used twice or nested in each other. */
export function validateRepoRows(t: TFunction, rows: RepoRow[]): RepoRowErrors[] {
  const paths = plannedPaths(rows);
  const multi = rows.filter((r) => r.url.trim()).length > 1;
  return rows.map((r, i) => {
    const e: RepoRowErrors = {};
    if (r.url.trim() && !isRepoUrl(r.url)) e.url = t('wizard.repoError');
    const own = cleanPath(r.path);
    if (multi && own && !REPO_PATH.test(own)) e.path = t('repoRows.err.folder');
    const p = paths[i];
    if (!e.path && p !== undefined && multi) {
      const clash = paths.some((o, j) => j !== i && o !== undefined && (o === p || o.startsWith(`${p}/`) || p.startsWith(`${o}/`)));
      if (clash) e.path = t('repoRows.err.duplicate', { path: p });
    }
    return e;
  });
}

export const hasRepoErrors = (errors: RepoRowErrors[]) => errors.some((e) => e.url || e.path);

/** Absolute folder of a repository path inside the project folder. */
export const repoDir = (path: string, workdir = DEFAULT_WORKDIR) => (path ? `${workdir}/${path}` : workdir);

/** Short label for a repository folder ('' = the project folder itself). */
export const repoLabel = (t: TFunction, path: string) => path || t('repoRows.rootFolder');
