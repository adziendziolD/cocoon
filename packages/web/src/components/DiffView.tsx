import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileDiff as FileDiffIcon, FolderGit2 } from 'lucide-react';
import { useT } from '../i18n';
import { cn } from '../lib/cn';

interface FileDiff {
  path: string;
  lines: string[];
  added: number;
  removed: number;
  binary: boolean;
}

/** Splits a unified git patch into per-file sections. */
export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of patch.split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      cur = { path: m[2]!, lines: [], added: 0, removed: 0, binary: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.lines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) cur.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) cur.removed++;
    else if (line.startsWith('Binary files') || line === 'GIT binary patch') cur.binary = true;
  }
  return files;
}

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-fg-subtle';
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300';
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-800 dark:text-red-300';
  if (line.startsWith('@@')) return 'bg-blue-500/5 text-blue-700 dark:text-blue-300';
  if (/^(index |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) return 'text-fg-subtle';
  return 'text-fg';
}

/**
 * A unified patch, one collapsible section per file. With `groups` (repository folders, '' = the project folder
 * itself) the files of a combined multi-repository patch are shown per repository, paths relative to it.
 */
export function DiffView({ patch, groups, groupLabel }: { patch: string; groups?: string[]; groupLabel?: (path: string) => ReactNode }) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  const grouped = useMemo(() => {
    if (!groups) return null;
    const folders = [...groups].filter(Boolean).sort((a, b) => b.length - a.length);
    const byGroup = new Map<string, FileDiff[]>(groups.map((g) => [g, []]));
    for (const f of files) {
      const g = folders.find((x) => f.path.startsWith(`${x}/`)) ?? '';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(f);
    }
    return [...byGroup].filter(([, list]) => list.length);
  }, [files, groups]);

  if (grouped) {
    return (
      <div className="space-y-5">
        {grouped.map(([group, list]) => (
          <section key={group} className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
              <FolderGit2 className="size-4 text-fg-muted" />
              {groupLabel ? groupLabel(group) : group}
              <span className="font-normal text-fg-subtle">· {list.length}</span>
            </h3>
            {list.map((f) => (
              <FileSection key={f.path} file={f} label={group ? f.path.slice(group.length + 1) : f.path} defaultOpen={files.length <= 8} />
            ))}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {files.map((f) => (
        <FileSection key={f.path} file={f} defaultOpen={files.length <= 8} />
      ))}
    </div>
  );
}

function FileSection({ file, defaultOpen, label }: { file: FileDiff; defaultOpen: boolean; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  // Hide the noisy header lines (index …, ---/+++) – the file name is shown above.
  const body = file.lines.filter((l) => !/^(index |--- |\+\+\+ )/.test(l));
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 bg-surface-2/60 px-4 py-2.5 text-left text-sm hover:bg-surface-2">
        {open ? <ChevronDown className="size-4 text-fg-subtle" /> : <ChevronRight className="size-4 text-fg-subtle" />}
        <FileDiffIcon className="size-4 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{label ?? file.path}</span>
        {file.binary ? (
          <span className="text-xs text-fg-subtle">{t('diff.binary')}</span>
        ) : (
          <span className="font-mono text-xs">
            <span className="text-emerald-600">+{file.added}</span> <span className="text-red-600">−{file.removed}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-line">
          {file.binary ? (
            <div className="px-4 py-3 text-sm text-fg-muted">{t('diff.binaryChanged')}</div>
          ) : (
            <pre className="min-w-fit font-mono text-[12.5px] leading-[1.55]">
              {body.map((l, i) => (
                <div key={i} className={cn('px-4 whitespace-pre', lineClass(l))}>
                  {l || ' '}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
