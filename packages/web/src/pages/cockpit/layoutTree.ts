import type { LayoutNode } from '@cocoon/protocol';

/**
 * Pure helpers for the cockpit's tiling layout (a tree of splits whose leaves are panes).
 * "row" splits place children side by side, "column" splits stack them. `sizes` are relative weights.
 */
export type PaneNode = Extract<LayoutNode, { type: 'pane' }>;
export type SplitNode = Extract<LayoutNode, { type: 'split' }>;
export type PaneView = PaneNode['view'];
export type Direction = SplitNode['direction'];
export type FocusDir = 'left' | 'right' | 'up' | 'down';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_CHILDREN = 12;
export const MAX_PANES = 16;
const MIN_FRACTION = 0.08;

export const newPaneId = () => `p${Math.random().toString(36).slice(2, 10)}`;

export function makePane(view: PaneView = 'empty', agentId?: string): PaneNode {
  return agentId && view === 'agent' ? { type: 'pane', id: newPaneId(), view, agentId } : { type: 'pane', id: newPaneId(), view };
}

/** All panes in reading order (depth first). */
export function listPanes(root: LayoutNode): PaneNode[] {
  if (root.type === 'pane') return [root];
  return root.children.flatMap(listPanes);
}

export function findPane(root: LayoutNode, id: string): PaneNode | undefined {
  return listPanes(root).find((p) => p.id === id);
}

/** Replaces a pane (by id) with the result of `fn`. */
export function mapPane(root: LayoutNode, id: string, fn: (p: PaneNode) => LayoutNode): LayoutNode {
  if (root.type === 'pane') return root.id === id ? fn(root) : root;
  let changed = false;
  const children = root.children.map((c) => {
    const n = mapPane(c, id, fn);
    if (n !== c) changed = true;
    return n;
  });
  return changed ? { ...root, children } : root;
}

export function updatePane(root: LayoutNode, id: string, patch: Partial<Omit<PaneNode, 'type' | 'id'>>): LayoutNode {
  return mapPane(root, id, (p) => {
    const next: PaneNode = { ...p, ...patch };
    if (next.view !== 'agent') delete next.agentId;
    return next;
  });
}

/** Collapses single-child splits and merges nested splits of the same direction. */
export function normalize(node: LayoutNode): LayoutNode {
  if (node.type === 'pane') return node;
  const total = sum(node.sizes) || 1;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const n = normalize(c);
    const share = ((node.sizes[i] ?? 1) / total) * 100;
    if (n.type === 'split' && n.direction === node.direction && children.length + n.children.length <= MAX_CHILDREN) {
      const t = sum(n.sizes) || 1;
      n.children.forEach((cc, j) => {
        children.push(cc);
        sizes.push((share * (n.sizes[j] ?? 1)) / t);
      });
    } else {
      children.push(n);
      sizes.push(share);
    }
  });
  if (children.length === 1) return children[0]!;
  return { ...node, children, sizes };
}

/**
 * Splits pane `id`: the new pane goes after (or `before`) it. If the parent already splits in that direction,
 * the new pane joins it (taking half of the pane's share); otherwise the pane becomes a new split.
 */
export function splitPane(root: LayoutNode, id: string, direction: Direction, pane: PaneNode = makePane(), before = false): LayoutNode {
  if (listPanes(root).length >= MAX_PANES) return root;
  const visit = (node: LayoutNode): LayoutNode => {
    if (node.type === 'pane') {
      if (node.id !== id) return node;
      return { type: 'split', direction, sizes: [50, 50], children: before ? [pane, node] : [node, pane] };
    }
    const i = node.children.findIndex((c) => c.type === 'pane' && c.id === id);
    if (i !== -1 && node.direction === direction && node.children.length < MAX_CHILDREN) {
      const children = node.children.slice();
      const sizes = node.sizes.slice();
      const half = (sizes[i] ?? 1) / 2;
      sizes[i] = half;
      children.splice(before ? i : i + 1, 0, pane);
      sizes.splice(before ? i : i + 1, 0, half);
      return { ...node, children, sizes };
    }
    const children = node.children.map(visit);
    return children.some((c, k) => c !== node.children[k]) ? { ...node, children } : node;
  };
  return visit(root);
}

