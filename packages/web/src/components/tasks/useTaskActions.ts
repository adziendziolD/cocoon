import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { MethodParams, Task } from '@cocoon/protocol';
import { qk } from '../../api/keys';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { useT } from '../../i18n';
import { setWorkspaceScope } from '../../lib/workspace';

function upsertTask(list: Task[] | undefined, task: Task): Task[] | undefined {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === task.id);
  if (i === -1) return [...list, task];
  const next = list.slice();
  next[i] = task;
  return next;
}

/** Writes a task returned by the server into the caches right away (the event follows anyway). */
export function useStoreTask() {
  const qc = useQueryClient();
  return useCallback(
    (task: Task) => {
      qc.setQueryData<Task>(qk.task(task.id), task);
      qc.setQueryData<Task[]>(qk.tasks, (old) => upsertTask(old, task));
    },
    [qc],
  );
}

/** Start / approve / reject / mark finished / stop / update / delete with toasts. */
export function useTaskActions() {
  const t = useT();
  const store = useStoreTask();
  const qc = useQueryClient();

  const start = useAction((taskId: string) => rpc('task.start', { taskId }), { success: t('taskAction.started'), error: t('taskAction.startFailed'), onSuccess: store });
  const approve = useAction((taskId: string) => rpc('task.approve', { taskId }), {
    success: (task) => (task.status === 'done' ? (task.note ?? t('taskAction.approvedDone')) : t('taskAction.approvedNext')),
    error: t('taskAction.approveFailed'),
    onSuccess: store,
  });
  const reject = useAction((v: { taskId: string; feedback: string }) => rpc('task.reject', v), {
    success: t('taskAction.rejected'),
    error: t('taskAction.rejectFailed'),
    onSuccess: store,
  });
  const markFinished = useAction((taskId: string) => rpc('task.mark_finished', { taskId }), {
    success: t('taskAction.markedFinished'),
    error: t('taskAction.markFinishedFailed'),
    onSuccess: store,
  });
  const stop = useAction((taskId: string) => rpc('task.stop', { taskId }), { success: t('taskAction.stopped'), error: t('taskAction.stopFailed'), onSuccess: store });
  const update = useAction((v: MethodParams<'task.update'>) => rpc('task.update', v), {
    error: t('common.saveFailed'),
    onSuccess: store,
  });
  const remove = useAction((taskId: string) => rpc('task.delete', { taskId }), {
    success: t('taskAction.deleted'),
    error: t('common.deleteFailed'),
    onSuccess: (_r, taskId) => {
      qc.setQueryData<Task[]>(qk.tasks, (old) => old?.filter((x) => x.id !== taskId));
    },
  });
  return { start, approve, reject, markFinished, stop, update, remove };
}

/** Opens a task's detail drawer (it is mounted globally and reads `?task=`). */
export function useOpenTask() {
  const [params, setParams] = useSearchParams();
  return useCallback(
    (taskId: string | null) => {
      const next = new URLSearchParams(params);
      if (taskId) next.set('task', taskId);
      else next.delete('task');
      setParams(next, { replace: !taskId });
    },
    [params, setParams],
  );
}

/** Shows an agent in the cockpit (switching to its workspace when given). */
export function useOpenInCockpit() {
  const navigate = useNavigate();
  return useCallback(
    (agentId: string, workspaceId?: string) => {
      if (workspaceId) setWorkspaceScope(workspaceId);
      navigate(`/cockpit?agent=${encodeURIComponent(agentId)}`);
    },
    [navigate],
  );
}
