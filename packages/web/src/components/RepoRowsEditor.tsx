import type { ReactNode } from 'react';
import { repoFolderName } from '@cocoon/protocol';
import { FolderGit2, Plus, X } from 'lucide-react';
import { useT } from '../i18n';
import { emptyRepoRow, plannedPaths, repoDir, type RepoRow, type RepoRowErrors } from '../lib/repos';
import { Button, IconButton } from './Button';
import { Field, Input } from './Field';

const MAX_REPOS = 20;

/**
 * Editor for the repositories of a sandbox or workspace. With one row it looks like the classic URL + branch fields;
 * "+ Weiteres Repository" turns it into a list where every repository gets its own folder.
 */
export function RepoRowsEditor({
  rows,
  onChange,
  errors = [],
  urlHint,
  workdir,
  idPrefix = 'repo',
}: {
  rows: RepoRow[];
  onChange: (rows: RepoRow[]) => void;
  errors?: RepoRowErrors[];
  /** Hint under the URL field in single-repository mode. */
  urlHint?: ReactNode;
  workdir?: string;
  idPrefix?: string;
}) {
  const t = useT();
  const multi = rows.length > 1;
  const update = (i: number, patch: Partial<RepoRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const add = () => onChange([...rows, emptyRepoRow()]);
  const paths = plannedPaths(rows);
  const layout = rows.flatMap((r, i) => (r.url.trim() && paths[i] !== undefined ? [{ url: r.url.trim(), dir: repoDir(paths[i]!, workdir) }] : []));

  if (!multi) {
    const r = rows[0] ?? emptyRepoRow();
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <Field label={t('wizard.repoLabel')} optional htmlFor={`${idPrefix}-url-0`} error={errors[0]?.url} hint={urlHint}>
            <Input
              id={`${idPrefix}-url-0`}
              value={r.url}
              placeholder={t('wizard.repoPlaceholder')}
              invalid={!!errors[0]?.url}
              onChange={(e) => onChange([{ ...r, url: e.target.value }])}
            />
          </Field>
          <Field label={t('wizard.branchLabel')} optional htmlFor={`${idPrefix}-ref-0`}>
            <Input id={`${idPrefix}-ref-0`} value={r.ref} onChange={(e) => onChange([{ ...r, ref: e.target.value }])} placeholder="main" disabled={!r.url.trim()} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={add} disabled={!r.url.trim()} className="-ml-2.5">
            {t('repoRows.add')}
          </Button>
          <span className="text-xs text-fg-muted">{t('repoRows.explain')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-fg-muted">{t('repoRows.explain')}</p>
      {rows.map((r, i) => {
        const e = errors[i] ?? {};
        return (
          <div key={i} className="rounded-xl border border-line px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <FolderGit2 className="size-4 text-fg-muted" />
              <span className="flex-1 text-sm font-medium text-fg">{t('repoRows.item', { n: i + 1 })}</span>
              <IconButton label={t('repoRows.remove')} size="sm" variant="ghost" onClick={() => remove(i)} icon={<X className="size-3.5" />} />
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_130px_150px]">
              <Field label={t('repoRows.url')} htmlFor={`${idPrefix}-url-${i}`} error={e.url}>
                <Input id={`${idPrefix}-url-${i}`} value={r.url} placeholder={t('wizard.repoPlaceholder')} invalid={!!e.url} onChange={(ev) => update(i, { url: ev.target.value })} />
              </Field>
              <Field label={t('wizard.branchLabel')} optional htmlFor={`${idPrefix}-ref-${i}`}>
                <Input id={`${idPrefix}-ref-${i}`} value={r.ref} placeholder="main" onChange={(ev) => update(i, { ref: ev.target.value })} />
              </Field>
              <Field label={t('repoRows.folder')} optional htmlFor={`${idPrefix}-path-${i}`} error={e.path}>
                <Input
                  id={`${idPrefix}-path-${i}`}
                  value={r.path}
                  className="font-mono"
                  placeholder={r.url.trim() ? repoFolderName(r.url.trim()) : t('repoRows.folderPlaceholder')}
                  invalid={!!e.path}
                  onChange={(ev) => update(i, { path: ev.target.value })}
                />
              </Field>
            </div>
          </div>
        );
      })}
      <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={add} disabled={rows.length >= MAX_REPOS} className="-ml-2.5">
        {t('repoRows.add')}
      </Button>
      {layout.length > 0 && <RepoLayoutPreview items={layout} />}
    </div>
  );
}

/** "So sieht dein Projektordner aus": folder → URL. */
export function RepoLayoutPreview({ items }: { items: Array<{ dir: string; url: string }> }) {
  const t = useT();
  return (
    <div className="rounded-xl bg-surface-2/70 px-4 py-3">
      <div className="mb-1.5 text-xs font-medium tracking-wide text-fg-subtle uppercase">{t('repoRows.layout')}</div>
      <ul className="space-y-1">
        {items.map((x, i) => (
          <li key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-mono text-[13px] text-fg">{x.dir}</span>
            <span className="min-w-0 truncate text-xs text-fg-muted">← {x.url}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
