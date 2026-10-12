import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CockpitLayout, LayoutNode } from '@cocoon/protocol';
import { qk } from '../../api/keys';
import { useCockpitLayout } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { sanitize } from './layoutTree';

export type SaveState = 'idle' | 'saving' | 'saved' | 'local' | 'error';

const SAVE_DELAY = 1000;
const localKey = (key: string) => `cocoon.cockpit.layout.${key || 'global'}`;

function readLocal(key: string): LayoutNode | null {
  try {
    const raw = localStorage.getItem(localKey(key));
    return raw ? sanitize((JSON.parse(raw) as CockpitLayout).root) : null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, layout: CockpitLayout) {
  try {
    localStorage.setItem(localKey(key), JSON.stringify(layout));
  } catch {
    // quota / privacy mode – the server copy is the source of truth anyway
  }
}

/**
 * Loads the cockpit layout of a workspace (`key` = workspace id, '' = global) via layout.get and saves changes
 * (debounced) via layout.save. A copy is kept in localStorage as fallback when the server can't store layouts.
 * `root` is null until loaded; `loadedEmpty` tells the caller to build a default layout.
 */
export function useLayoutPersistence(key: string) {
  const qc = useQueryClient();
  const query = useCockpitLayout(key);
  const [state, setState] = useState<{ key: string; root: LayoutNode | null; loadedEmpty: boolean }>({ key, root: null, loadedEmpty: false });
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const pending = useRef<{ key: string; root: LayoutNode } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const job = pending.current;
    pending.current = null;
    if (!job) return;
    const layout: CockpitLayout = { root: job.root, updatedAt: new Date().toISOString() };
    writeLocal(job.key, layout);
    setSaveState('saving');
    try {
      await rpc('layout.save', job.key ? { workspaceId: job.key, layout } : { layout });
      qc.setQueryData(qk.layout(job.key), layout);
      setSaveState('saved');
    } catch {
      // Server can't store it (yet) – the local copy keeps it for this browser.
      setSaveState('local');
    }
  }, [qc]);

  // Initialise once per key when the query settled (success, empty or error).
  const ready = query.isSuccess || query.isError;
  useEffect(() => {
    if (state.key === key && (state.root || state.loadedEmpty)) return;
    if (!ready) {
      if (state.key !== key) setState({ key, root: null, loadedEmpty: false });
      return;
    }
    const fromServer = query.data ? sanitize(query.data.root) : null;
    const root = fromServer ?? readLocal(key);
    setState({ key, root, loadedEmpty: !root });
    setSaveState('idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  // Save the previous workspace's layout immediately when switching.
  useEffect(() => () => void flush(), [key, flush]);

  const setRoot = useCallback(
    (update: LayoutNode | ((prev: LayoutNode) => LayoutNode)) => {
      setState((s) => {
        if (s.key !== key) return s;
        const prev = s.root;
        const next = typeof update === 'function' ? (prev ? update(prev) : prev) : update;
        if (!next || next === prev) return s;
        pending.current = { key, root: next };
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), SAVE_DELAY);
        return { key, root: next, loadedEmpty: false };
      });
    },
    [key, flush],
  );

  return { root: state.key === key ? state.root : null, loadedEmpty: state.key === key && state.loadedEmpty, setRoot, saveState, loading: !ready };
}
