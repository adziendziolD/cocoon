import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { LayoutNode } from '@cocoon/protocol';
import { CircleHelp, Columns2, Grid2x2, Keyboard, MonitorPlay, PanelLeftOpen, PanelRight, Plus, Radio, Send, X } from 'lucide-react';
import { rpc } from '../../api/rpc';
import { useAppDialogs } from '../../components/AppDialogs';
import { Button } from '../../components/Button';
import { Checkbox, Input } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { LoadingState } from '../../components/States';
import { useToast } from '../../components/Toast';
import { WorkspaceSwitcher } from '../../components/WorkspaceSwitcher';
import { useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { isSpecific, useWorkspaceScope } from '../../lib/workspace';
import type { PickResult } from './AgentPicker';
import { AttentionList } from './AttentionList';
import { CockpitRail } from './CockpitRail';
import { CockpitActionsContext, CockpitDataContext, useCockpitData, type CockpitActions } from './context';
import {
  computeLayout,
  findPane,
  focusSidebar,
  gridLayout,
  listPanes,
  makePane,
  MAX_PANES,
  neighbor,
  removePane,
  resizeAt,
  splitAt,
  splitPane,
  twoColumns,
  updatePane,
  type Direction,
  type Divider,
  type FocusDir,
} from './layoutTree';
import { Pane } from './Pane';
import { MOD, ShortcutHelp } from './ShortcutHelp';
import { useLayoutPersistence } from './useLayoutPersistence';

/** Maximum number of simultaneously attached terminals (each is a WebSocket + xterm instance). */
const MAX_LIVE = 12;
const RAIL_KEY = 'cocoon.cockpit.rail';

function useMediaQuery(q: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      const m = window.matchMedia(q);
      m.addEventListener('change', fn);
      return () => m.removeEventListener('change', fn);
    },
    () => window.matchMedia(q).matches,
  );
}

const ARROWS: Record<string, FocusDir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

function isEditable(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  if (!e) return false;
  return e.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) || !!e.closest?.('.xterm');
}

export function CockpitPage() {
  const t = useT();
  const wide = useMediaQuery('(min-width: 1024px)');
  const [scope, , workspace] = useWorkspaceScope();
  const data = useCockpitData(scope, workspace);

  if (!wide) {
    return (
      <CockpitDataContext.Provider value={data}>
        <div className="space-y-4 p-4">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg">
            <MonitorPlay className="size-5" /> {t('cockpit.title')}
          </h1>
          <Callout tone="info" title={t('cockpit.narrow.title')}>
            {t('cockpit.narrow.text')}
          </Callout>
          <WorkspaceSwitcher />
          <div>
            <h2 className="mb-2 text-sm font-semibold text-fg">{t('cockpit.attention.title')}</h2>
            <AttentionList />
          </div>
          <Link to="/tasks" className="text-sm text-accent hover:underline">
            {t('layout.nav.tasks')} →
          </Link>
        </div>
      </CockpitDataContext.Provider>
    );
  }
  return (
    <CockpitDataContext.Provider value={data}>
      <Cockpit key={isSpecific(scope) ? scope : ''} layoutKey={isSpecific(scope) ? scope : ''} />
    </CockpitDataContext.Provider>
  );
}

