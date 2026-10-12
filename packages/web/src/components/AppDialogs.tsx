import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Task, Workspace } from '@cocoon/protocol';
import { useWorkspaces } from '../api/queries';
import { CreateSandboxWizard } from './CreateSandboxWizard';
import { RejectDialog } from './tasks/RejectDialog';
import { TaskDialog } from './tasks/TaskDialog';
import { TaskDrawer } from './tasks/TaskDrawer';
import { WorkspaceDialog } from './WorkspaceForm';

interface TaskDialogOpts {
  task?: Task;
  workspaceId?: string;
  initialStatus?: 'backlog' | 'queued';
}

interface AppDialogs {
  createSandbox: (opts?: { workspaceId?: string }) => void;
  /** Create (no argument) or edit a workspace. */
  workspace: (ws?: Workspace) => void;
  task: (opts?: TaskDialogOpts) => void;
  reject: (task: Task) => void;
}

const noop = () => {};
const Ctx = createContext<AppDialogs>({ createSandbox: noop, workspace: noop, task: noop, reject: noop });

/** Opens the app-wide dialogs (new sandbox / workspace / task, review feedback) from anywhere. */
export const useAppDialogs = () => useContext(Ctx);

/** Hosts the global dialogs and the task drawer (which follows the `?task=` URL parameter). */
export function AppDialogsProvider({ children }: { children: ReactNode }) {
  const workspaces = useWorkspaces();
  const [sandbox, setSandbox] = useState<{ open: boolean; workspaceId?: string }>({ open: false });
  const [ws, setWs] = useState<{ open: boolean; workspace?: Workspace }>({ open: false });
  const [task, setTask] = useState<{ open: boolean } & TaskDialogOpts>({ open: false });
  const [reject, setReject] = useState<Task | null>(null);

  const api = useMemo<AppDialogs>(
    () => ({
      createSandbox: (opts) => setSandbox({ open: true, workspaceId: opts?.workspaceId }),
      workspace: (workspace) => setWs({ open: true, workspace }),
      task: (opts) => setTask({ open: true, ...opts }),
      reject: (t) => setReject(t),
    }),
    [],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <CreateSandboxWizard open={sandbox.open} onClose={() => setSandbox((s) => ({ ...s, open: false }))} defaultWorkspaceId={sandbox.workspaceId} />
      <WorkspaceDialog open={ws.open} onClose={() => setWs((s) => ({ ...s, open: false }))} workspace={ws.workspace} index={workspaces.data?.length ?? 0} />
      <TaskDialog
        open={task.open}
        onClose={() => setTask((s) => ({ ...s, open: false }))}
        task={task.task}
        workspaceId={task.workspaceId}
        initialStatus={task.initialStatus}
      />
      <RejectDialog task={reject} open={!!reject} onClose={() => setReject(null)} />
      <TaskDrawer />
    </Ctx.Provider>
  );
}
