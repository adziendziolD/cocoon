import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ActivityEntry, Agent, CocoonEvent, Sandbox, Schedule, ServiceInfo, Task, WireError, Workspace } from '@cocoon/protocol';
import { useLanguage } from '../i18n';
import { buildStore } from './builds';
import { qk } from './keys';
import { rpc, wsUrl } from './rpc';

export type ConnectionState = 'connecting' | 'open' | 'closed';

let connection: ConnectionState = 'connecting';
const connListeners = new Set<() => void>();

function setConnection(next: ConnectionState) {
  if (connection === next) return;
  connection = next;
  for (const fn of connListeners) fn();
}

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(
    (fn) => {
      connListeners.add(fn);
      return () => connListeners.delete(fn);
    },
    () => connection,
  );
}

function upsert<T extends { id: string }>(list: T[] | undefined, item: T): T[] | undefined {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/** Applies a server event to the react-query caches so every view stays live. */
export function applyEvent(qc: QueryClient, event: CocoonEvent): void {
  switch (event.type) {
    case 'sandbox.updated': {
      const s = event.sandbox;
      qc.setQueryData<Sandbox>(qk.sandbox(s.id), s);
      qc.setQueryData<Sandbox[]>(qk.sandboxes, (old) => upsert(old, s));
      void qc.invalidateQueries({ queryKey: qk.setup });
      break;
    }
    case 'sandbox.deleted': {
      qc.setQueryData<Sandbox[]>(qk.sandboxes, (old) => old?.filter((s) => s.id !== event.sandboxId));
      qc.setQueryData<Agent[]>(qk.agents, (old) => old?.filter((a) => a.sandboxId !== event.sandboxId));
      qc.removeQueries({ queryKey: qk.sandbox(event.sandboxId) });
      void qc.invalidateQueries({ queryKey: qk.setup });
      break;
    }
    case 'agent.updated': {
      const a = event.agent;
      qc.setQueryData<Agent>(qk.agent(a.id), a);
      qc.setQueryData<Agent[]>(qk.agents, (old) => upsert(old, a));
      void qc.invalidateQueries({ queryKey: qk.setup });
      break;
    }
    case 'agent.removed': {
      qc.setQueryData<Agent[]>(qk.agents, (old) => old?.filter((a) => a.id !== event.agentId));
      void qc.invalidateQueries({ queryKey: qk.agent(event.agentId) });
      break;
    }
    case 'settings.updated':
      qc.setQueryData(qk.settings, event.settings);
      break;
    case 'image.build':
      buildStore.apply(event);
      if (event.status !== 'running') {
        void qc.invalidateQueries({ queryKey: qk.images });
        void qc.invalidateQueries({ queryKey: qk.setup });
      }
      break;
    case 'update.progress':
      buildStore.apply({ ...event, kind: 'cocoon' });
      break;
    case 'ports.updated':
      qc.setQueryData(qk.ports(event.sandboxId), event.ports);
      break;
    case 'update.status':
      qc.setQueryData(qk.updates, event.status);
      break;
    case 'activity':
      qc.setQueryData<ActivityEntry[]>(qk.activity, (old) =>
        old ? [event.entry, ...old.filter((e) => e.id !== event.entry.id)].slice(0, 500) : old,
      );
      break;
    case 'workspace.updated': {
      const w = event.workspace;
      qc.setQueryData<Workspace>(qk.workspace(w.id), w);
      qc.setQueryData<Workspace[]>(qk.workspaces, (old) => upsert(old, w));
      break;
    }
    case 'workspace.deleted': {
      const id = event.workspaceId;
      qc.setQueryData<Workspace[]>(qk.workspaces, (old) => old?.filter((w) => w.id !== id));
      qc.setQueryData<Task[]>(qk.tasks, (old) => old?.filter((x) => x.workspaceId !== id));
      qc.setQueryData<Schedule[]>(qk.schedules, (old) => old?.filter((x) => x.workspaceId !== id));
      // Sandboxes become unassigned (or are deleted) – the server sends sandbox events, but refetch to be safe.
      qc.setQueryData<Sandbox[]>(qk.sandboxes, (old) => old?.map((s) => (s.workspaceId === id ? { ...s, workspaceId: undefined } : s)));
      qc.removeQueries({ queryKey: qk.workspace(id) });
      qc.removeQueries({ queryKey: qk.layout(id) });
      void qc.invalidateQueries({ queryKey: qk.sandboxes });
      break;
    }
    case 'task.updated': {
      const task = event.task;
      qc.setQueryData<Task>(qk.task(task.id), task);
      qc.setQueryData<Task[]>(qk.tasks, (old) => upsert(old, task));
      break;
    }
    case 'schedule.updated':
      qc.setQueryData<Schedule[]>(qk.schedules, (old) => upsert(old, event.schedule));
      break;
    case 'schedule.deleted':
      qc.setQueryData<Schedule[]>(qk.schedules, (old) => old?.filter((x) => x.id !== event.scheduleId));
      break;
    case 'service.updated': {
      const svc = event.service;
      const before = qc.getQueryData<ServiceInfo[]>(qk.services)?.find((x) => x.id === svc.id);
      qc.setQueryData<ServiceInfo[]>(qk.services, (old) => upsert(old, svc));
      // Sandbox connections only change when the set of attached sandboxes (or the status) changes – not on every progress event.
      if (!before || before.status !== svc.status || before.sandboxes.join() !== svc.sandboxes.join()) {
        void qc.invalidateQueries({ queryKey: qk.serviceConnectionsAll });
      }
      break;
    }
    case 'service.removed': {
      qc.setQueryData<ServiceInfo[]>(qk.services, (old) => old?.filter((x) => x.id !== event.serviceId));
      qc.removeQueries({ queryKey: qk.serviceCredentials(event.serviceId) });
      void qc.invalidateQueries({ queryKey: qk.serviceConnectionsAll });
      break;
    }
    case 'task.deleted': {
      qc.setQueryData<Task[]>(qk.tasks, (old) => old?.filter((x) => x.id !== event.taskId));
      qc.removeQueries({ queryKey: qk.task(event.taskId) });
      break;
    }
  }
}

/**
 * Keeps one shared event WebSocket open while the app is mounted.
 * Reconnects with exponential backoff and refetches everything after a reconnect
 * (events that happened while disconnected would otherwise be missed).
 * Also reconnects when the UI language changes.
 */
export function useEventSync(enabled: boolean): void {
  const qc = useQueryClient();
  // Reconnect when the language changes: the socket URL carries ?lang= for server-rendered texts.
  const { lang } = useLanguage();

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasOpen = false;

    const connect = () => {
      setConnection('connecting');
      ws = new WebSocket(wsUrl('/v1/ws'));
      ws.onopen = () => {
        ws?.send(JSON.stringify({ id: 'ev', method: 'events.subscribe', params: {} }));
      };
      ws.onmessage = (msg) => {
        let data: { id?: string | number; result?: unknown; error?: WireError; event?: CocoonEvent };
        try {
          data = JSON.parse(String(msg.data));
        } catch {
          return;
        }
        if (data.id === 'ev' && 'result' in data) {
          attempt = 0;
          setConnection('open');
          if (wasOpen) void qc.invalidateQueries();
          wasOpen = true;
        } else if (data.id === 'ev' && data.error) {
          ws?.close();
        } else if (data.event) {
          applyEvent(qc, data.event);
        }
      };
      ws.onclose = () => {
        ws = null;
        if (stopped) return;
        setConnection('closed');
        // A cheap authenticated call: if the token became invalid, rpc() logs the user out.
        void rpc('system.info').catch(() => undefined);
        const delay = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
        attempt++;
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [enabled, qc, lang]);
}
