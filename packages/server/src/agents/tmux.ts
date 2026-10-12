/**
 * Agents run inside a dedicated tmux server in the sandbox. That gives us, for free:
 * persistence across control-plane restarts and client disconnects, scrollback for `agent.read`,
 * reliable input injection, multi-client interactive attach, and exit status via remain-on-exit.
 */
export const COCOON_DIR = '/opt/cocoon';
export const TMUX_CONF_PATH = `${COCOON_DIR}/tmux.conf`;
export const STATUS_DIR = `${COCOON_DIR}/status`;
export const STATUS_BIN = `${COCOON_DIR}/bin/cocoon-status`;
/** Staging dir for uploads (Docker cannot extract archives into tmpfs mounts like /tmp). */
export const STAGING_DIR = `${COCOON_DIR}/tmp`;

export const TMUX_CONF = [
  'set -g remain-on-exit on',
  'set -g history-limit 50000',
  'set -g status off',
  'set -g default-terminal "xterm-256color"',
  'set -g window-size latest',
  'set -g mouse on',
  'set -g focus-events on',
  'set -g extended-keys on',
  '',
].join('\n');

/** Called by agent hooks: `cocoon-status <working|blocked|done|idle>` (extra args are ignored). */
export const STATUS_SCRIPT = `#!/bin/sh
[ -n "$COCOON_AGENT_ID" ] || exit 0
printf '%s %s\\n' "$1" "$(date +%s%N)" > "${STATUS_DIR}/$COCOON_AGENT_ID.tmp" && mv "${STATUS_DIR}/$COCOON_AGENT_ID.tmp" "${STATUS_DIR}/$COCOON_AGENT_ID"
exit 0
`;

const tmux = (...args: string[]) => ['tmux', '-L', 'cocoon', '-f', TMUX_CONF_PATH, ...args];

/**
 * Starts the agent in a new tmux session. Its environment (API keys, tokens) is read from `envFile` – a private file the
 * session sources and deletes right away – so secrets never appear in a process command line on the host.
 */
export function newSession(opts: { name: string; cwd: string; command: string[]; envFile: string; cols?: number; rows?: number }): string[] {
  return tmux(
    'new-session', '-d',
    '-s', opts.name,
    '-x', String(opts.cols ?? 200),
    '-y', String(opts.rows ?? 50),
    '-c', opts.cwd,
    '--', 'sh', '-c', '. "$0"; rm -f "$0"; exec "$@"', opts.envFile, ...opts.command,
  );
}

/** Shell file exporting the given variables (sourced by newSession). */
export function envFileContent(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `export ${key}='${value.replace(/'/g, `'\\''`)}'\n`)
    .join('');
}

export const sendLiteral = (name: string, text: string) => tmux('send-keys', '-t', name, '-l', '--', text);
export const sendKeys = (name: string, keys: string[]) => tmux('send-keys', '-t', name, '--', ...keys);
export const capture = (name: string, lines: number) =>
  tmux('capture-pane', '-p', '-J', '-t', name, '-S', String(-lines));
export const killSession = (name: string) => tmux('kill-session', '-t', name);
export const attach = (name: string) => tmux('attach-session', '-t', name);

export const RECORD_SEP = '\x1e';

/**
 * One exec per sandbox per poll tick: for every session prints
 *   RS <hook report> TAB name TAB pane_dead TAB pane_dead_status TAB pane_current_command NL <visible screen>
 */
export function snapshotAll(screenLines: number): string[] {
  const t = `tmux -L cocoon -f ${TMUX_CONF_PATH}`;
  const script = `
for s in $(${t} list-sessions -F '#{session_name}' 2>/dev/null); do
  printf '${RECORD_SEP}%s\\t' "$(cat ${STATUS_DIR}/$s 2>/dev/null)"
  ${t} display-message -p -t "$s" '#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_current_command}'
  ${t} capture-pane -p -t "$s" -S -${screenLines}
done`;
  return ['sh', '-c', script];
}

export interface SessionSnapshot {
  name: string;
  dead: boolean;
  exitCode: number | null;
  foreground: string;
  /** Raw "<status> <nanos>" line written by the agent's hooks, or "". */
  reported: string;
  screen: string;
}

export function parseSnapshot(output: string): Map<string, SessionSnapshot> {
  const result = new Map<string, SessionSnapshot>();
  for (const record of output.split(RECORD_SEP)) {
    const nl = record.indexOf('\n');
    if (nl < 0) continue;
    const [reported, name, dead, status, foreground] = record.slice(0, nl).split('\t');
    if (!name) continue;
    const exitCode = status ? Number.parseInt(status, 10) : Number.NaN;
    result.set(name, {
      name,
      dead: dead === '1',
      exitCode: Number.isNaN(exitCode) ? null : exitCode,
      foreground: foreground ?? '',
      reported: reported?.trim() ?? '',
      screen: record.slice(nl + 1),
    });
  }
  return result;
}
