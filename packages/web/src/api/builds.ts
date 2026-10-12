import { useSyncExternalStore } from 'react';
import type { ImageKind } from '@cocoon/protocol';

/** Image builds by kind, plus CoCoon's own update ("cocoon"). */
export type BuildKey = ImageKind | 'cocoon';

export interface BuildState {
  buildId: string;
  kind: BuildKey;
  status: 'running' | 'succeeded' | 'failed';
  lines: string[];
  error?: string;
}

const MAX_LINES = 2000;
type Builds = Partial<Record<BuildKey, BuildState>>;

let state: Builds = {};
const listeners = new Set<() => void>();

function set(next: Builds) {
  state = next;
  for (const fn of listeners) fn();
}

/** Live image-build logs, fed by `image.build` events (kept outside react-query: it is append-only stream data). */
export const buildStore = {
  start(kind: BuildKey, buildId: string) {
    const cur = state[kind];
    if (cur?.buildId === buildId) return;
    set({ ...state, [kind]: { buildId, kind, status: 'running', lines: [] } });
  },
  apply(ev: { buildId: string; kind: BuildKey; status: BuildState['status']; line?: string; error?: string }) {
    const cur = state[ev.kind];
    const base: BuildState = cur && cur.buildId === ev.buildId ? cur : { buildId: ev.buildId, kind: ev.kind, status: 'running', lines: [] };
    let lines = base.lines;
    if (ev.line !== undefined) {
      lines = [...lines, ...ev.line.replace(/\r?\n$/, '').split(/\r?\n/)];
      if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
    }
    set({ ...state, [ev.kind]: { ...base, status: ev.status, lines, error: ev.error ?? base.error } });
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: () => state,
};

export function useBuild(kind: BuildKey): BuildState | undefined {
  return useSyncExternalStore(buildStore.subscribe, () => buildStore.get()[kind]);
}
