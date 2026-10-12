import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { wsUrl } from '../api/rpc';
import { t as tGlobal, type TFunction } from '../i18n';
import { cn } from '../lib/cn';

export type TerminalState = { kind: 'connecting' } | { kind: 'open' } | { kind: 'closed'; code: number; reason: string };

const THEME = {
  background: '#0b0e14',
  foreground: '#d7dce4',
  cursor: '#a5b4fc',
  selectionBackground: '#3b4261',
  black: '#1d2129',
  brightBlack: '#5c6370',
  red: '#f07178',
  brightRed: '#ff8b92',
  green: '#a6da95',
  brightGreen: '#c3e88d',
  yellow: '#eed49f',
  brightYellow: '#ffcb6b',
  blue: '#82aaff',
  brightBlue: '#9cc4ff',
  magenta: '#c792ea',
  brightMagenta: '#e1acff',
  cyan: '#89ddff',
  brightCyan: '#a3f7ff',
  white: '#d7dce4',
  brightWhite: '#ffffff',
};

/**
 * Interactive terminal attached to an agent's tmux session via `WS /v1/agents/:id/attach`.
 * Binary frames carry terminal bytes in both directions; resizes are sent as JSON text frames.
 * Change `connectKey` to force a reconnect; change `focusSignal` to move keyboard focus into the terminal.
 * The terminal fits itself to its container (ResizeObserver), so it can live in resizable panes.
 */
export function AgentTerminal({
  agentId,
  connectKey = 0,
  onStateChange,
  className,
  autoFocus = true,
  focusSignal,
  fontSize = 13,
}: {
  agentId: string;
  connectKey?: number;
  onStateChange?: (s: TerminalState) => void;
  className?: string;
  /** Focus the terminal as soon as it is connected. */
  autoFocus?: boolean;
  focusSignal?: number;
  fontSize?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const stateCb = useRef(onStateChange);
  stateCb.current = onStateChange;
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    safeFit(fit);

    const encoder = new TextEncoder();
    const ws = new WebSocket(wsUrl(`/v1/agents/${encodeURIComponent(agentId)}/attach`, { cols: term.cols, rows: term.rows }));
    ws.binaryType = 'arraybuffer';
    stateCb.current?.({ kind: 'connecting' });

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onopen = () => {
      stateCb.current?.({ kind: 'open' });
      safeFit(fit);
      sendResize();
      if (autoFocusRef.current) term.focus();
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
      else term.write(String(ev.data));
    };
    ws.onclose = (ev) => {
      stateCb.current?.({ kind: 'closed', code: ev.code, reason: ev.reason });
      term.options.cursorBlink = false;
    };

    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(d));
    });
    const binSub = term.onBinary((d) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const bytes = new Uint8Array(d.length);
      for (let i = 0; i < d.length; i++) bytes[i] = d.charCodeAt(i) & 0xff;
      ws.send(bytes);
    });
    const resizeSub = term.onResize(sendResize);

    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => safeFit(fit));
    });
    ro.observe(host);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      dataSub.dispose();
      binSub.dispose();
      resizeSub.dispose();
      ws.onclose = null;
      ws.close();
      termRef.current = null;
      term.dispose();
    };
    // fontSize is applied live below, no reconnect needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, connectKey]);

  useEffect(() => {
    if (focusSignal !== undefined) termRef.current?.focus();
  }, [focusSignal]);

  useEffect(() => {
    const term = termRef.current;
    if (term && term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
  }, [fontSize]);

  return <div ref={hostRef} className={cn('xterm-host h-full w-full overflow-hidden bg-[#0b0e14]', className)} />;
}

function safeFit(fit: FitAddon) {
  try {
    fit.fit();
  } catch {
    // Container not laid out yet (e.g. hidden tab) – the ResizeObserver retries later.
  }
}

/** Human-readable reason for a closed attach socket. */
export function describeClose(s: Extract<TerminalState, { kind: 'closed' }>, t: TFunction = tGlobal): string {
  if (s.reason) return s.reason;
  if (s.code === 1000) return t('terminal.closedNormal');
  if (s.code === 1006) return t('terminal.closedUnexpected');
  return t('terminal.closedCode', { code: String(s.code) });
}
