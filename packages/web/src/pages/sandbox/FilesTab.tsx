import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntry, Sandbox } from '@cocoon/protocol';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Download,
  File,
  FileSymlink,
  Folder,
  FolderPlus,
  FilePlus,
  House,
  RefreshCw,
  Save,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { qk } from '../../api/keys';
import { useFile, useFiles } from '../../api/queries';
import { archiveUrl, describeError, rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { buttonClasses, Button, IconButton } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { Checkbox, Field, Input } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { ErrorState, LoadingState, Spinner } from '../../components/States';
import { useToast } from '../../components/Toast';
import { fileToBase64 } from '../../lib/base64';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { rich, useLanguage, useT } from '../../i18n';

const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`;
const parentOf = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };
const MAX_UPLOAD = 20 * 1024 * 1024;

export function FilesTab({ sandbox }: { sandbox: Sandbox }) {
  const root = sandbox.workdir || '/workspace';
  const [dir, setDir] = useState(root);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [newItem, setNewItem] = useState<'file' | 'dir' | null>(null);
  const [toDelete, setToDelete] = useState<{ path: string; isDir: boolean } | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT();
  const { locale } = useLanguage();
  const files = useFiles(sandbox.id, dir);

  const entries = useMemo(() => {
    const list = (files.data?.entries ?? []).filter((e) => showHidden || !e.name.startsWith('.'));
    return list.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name, locale, { numeric: true }));
  }, [files.data, showHidden, locale]);
  const hiddenCount = (files.data?.entries ?? []).filter((e) => e.name.startsWith('.')).length;

  const confirmDiscard = () => !dirty || window.confirm(t('files.confirmDiscard'));

  const openEntry = (e: FileEntry) => {
    const p = joinPath(dir, e.name);
    if (e.type === 'dir') {
      setDir(p);
    } else if (confirmDiscard()) {
      setSelected(p);
      setDirty(false);
    }
  };

  const refreshDir = () => qc.invalidateQueries({ queryKey: qk.filesAll(sandbox.id) });

  const del = useAction((path: string) => rpc('files.delete', { sandboxId: sandbox.id, path }), {
    success: (_, path) => t('files.delete.success', { name: baseName(path) }),
    error: t('files.delete.error'),
    invalidate: [qk.filesAll(sandbox.id), qk.git(sandbox.id), qk.diff(sandbox.id)],
    onSuccess: (_, path) => {
      if (selected && (selected === path || selected.startsWith(path + '/'))) setSelected(null);
      setToDelete(null);
    },
  });

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    let ok = 0;
    for (const file of Array.from(list)) {
      if (file.size > MAX_UPLOAD) {
        toast.error(t('files.upload.tooLarge', { name: file.name }), t('files.upload.tooLargeHint', { max: formatBytes(MAX_UPLOAD) }));
        continue;
      }
      setUploading(file.name);
      try {
        const content = await fileToBase64(file);
        await rpc('files.write', { sandboxId: sandbox.id, path: joinPath(dir, file.name), content, encoding: 'base64' });
        ok++;
      } catch (err) {
        toast.error(t('files.upload.failed', { name: file.name }), describeError(err));
      }
    }
    setUploading(null);
    if (uploadRef.current) uploadRef.current.value = '';
    if (ok) toast.success(t('files.upload.success', { count: ok }));
    void refreshDir();
    void qc.invalidateQueries({ queryKey: qk.git(sandbox.id) });
  };

  // Breadcrumb segments relative to the workspace root.
  const rel = dir.startsWith(root) ? dir.slice(root.length).split('/').filter(Boolean) : dir.split('/').filter(Boolean);
  const crumbBase = dir.startsWith(root) ? root : '';

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(320px,420px)_1fr]">
      <Card className="flex min-h-[420px] flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
          <Button size="sm" icon={<Upload className="size-3.5" />} onClick={() => uploadRef.current?.click()} loading={!!uploading}>
            {t('files.upload')}
          </Button>
          <input ref={uploadRef} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
          <IconButton label={t('files.newFile')} icon={<FilePlus className="size-4" />} onClick={() => setNewItem('file')} />
          <IconButton label={t('files.newDir')} icon={<FolderPlus className="size-4" />} onClick={() => setNewItem('dir')} />
          <a href={archiveUrl(sandbox.id, dir)} download className={buttonClasses('ghost', 'sm', 'px-1.5')} title={t('files.downloadDir')}>
            <Download className="size-4" />
          </a>
          <IconButton label={t('files.refresh')} icon={<RefreshCw className={cn('size-4', files.isFetching && 'animate-spin')} />} onClick={() => refreshDir()} />
        </div>

        {/* Breadcrumbs */}
        <nav className="flex flex-wrap items-center gap-0.5 border-b border-line bg-surface-2/50 px-3 py-2 text-sm">
          <button onClick={() => setDir(root)} className="flex items-center gap-1 rounded px-1 text-fg-muted hover:bg-surface-2 hover:text-fg" title={root}>
            <House className="size-3.5" /> {t('files.root')}
          </button>
          {rel.map((seg, i) => {
            const p = joinPath(crumbBase || '/', rel.slice(0, i + 1).join('/'));
            return (
              <span key={p} className="flex items-center gap-0.5">
                <ChevronRight className="size-3.5 text-fg-subtle" />
                <button onClick={() => setDir(p)} className={cn('rounded px-1 hover:bg-surface-2', i === rel.length - 1 ? 'font-medium text-fg' : 'text-fg-muted')}>
                  {seg}
                </button>
              </span>
            );
          })}
        </nav>

        {uploading && (
          <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm text-fg-muted">
            <Spinner /> {t('files.uploading', { name: uploading })}
          </div>
        )}

        {/* Listing */}
        <div className="flex-1 overflow-y-auto">
          {files.isLoading ? (
            <LoadingState />
          ) : files.error ? (
            <ErrorState error={files.error} onRetry={() => files.refetch()} className="m-3" />
          ) : (
            <ul>
              {dir !== root && dir !== '/' && (
                <li>
                  <button onClick={() => setDir(parentOf(dir))} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-fg-muted hover:bg-surface-2">
                    <Folder className="size-4 text-fg-subtle" /> ..
                  </button>
                </li>
              )}
              {entries.map((e) => {
                const p = joinPath(dir, e.name);
                return (
                  <li key={e.name} className={cn('group flex items-center', selected === p && 'bg-accent-soft')}>
                    <button onClick={() => openEntry(e)} className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-surface-2/70">
                      {e.type === 'dir' ? (
                        <Folder className="size-4 shrink-0 fill-sky-400/30 text-sky-500" />
                      ) : e.type === 'symlink' ? (
                        <FileSymlink className="size-4 shrink-0 text-fg-subtle" />
                      ) : (
                        <File className="size-4 shrink-0 text-fg-subtle" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-fg">{e.name}</span>
                      <span className="shrink-0 text-xs text-fg-subtle">{e.type === 'dir' ? '' : formatBytes(e.size)}</span>
                    </button>
                    <button
                      onClick={() => setToDelete({ path: p, isDir: e.type === 'dir' })}
                      className="mr-2 rounded p-1 text-fg-subtle opacity-0 group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-600 focus:opacity-100"
                      aria-label={t('files.deleteItem', { name: e.name })}
                      title={t('common.delete')}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                );
              })}
              {entries.length === 0 && <li className="px-4 py-8 text-center text-sm text-fg-muted">{t('files.emptyDir')}</li>}
            </ul>
          )}
        </div>
        {hiddenCount > 0 && (
          <div className="border-t border-line px-3 py-2">
            <Checkbox checked={showHidden} onChange={setShowHidden} label={t('files.showHidden', { count: hiddenCount })} />
          </div>
        )}
      </Card>

      <div className="min-w-0">
        {selected ? (
          <FileViewer
            key={selected}
            sandbox={sandbox}
            path={selected}
            onDirty={setDirty}
            onClose={() => confirmDiscard() && (setSelected(null), setDirty(false))}
            onDelete={() => setToDelete({ path: selected, isDir: false })}
          />
        ) : (
          <EmptyState icon={<File className="size-6" />} title={t('files.noSelection.title')} className="h-full justify-center">
            {t('files.noSelection.text')}
          </EmptyState>
        )}
      </div>

      <NewItemDialog
        kind={newItem}
        sandbox={sandbox}
        dir={dir}
        onClose={() => setNewItem(null)}
        onCreated={(path, kind) => {
          void refreshDir();
          if (kind === 'file') {
            setSelected(path);
            setDirty(false);
          }
        }}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.path)}
        loading={del.isPending}
        danger
        title={toDelete?.isDir ? t('files.deleteDialog.dirTitle') : t('files.deleteDialog.fileTitle')}
        confirmLabel={t('common.delete')}
        message={rich(t(toDelete?.isDir ? 'files.deleteDialog.dirMessage' : 'files.deleteDialog.fileMessage'), {
          name: <span className="font-mono text-fg">{toDelete && baseName(toDelete.path)}</span>,
        })}
      />
    </div>
  );
}

function FileViewer({ sandbox, path, onDirty, onClose, onDelete }: { sandbox: Sandbox; path: string; onDirty: (d: boolean) => void; onClose: () => void; onDelete: () => void }) {
  const t = useT();
  const file = useFile(sandbox.id, path);
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const original = file.data?.encoding === 'utf8' ? file.data.content : null;
  const dirty = text !== null && text !== original;

  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    setText(original);
  }, [original]);

  const save = useAction((content: string) => rpc('files.write', { sandboxId: sandbox.id, path, content, encoding: 'utf8' }), {
    success: t('files.viewer.saved'),
    error: t('common.saveFailed'),
    invalidate: [qk.filesAll(sandbox.id), qk.git(sandbox.id), qk.diff(sandbox.id)],
    onSuccess: (_, content) => {
      if (file.data) qc.setQueryData(qk.file(sandbox.id, path), { ...file.data, content, size: new Blob([content]).size });
    },
  });

  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const canEdit = file.data?.encoding === 'utf8' && !file.data.truncated;

  return (
    <Card className="flex h-full min-h-[420px] flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <File className="size-4 text-fg-subtle" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm text-fg" title={path}>
            {baseName(path)}
            {dirty && <span className="ml-2 text-xs text-amber-600">{t('files.viewer.unsaved')}</span>}
          </div>
          {file.data && <div className="text-xs text-fg-subtle">{formatBytes(file.data.size)}</div>}
        </div>
        {canEdit && (
          <>
            <Button size="sm" icon={<Undo2 className="size-3.5" />} disabled={!dirty} onClick={() => setText(original)}>
              {t('common.discard')}
            </Button>
            <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={!dirty} loading={save.isPending} onClick={() => text !== null && save.mutate(text)}>
              {t('common.save')}
            </Button>
          </>
        )}
        <a href={archiveUrl(sandbox.id, path)} download className={buttonClasses('ghost', 'sm', 'px-1.5')} title={t('files.viewer.download')}>
          <Download className="size-4" />
        </a>
        <IconButton label={t('common.delete')} icon={<Trash2 className="size-4" />} onClick={onDelete} />
        <IconButton label={t('common.close')} icon={<X className="size-4" />} onClick={onClose} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {file.isLoading ? (
          <LoadingState />
        ) : file.error ? (
          <ErrorState error={file.error} onRetry={() => file.refetch()} className="m-4" />
        ) : !file.data ? null : file.data.encoding === 'utf8' ? (
          <>
            {file.data.truncated && (
              <Callout tone="warning" className="m-3">
                {t('files.viewer.truncated')}
              </Callout>
            )}
            <textarea
              value={text ?? ''}
              onChange={(e) => setText(e.target.value)}
              readOnly={!canEdit}
              spellCheck={false}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault();
                  if (dirty && text !== null) save.mutate(text);
                }
                if (e.key === 'Tab' && canEdit) {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const { selectionStart: a, selectionEnd: b } = el;
                  const next = el.value.slice(0, a) + '  ' + el.value.slice(b);
                  setText(next);
                  requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
                }
              }}
              className="min-h-[60vh] w-full flex-1 resize-none bg-surface p-4 font-mono text-[13px] leading-relaxed text-fg outline-none"
            />
          </>
        ) : IMAGE_MIME[ext] && file.data.size < 5_000_000 && !file.data.truncated ? (
          <div className="flex flex-1 items-center justify-center bg-[repeating-conic-gradient(var(--color-surface-2)_0_25%,transparent_0_50%)] bg-[length:20px_20px] p-6">
            <img src={`data:${IMAGE_MIME[ext]};base64,${file.data.content}`} alt={baseName(path)} className="max-h-[60vh] max-w-full rounded shadow" />
          </div>
        ) : (
          <EmptyState
            icon={<File className="size-6" />}
            title={t('files.viewer.binaryTitle')}
            className="m-4"
            action={
              <a href={archiveUrl(sandbox.id, path)} download className={buttonClasses('primary')}>
                <Download className="size-4" /> {t('files.viewer.downloadButton')}
              </a>
            }
          >
            {t('files.viewer.binaryText', { size: formatBytes(file.data.size) })}
          </EmptyState>
        )}
      </div>
    </Card>
  );
}

function NewItemDialog({
  kind,
  sandbox,
  dir,
  onClose,
  onCreated,
}: {
  kind: 'file' | 'dir' | null;
  sandbox: Sandbox;
  dir: string;
  onClose: () => void;
  onCreated: (path: string, kind: 'file' | 'dir') => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  useEffect(() => {
    setName('');
  }, [kind]);
  const invalid = !name.trim() || name.includes('..');

  const create = useAction(
    async ({ path, kind }: { path: string; kind: 'file' | 'dir' }) => {
      if (kind === 'file') return rpc('files.write', { sandboxId: sandbox.id, path, content: '' });
      return rpc('files.mkdir', { sandboxId: sandbox.id, path });
    },
    {
      success: (_, v) => (v.kind === 'file' ? t('files.newItem.fileCreated') : t('files.newItem.dirCreated')),
      error: t('files.newItem.error'),
      invalidate: [qk.git(sandbox.id)],
      onSuccess: (_, v) => {
        onCreated(v.path, v.kind);
        onClose();
      },
    },
  );

  const submit = () => !invalid && kind && create.mutate({ path: joinPath(dir, name.trim()), kind });

  return (
    <Dialog
      open={!!kind}
      onClose={onClose}
      size="sm"
      title={kind === 'dir' ? t('files.newDir') : t('files.newFile')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={invalid} loading={create.isPending}>
            {t('files.newItem.create')}
          </Button>
        </>
      }
    >
      <Field label={t('common.name')} hint={kind === 'dir' ? t('files.newItem.dirHint') : t('files.newItem.fileHint')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} className="font-mono" />
      </Field>
    </Dialog>
  );
}
