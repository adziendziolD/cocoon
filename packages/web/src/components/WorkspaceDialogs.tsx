import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Sandbox, Workspace } from '@cocoon/protocol';
import { FolderInput, Inbox } from 'lucide-react';
import { qk } from '../api/keys';
import { useSandboxes, useTasks, useWorkspaces } from '../api/queries';
import { rpc } from '../api/rpc';
import { useAction } from '../api/useAction';
import { rich, useT } from '../i18n';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { ConfirmDialog, Dialog } from './Dialog';
import { Checkbox } from './Field';
import { Callout } from './HelpText';
import { SandboxStatusBadge } from './Badge';
import { WorkspaceDot } from './WorkspaceSwitcher';

/** Moves one sandbox into another workspace (or makes it unassigned). */
export function MoveSandboxDialog({ sandbox, open, onClose }: { sandbox: Sandbox | null; open: boolean; onClose: () => void }) {
  const t = useT();
  const workspaces = useWorkspaces();
  const [target, setTarget] = useState<string>('');
  useEffect(() => {
    if (open) setTarget(sandbox?.workspaceId ?? '');
  }, [open, sandbox]);

  const move = useAction((workspaceId: string) => rpc('sandbox.update', { sandboxId: sandbox!.id, workspaceId: workspaceId || null }), {
    success: (s) => t('moveSandbox.moved', { name: s.name }),
    error: t('moveSandbox.failed'),
    invalidate: [qk.sandboxes],
    onSuccess: () => onClose(),
  });

  const options: Array<{ id: string; name: string; ws?: Workspace }> = [
    { id: '', name: t('workspace.unassigned') },
    ...(workspaces.data ?? []).map((w) => ({ id: w.id, name: w.name, ws: w })),
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={t('moveSandbox.title')}
      description={sandbox ? rich(t('moveSandbox.description'), { name: <strong className="text-fg">{sandbox.name}</strong> }) : undefined}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            icon={<FolderInput className="size-4" />}
            loading={move.isPending}
            disabled={!sandbox || target === (sandbox.workspaceId ?? '')}
            onClick={() => move.mutate(target)}
          >
            {t('moveSandbox.move')}
          </Button>
        </>
      }
    >
      <div className="space-y-1.5" role="radiogroup">
        {options.map((o) => (
          <button
            key={o.id || '_none'}
            type="button"
            role="radio"
            aria-checked={target === o.id}
            onClick={() => setTarget(o.id)}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm',
              target === o.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2',
            )}
          >
            {o.ws ? <WorkspaceDot workspace={o.ws} /> : <Inbox className="size-4 text-fg-muted" />}
            <span className="flex-1 truncate text-fg">{o.name}</span>
            {sandbox?.workspaceId === o.id || (!sandbox?.workspaceId && !o.id) ? <span className="text-xs text-fg-subtle">{t('moveSandbox.current')}</span> : null}
          </button>
        ))}
      </div>
      {sandbox?.taskId && (
        <Callout tone="info" className="mt-3">
          {t('moveSandbox.taskHint')}
        </Callout>
      )}
    </Dialog>
  );
}

/** Lets the user pick existing sandboxes (from other workspaces / unassigned) and moves them into `workspace`. */
export function AddSandboxesDialog({ workspace, open, onClose }: { workspace: Workspace; open: boolean; onClose: () => void }) {
  const t = useT();
  const sandboxes = useSandboxes();
  const workspaces = useWorkspaces();
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    if (open) setPicked([]);
  }, [open]);
  const candidates = (sandboxes.data ?? []).filter((s) => s.workspaceId !== workspace.id);

  const move = useAction(
    async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((sandboxId) => rpc('sandbox.update', { sandboxId, workspaceId: workspace.id })));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
      return ids.length;
    },
    {
      success: (count) => t('moveSandbox.movedMany', { count, name: workspace.name }),
      error: t('moveSandbox.failed'),
      invalidate: [qk.sandboxes],
      onSuccess: () => onClose(),
    },
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('moveSandbox.addTitle', { name: workspace.name })}
      description={t('moveSandbox.addDescription')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={<FolderInput className="size-4" />} loading={move.isPending} disabled={!picked.length} onClick={() => move.mutate(picked)}>
            {t('moveSandbox.addSubmit', { count: picked.length })}
          </Button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('moveSandbox.noCandidates')}</p>
      ) : (
        <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto">
          {candidates.map((s) => {
            const ws = workspaces.data?.find((w) => w.id === s.workspaceId);
            return (
              <li key={s.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                <Checkbox
                  checked={picked.includes(s.id)}
                  onChange={(on) => setPicked((p) => (on ? [...p, s.id] : p.filter((x) => x !== s.id)))}
                  label={<span className="font-medium">{s.name}</span>}
                  description={
                    <span className="inline-flex items-center gap-1.5">
                      {ws ? <WorkspaceDot workspace={ws} className="size-2" /> : null}
                      {ws ? ws.name : t('workspace.unassigned')}
                    </span>
                  }
                />
                <span className="flex-1" />
                <SandboxStatusBadge status={s.status} />
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

/** Confirms deleting a workspace; optionally deletes its sandboxes too. */
export function DeleteWorkspaceDialog({ workspace, open, onClose }: { workspace: Workspace | null; open: boolean; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const sandboxes = useSandboxes();
  const tasks = useTasks();
  const [deleteSandboxes, setDeleteSandboxes] = useState(false);
  useEffect(() => {
    if (open) setDeleteSandboxes(false);
  }, [open]);
  const sbCount = workspace ? (sandboxes.data ?? []).filter((s) => s.workspaceId === workspace.id).length : 0;
  const taskCount = workspace ? (tasks.data ?? []).filter((x) => x.workspaceId === workspace.id).length : 0;

  const del = useAction((v: { id: string; deleteSandboxes: boolean }) => rpc('workspace.delete', { workspaceId: v.id, deleteSandboxes: v.deleteSandboxes }), {
    success: t('workspaceDelete.done', { name: workspace?.name ?? '' }),
    error: t('common.deleteFailed'),
    invalidate: [qk.workspaces, qk.tasks, qk.sandboxes],
    onSuccess: () => {
      onClose();
      navigate('/workspaces');
    },
  });

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      danger
      loading={del.isPending}
      title={t('workspaceDelete.title')}
      confirmLabel={t('workspaceDelete.confirm')}
      typeToConfirm={deleteSandboxes ? workspace?.name : undefined}
      onConfirm={() => workspace && del.mutate({ id: workspace.id, deleteSandboxes })}
      message={
        <div className="space-y-3">
          <p>{rich(t('workspaceDelete.text', { tasks: taskCount }), { name: <strong className="text-fg">{workspace?.name}</strong> })}</p>
          {sbCount > 0 && (
            <Checkbox
              checked={deleteSandboxes}
              onChange={setDeleteSandboxes}
              label={t('workspaceDelete.alsoSandboxes', { count: sbCount })}
              description={deleteSandboxes ? t('workspaceDelete.alsoSandboxesWarn') : t('workspaceDelete.keepSandboxes')}
            />
          )}
        </div>
      }
    />
  );
}