/** Removes a pane; its space goes to its siblings. Removing the last pane leaves one empty pane. */
export function removePane(root: LayoutNode, id: string): LayoutNode {
  const visit = (node: LayoutNode): LayoutNode | null => {
    if (node.type === 'pane') return node.id === id ? null : node;
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((c, i) => {
      const n = visit(c);
      if (n) {
        children.push(n);
        sizes.push(node.sizes[i] ?? 1);
      }
    });
    if (!children.length) return null;
    if (children.length === 1) return children[0]!;
    return { ...node, children, sizes };
  };
  const next = visit(root);
  return next ? normalize(next) : makePane();
}

/** Sets the sizes of the split at `path` (child indexes from the root). */
export function setSizes(root: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (root.type === 'pane') return root;
  if (path.length === 0) return { ...root, sizes };
  const [head, ...rest] = path;
  const child = root.children[head!];
  // The pane at that path may be gone (closed while a resize was pending).
  if (!child) return root;
  const children = root.children.slice();
  children[head!] = setSizes(child, rest, sizes);
  return { ...root, children };
}

/** Swaps the contents (view/agent) of two panes. */
export function swapPanes(root: LayoutNode, a: string, b: string): LayoutNode {
  const pa = findPane(root, a);
  const pb = findPane(root, b);
  if (!pa || !pb || a === b) return root;
  let next = updatePane(root, a, { view: pb.view, agentId: pb.agentId });
  next = updatePane(next, b, { view: pa.view, agentId: pa.agentId });
  return next;
}

export interface Divider {
  path: number[];
  /** Divider between child `index` and `index + 1`. */
  index: number;
  direction: Direction;
  /** Position of the boundary (x for rows, y for columns) and the extent of the parent. */
  at: number;
  parent: Rect;
}

/** Fractional rectangles of all panes plus the draggable dividers between them. */
export function computeLayout(root: LayoutNode): { panes: Array<{ pane: PaneNode; rect: Rect }>; dividers: Divider[] } {
  const panes: Array<{ pane: PaneNode; rect: Rect }> = [];
  const dividers: Divider[] = [];
  const visit = (node: LayoutNode, rect: Rect, path: number[]) => {
    if (node.type === 'pane') {
      panes.push({ pane: node, rect });
      return;
    }
    const total = sum(node.sizes) || 1;
    let offset = 0;
    node.children.forEach((c, i) => {
      const frac = (node.sizes[i] ?? 1) / total;
      const r: Rect =
        node.direction === 'row'
          ? { x: rect.x + offset * rect.w, y: rect.y, w: frac * rect.w, h: rect.h }
          : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: frac * rect.h };
      visit(c, r, [...path, i]);
      offset += frac;
      if (i < node.children.length - 1) {
        dividers.push({ path, index: i, direction: node.direction, at: node.direction === 'row' ? rect.x + offset * rect.w : rect.y + offset * rect.h, parent: rect });
      }
    });
  };
  visit(root, { x: 0, y: 0, w: 1, h: 1 }, []);
  return { panes, dividers };
}

/** Moves a divider by `delta` (fraction of the whole cockpit), keeping both neighbours above a minimum size. */
export function resizeAt(root: LayoutNode, d: Divider, startSizes: number[], delta: number): LayoutNode {
  const total = sum(startSizes) || 1;
  const extent = d.direction === 'row' ? d.parent.w : d.parent.h;
  const shift = (delta / extent) * total;
  const a = startSizes[d.index]!;
  const b = startSizes[d.index + 1]!;
  const min = MIN_FRACTION * total;
  const na = Math.min(Math.max(a + shift, min), a + b - min);
  const sizes = startSizes.slice();
  sizes[d.index] = na;
  sizes[d.index + 1] = a + b - na;
  return setSizes(root, d.path, sizes);
}

export function splitAt(root: LayoutNode, path: number[]): SplitNode | undefined {
  let node: LayoutNode = root;
  for (const i of path) {
    if (node.type !== 'split') return undefined;
    node = node.children[i]!;
  }
  return node.type === 'split' ? node : undefined;
}