function Cockpit({ layoutKey }: { layoutKey: string }) {
  const t = useT();
  const toast = useToast();
  const dialogs = useAppDialogs();
  const [params, setParams] = useSearchParams();
  const data = useCockpitDataContext();
  const { root, loadedEmpty, setRoot, saveState, loading } = useLayoutPersistence(layoutKey);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusTick, setFocusTick] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_KEY) !== '0');
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const areaRef = useRef<HTMLDivElement>(null);
  const broadcastRef = useRef<HTMLInputElement>(null);

  useEffect(() => localStorage.setItem(RAIL_KEY, railOpen ? '1' : '0'), [railOpen]);

  // First visit of this workspace: arrange its running agents in a grid.
  useEffect(() => {
    if (loadedEmpty && data.loaded) setRoot(gridLayout(data.liveAgents.map((a) => a.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedEmpty, data.loaded]);

  const panes = useMemo(() => (root ? listPanes(root) : []), [root]);
  const layout = useMemo(() => (root ? computeLayout(root) : { panes: [], dividers: [] }), [root]);
  const shownAgents = useMemo(() => new Set(panes.flatMap((p) => (p.view === 'agent' && p.agentId ? [p.agentId] : []))), [panes]);

  // Keep focus/maximize/selection pointing at existing panes.
  useEffect(() => {
    if (!panes.length) return;
    if (!focusedId || !panes.some((p) => p.id === focusedId)) setFocusedId(panes[0]!.id);
    if (maximizedId && !panes.some((p) => p.id === maximizedId)) setMaximizedId(null);
    setSelected((s) => {
      const next = new Set([...s].filter((id) => panes.some((p) => p.id === id && p.view === 'agent')));
      return next.size === s.size ? s : next;
    });
  }, [panes, focusedId, maximizedId]);

  // Only visible panes connect, and at most MAX_LIVE of them.
  const { liveIds, overCap } = useMemo(() => {
    const visible = maximizedId ? panes.filter((p) => p.id === maximizedId) : panes;
    const candidates = visible.filter((p) => {
      const a = p.view === 'agent' && p.agentId ? data.agentById.get(p.agentId) : undefined;
      return a && a.status !== 'exited';
    });
    return { liveIds: new Set(candidates.slice(0, MAX_LIVE).map((p) => p.id)), overCap: Math.max(0, candidates.length - MAX_LIVE) };
  }, [panes, maximizedId, data.agentById]);

  const focusPane = useCallback((id: string, keyboard = false) => {
    setFocusedId(id);
    if (keyboard) setFocusTick((n) => n + 1);
  }, []);

  /** Shows `r` in pane `paneId`. An agent already visible elsewhere swaps places with this pane's content. */
  const pick = useCallback(
    (paneId: string, r: PickResult) => {
      setRoot((prev) => {
        const target = findPane(prev, paneId);
        if (!target) return prev;
        let next = prev;
        if (r.view === 'agent') {
          const other = listPanes(prev).find((p) => p.id !== paneId && p.view === 'agent' && p.agentId === r.agentId);
          if (other) next = updatePane(next, other.id, { view: target.view, agentId: target.agentId });
          return updatePane(next, paneId, { view: 'agent', agentId: r.agentId });
        }
        return updatePane(next, paneId, { view: r.view });
      });
      focusPane(paneId, true);
    },
    [setRoot, focusPane],
  );

  const focusAgent = useCallback(
    (agentId: string) => {
      if (!root) return;
      const existing = panes.find((p) => p.view === 'agent' && p.agentId === agentId);
      if (existing) {
        if (maximizedId && maximizedId !== existing.id) setMaximizedId(existing.id);
        focusPane(existing.id, true);
        return;
      }
      const empty = panes.find((p) => p.view === 'empty' || (p.view === 'agent' && (!p.agentId || !data.agentById.get(p.agentId))));
      const target = maximizedId ?? empty?.id ?? focusedId ?? panes[0]?.id;
      if (target) pick(target, { view: 'agent', agentId });
    },
    [root, panes, maximizedId, focusedId, data.agentById, pick, focusPane],
  );

  // Deep link: /cockpit?agent=<id> (e.g. "open in cockpit" on a task card).
  const deepAgent = params.get('agent');
  useEffect(() => {
    if (!deepAgent || !root || !data.loaded) return;
    focusAgent(deepAgent);
    const next = new URLSearchParams(params);
    next.delete('agent');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepAgent, !!root, data.loaded]);

  const split = useCallback(
    (paneId: string, dir?: Direction) => {
      if (panes.length >= MAX_PANES) {
        toast.info(t('cockpit.maxPanes', { count: MAX_PANES }));
        return;
      }
      let direction = dir;
      if (!direction) {
        const rect = layout.panes.find((p) => p.pane.id === paneId)?.rect;
        const el = areaRef.current;
        direction = rect && el && rect.w * el.clientWidth < rect.h * el.clientHeight ? 'column' : 'row';
      }
      // Fill the new pane with the next agent that is not visible yet.
      const next = data.liveAgents.find((a) => !shownAgents.has(a.id));
      const pane = next ? makePane('agent', next.id) : makePane();
      setRoot((prev) => splitPane(prev, paneId, direction, pane));
      setMaximizedId(null);
      focusPane(pane.id, true);
    },
    [panes.length, layout.panes, data.liveAgents, shownAgents, setRoot, focusPane, toast, t],
  );

  const close = useCallback(
    (paneId: string) => {
      setRoot((prev) => removePane(prev, paneId));
      if (maximizedId === paneId) setMaximizedId(null);
    },
    [setRoot, maximizedId],
  );

  const applyPreset = useCallback(
    (kind: 'grid' | 'two' | 'focus') => {
      const focusedAgent = panes.find((p) => p.id === focusedId)?.agentId;
      const ids = data.liveAgents.map((a) => a.id);
      const main = focusedAgent && data.agentById.get(focusedAgent)?.status !== 'exited' ? focusedAgent : ids[0];
      let next: LayoutNode;
      if (kind === 'grid') next = gridLayout(ids);
      else if (kind === 'two') next = twoColumns(main, ids.find((id) => id !== main));
      else next = focusSidebar(main);
      setRoot(next);
      setMaximizedId(null);
      setFocusedId(listPanes(next)[0]?.id ?? null);
      if (kind === 'grid' && ids.length > MAX_LIVE) toast.info(t('cockpit.gridCapped', { count: MAX_LIVE }));
    },
    [panes, focusedId, data.liveAgents, data.agentById, setRoot, toast, t],
  );

  const toggleSelect = (paneId: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(paneId)) next.delete(paneId);
      else next.add(paneId);
      return next;
    });

  const openBroadcast = useCallback(() => {
    setSelected((s) => {
      if (s.size) return s;
      // Nothing selected yet: preselect every visible live agent pane.
      return new Set(panes.filter((p) => liveIds.has(p.id)).map((p) => p.id));
    });
    setBroadcastOpen(true);
    setTimeout(() => broadcastRef.current?.focus(), 30);
  }, [panes, liveIds]);

  // Keyboard shortcuts. Capture phase, so they work while a terminal has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const mod = (e.ctrlKey || e.metaKey) && e.altKey;
      if (!mod) {
        if (e.key === '?' && !isEditable(e.target)) {
          e.preventDefault();
          setHelpOpen(true);
        }
        return;
      }
      const cur = focusedId;
      let handled = true;
      if (ARROWS[e.key]) {
        const n = root && cur ? neighbor(root, cur, ARROWS[e.key]!) : undefined;
        if (n) {
          if (maximizedId) setMaximizedId(n);
          focusPane(n, true);
        }
      } else if (e.key === 'Enter') {
        if (cur) setMaximizedId((m) => (m === cur ? null : cur));
        setFocusTick((n) => n + 1);
      } else if (e.code === 'KeyD') {
        if (cur) split(cur);
      } else if (e.code === 'KeyW') {
        if (cur && panes.length > 1) close(cur);
      } else if (e.code === 'KeyG') {
        applyPreset('grid');
      } else if (e.code === 'KeyB') {
        openBroadcast();
      } else if (e.code === 'Slash') {
        setHelpOpen(true);
      } else if (/^Digit[1-9]$/.test(e.code)) {
        const p = panes[Number(e.code.slice(5)) - 1];
        if (p) {
          if (maximizedId) setMaximizedId(p.id);
          focusPane(p.id, true);
        }
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [root, focusedId, maximizedId, panes, split, close, applyPreset, openBroadcast, focusPane]);

  const actions = useMemo<CockpitActions>(() => ({ focusAgent, shownAgents }), [focusAgent, shownAgents]);
  const dense = panes.length > 4;
  const selectedAgents = panes.filter((p) => selected.has(p.id) && p.agentId).map((p) => p.agentId!);

  return (
    <CockpitActionsContext.Provider value={actions}>
      <div className="flex h-full min-h-0">
        {railOpen && (
          <aside className="w-72 shrink-0 border-r border-line bg-surface">
            <CockpitRail onCollapse={() => setRailOpen(false)} />
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
            {!railOpen && (
              <button type="button" onClick={() => setRailOpen(true)} className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg" title={t('cockpit.rail.expand')} aria-label={t('cockpit.rail.expand')}>
                <PanelLeftOpen className="size-4" />
              </button>
            )}
            <WorkspaceSwitcher onCreate={() => dialogs.workspace()} />
            <div className="mx-1 h-6 w-px bg-line" />
            <span className="hidden text-xs text-fg-subtle 2xl:inline">{t('cockpit.presets')}</span>
            <Button size="sm" icon={<Grid2x2 className="size-3.5" />} onClick={() => applyPreset('grid')} title={t('cockpit.preset.gridHint')}>
              <span className="hidden xl:inline">{t('cockpit.preset.grid')}</span>
            </Button>
            <Button size="sm" icon={<Columns2 className="size-3.5" />} onClick={() => applyPreset('two')} title={t('cockpit.preset.two')}>
              <span className="hidden xl:inline">{t('cockpit.preset.two')}</span>
            </Button>
            <Button size="sm" icon={<PanelRight className="size-3.5" />} onClick={() => applyPreset('focus')} title={t('cockpit.preset.focusHint')}>
              <span className="hidden xl:inline">{t('cockpit.preset.focus')}</span>
            </Button>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => focusedId && split(focusedId)} disabled={!focusedId} title={`${t('cockpit.pane.add')} (${MOD}D)`}>
              <span className="hidden xl:inline">{t('cockpit.pane.add')}</span>
            </Button>
            <Button size="sm" variant={broadcastOpen ? 'primary' : 'ghost'} icon={<Radio className="size-3.5" />} onClick={() => (broadcastOpen ? setBroadcastOpen(false) : openBroadcast())} title={`${t('cockpit.broadcast.hint')} (${MOD}B)`}>
              <span className="hidden xl:inline">{t('cockpit.broadcast.button')}</span>
            </Button>
            <span className="flex-1" />
            {overCap > 0 && <span className="rounded-md bg-amber-400/15 px-2 py-1 text-xs text-amber-800 dark:text-amber-300">{t('cockpit.overCap', { count: overCap, max: MAX_LIVE })}</span>}
            <SaveIndicator state={saveState} />
            <button type="button" onClick={() => setHelpOpen(true)} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg" title={t('cockpit.keys.title')}>
              <Keyboard className="size-3.5" /> <CircleHelp className="size-3.5" />
            </button>
          </div>

          {broadcastOpen && (
            <BroadcastBar
              inputRef={broadcastRef}
              agentIds={selectedAgents}
              onClose={() => {
                setBroadcastOpen(false);
                setSelected(new Set());
              }}
            />
          )}

          <div ref={areaRef} className="relative min-h-0 flex-1 bg-canvas p-1">
            {loading || !root ? (
              <LoadingState />
            ) : (
              <div className="relative h-full w-full">
                {layout.panes.map(({ pane, rect }) => {
                  const hidden = !!maximizedId && maximizedId !== pane.id;
                  if (hidden) return null;
                  const r = maximizedId ? { x: 0, y: 0, w: 1, h: 1 } : rect;
                  return (
                    <div
                      key={pane.id}
                      className="absolute p-0.5"
                      style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
                    >
                      <Pane
                        pane={pane}
                        focused={pane.id === focusedId}
                        maximized={pane.id === maximizedId}
                        selected={selected.has(pane.id)}
                        live={liveIds.has(pane.id)}
                        focusSignal={pane.id === focusedId ? focusTick : undefined}
                        dense={dense && !maximizedId}
                        canClose={panes.length > 1}
                        onFocus={() => pane.id !== focusedId && focusPane(pane.id)}
                        onToggleSelect={() => toggleSelect(pane.id)}
                        onMaximize={() => {
                          setMaximizedId((m) => (m === pane.id ? null : pane.id));
                          focusPane(pane.id, true);
                        }}
                        onSplit={(dir) => split(pane.id, dir)}
                        onClose={() => close(pane.id)}
                        onPick={(r) => pick(pane.id, r)}
                      />
                    </div>
                  );
                })}
                {!maximizedId &&
                  layout.dividers.map((d) => (
                    <DividerHandle key={`${d.path.join('.')}-${d.index}`} divider={d} areaRef={areaRef} root={root} onResize={(start, delta) => setRoot((prev) => resizeAt(prev, d, start, delta))} />
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </CockpitActionsContext.Provider>
  );
}

function useCockpitDataContext() {
  const ctx = useContext(CockpitDataContext);
  if (!ctx) throw new Error('missing cockpit data');
  return ctx;
}

/** Draggable divider between two neighbouring panes of a split. */
function DividerHandle({ divider: d, root, areaRef, onResize }: { divider: Divider; root: LayoutNode; areaRef: React.RefObject<HTMLDivElement | null>; onResize: (startSizes: number[], delta: number) => void }) {
  const [active, setActive] = useState(false);
  const row = d.direction === 'row';
  const style: React.CSSProperties = row
    ? { left: `${d.at * 100}%`, top: `${d.parent.y * 100}%`, height: `${d.parent.h * 100}%`, width: 10, transform: 'translateX(-50%)' }
    : { top: `${d.at * 100}%`, left: `${d.parent.x * 100}%`, width: `${d.parent.w * 100}%`, height: 10, transform: 'translateY(-50%)' };
  return (
    <div
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      className={cn('group absolute z-10 flex items-center justify-center', row ? 'cursor-col-resize' : 'cursor-row-resize')}
      style={style}
      onPointerDown={(e) => {
        const area = areaRef.current;
        const split = splitAt(root, d.path);
        if (!area || !split) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        setActive(true);
        const start = split.sizes.slice();
        const origin = row ? e.clientX : e.clientY;
        const extent = row ? area.clientWidth : area.clientHeight;
        let frame = 0;
        const move = (ev: PointerEvent) => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => onResize(start, ((row ? ev.clientX : ev.clientY) - origin) / extent));
        };
        const up = () => {
          cancelAnimationFrame(frame);
          setActive(false);
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
    >
      <span className={cn('rounded-full transition-colors', row ? 'h-10 w-1' : 'h-1 w-10', active ? 'bg-accent' : 'bg-transparent group-hover:bg-accent/60')} />
    </div>
  );
}

function SaveIndicator({ state }: { state: ReturnType<typeof useLayoutPersistence>['saveState'] }) {
  const t = useT();
  if (state === 'idle') return null;
  const text = { saving: t('cockpit.save.saving'), saved: t('cockpit.save.saved'), local: t('cockpit.save.local'), error: t('cockpit.save.local') }[state];
  return (
    <span className={cn('text-xs', state === 'local' || state === 'error' ? 'text-amber-700 dark:text-amber-400' : 'text-fg-subtle')} title={state === 'local' ? t('cockpit.save.localHint') : undefined}>
      {text}
    </span>
  );
}

/** Sends one message to several agents at once. */
function BroadcastBar({ agentIds, onClose, inputRef }: { agentIds: string[]; onClose: () => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const t = useT();
  const toast = useToast();
  const [text, setText] = useState('');
  const [submit, setSubmit] = useState(true);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || !agentIds.length) return;
    setBusy(true);
    const results = await Promise.allSettled(agentIds.map((agentId) => rpc('agent.send_input', { agentId, text, submit })));
    setBusy(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) toast.error(t('cockpit.broadcast.partial', { failed, count: agentIds.length }));
    else toast.success(t('cockpit.broadcast.sent', { count: agentIds.length }));
    if (failed < agentIds.length) setText('');
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-accent/30 bg-accent-soft/60 px-3 py-2">
      <Radio className="size-4 text-accent" />
      <span className="text-sm font-medium text-fg">{t('cockpit.broadcast.to', { count: agentIds.length })}</span>
      <Input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void send();
          }
          if (e.key === 'Escape') onClose();
        }}
        placeholder={agentIds.length ? t('cockpit.broadcast.placeholder') : t('cockpit.broadcast.selectFirst')}
        className="h-8 min-w-60 flex-1"
      />
      <Checkbox checked={submit} onChange={setSubmit} label={<span className="text-xs">{t('agentDetail.msg.pressEnter')}</span>} />
      <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} loading={busy} disabled={!text.trim() || !agentIds.length} onClick={() => void send()}>
        {t('agentDetail.msg.send')}
      </Button>
      <button type="button" onClick={onClose} className="rounded-md p-1 text-fg-muted hover:bg-surface hover:text-fg" aria-label={t('common.close')}>
        <X className="size-4" />
      </button>
    </div>
  );
}