/** The pane next to `id` in a direction (by geometry, preferring the best overlap). */
export function neighbor(root: LayoutNode, id: string, dir: FocusDir): string | undefined {
  const { panes } = computeLayout(root);
  const cur = panes.find((p) => p.pane.id === id)?.rect;
  if (!cur) return undefined;
  const eps = 1e-6;
  let best: { id: string; dist: number; overlap: number } | undefined;
  for (const { pane, rect: r } of panes) {
    if (pane.id === id) continue;
    let dist: number;
    let overlap: number;
    if (dir === 'left' || dir === 'right') {
      dist = dir === 'right' ? r.x - (cur.x + cur.w) : cur.x - (r.x + r.w);
      overlap = Math.min(cur.y + cur.h, r.y + r.h) - Math.max(cur.y, r.y);
    } else {
      dist = dir === 'down' ? r.y - (cur.y + cur.h) : cur.y - (r.y + r.h);
      overlap = Math.min(cur.x + cur.w, r.x + r.w) - Math.max(cur.x, r.x);
    }
    if (dist < -eps || overlap <= eps) continue;
    if (!best || dist < best.dist - eps || (Math.abs(dist - best.dist) <= eps && overlap > best.overlap)) best = { id: pane.id, dist, overlap };
  }
  return best?.id;
}

/** Balanced grid of agent panes (rows of up to ceil(sqrt(n)) panes). */
export function gridLayout(agentIds: string[]): LayoutNode {
  const ids = agentIds.slice(0, MAX_CHILDREN);
  if (ids.length === 0) return makePane();
  if (ids.length === 1) return makePane('agent', ids[0]);
  const cols = Math.ceil(Math.sqrt(ids.length));
  const rows: LayoutNode[] = [];
  for (let i = 0; i < ids.length; i += cols) {
    const chunk = ids.slice(i, i + cols).map((a) => makePane('agent', a));
    rows.push(chunk.length === 1 ? chunk[0]! : { type: 'split', direction: 'row', sizes: chunk.map(() => 1), children: chunk });
  }
  return rows.length === 1 ? rows[0]! : { type: 'split', direction: 'column', sizes: rows.map(() => 1), children: rows };
}

export function twoColumns(a?: string, b?: string): LayoutNode {
  return {
    type: 'split',
    direction: 'row',
    sizes: [50, 50],
    children: [a ? makePane('agent', a) : makePane(), b ? makePane('agent', b) : makePane()],
  };
}

/** One big agent pane plus a sidebar with the attention queue and the board. */
export function focusSidebar(main?: string): LayoutNode {
  return {
    type: 'split',
    direction: 'row',
    sizes: [68, 32],
    children: [
      main ? makePane('agent', main) : makePane(),
      { type: 'split', direction: 'column', sizes: [40, 60], children: [makePane('attention'), makePane('board')] },
    ],
  };
}

const VIEWS: PaneView[] = ['agent', 'board', 'attention', 'empty'];

/** Validates a layout from the server or localStorage; returns null if unusable. Fixes duplicate ids and bad sizes. */
export function sanitize(input: unknown): LayoutNode | null {
  const seen = new Set<string>();
  const visit = (n: unknown, depth: number): LayoutNode | null => {
    if (!n || typeof n !== 'object' || depth > 12) return null;
    const o = n as Record<string, unknown>;
    if (o.type === 'pane') {
      const view = VIEWS.includes(o.view as PaneView) ? (o.view as PaneView) : 'empty';
      let id = typeof o.id === 'string' && o.id ? o.id : newPaneId();
      if (seen.has(id)) id = newPaneId();
      seen.add(id);
      const agentId = view === 'agent' && typeof o.agentId === 'string' ? o.agentId : undefined;
      return agentId ? { type: 'pane', id, view, agentId } : { type: 'pane', id, view: view === 'agent' ? 'empty' : view };
    }
    if (o.type === 'split' && Array.isArray(o.children)) {
      const direction: Direction = o.direction === 'column' ? 'column' : 'row';
      const pairs = o.children
        .slice(0, MAX_CHILDREN)
        .map((c, i) => [visit(c, depth + 1), Array.isArray(o.sizes) ? Number(o.sizes[i]) : NaN] as const)
        .filter((p): p is readonly [LayoutNode, number] => !!p[0]);
      if (!pairs.length) return null;
      const children = pairs.map((p) => p[0]);
      const sizes = pairs.map((p) => (Number.isFinite(p[1]) && p[1] > 0 ? p[1] : 1));
      return { type: 'split', direction, children, sizes };
    }
    return null;
  };
  const root = visit(input, 0);
  if (!root) return null;
  const norm = normalize(root);
  return listPanes(norm).length > MAX_PANES ? null : norm;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}
