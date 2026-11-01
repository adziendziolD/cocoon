import { CocoonError } from '../errors.ts';
import { t } from '../i18n.ts';

/**
 * Agents run inside a dedicated tmux server in the sandbox. That gives us, for free:
 * persistence across control-plane restarts and client disconnects, scrollback for `agent.read`,
 * reliable input injection, multi-client interactive attach, and exit status via remain-on-exit.
 */
export const COCOON_DIR = '/opt/cocoon';
export const TMUX_CONF_PATH = `${COCOON_DIR}/tmux.conf`;
export const STATUS_DIR = `${COCOON_DIR}/status`;
/** The agent user in every sandbox (see sandbox/bwrap.ts and the image). */
export const AGENT_UID = 1000;
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

/**
 * Root-side setup of the shared CoCoon directories. The status dir belongs to the agent user and is not writable by other
 * users (it used to be 1777); where the chown is not possible (bubblewrap maps only one uid per namespace) it stays 1777,
 * which is harmless there because root and the agent are the same host user. The staging dir stays world-writable
 * because uploads from the host land there.
 */
export const sharedDirsScript = (cocoonDir = COCOON_DIR): string => {
  const status = `${cocoonDir}/status`;
  const staging = `${cocoonDir}/tmp`;
  return `mkdir -p ${cocoonDir}/bin ${status} ${staging} && { { chown ${AGENT_UID}:${AGENT_UID} ${status} 2>/dev/null && chmod 755 ${status}; } || chmod 1777 ${status}; } && chmod 1777 ${staging}`;
};

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

/** Names the env file may export: the key is interpolated into shell code, so anything else would be injection. */
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shell file exporting the given variables (sourced by newSession). */
export function envFileContent(env: Record<string, string>): string {
  for (const key of Object.keys(env)) if (!ENV_KEY.test(key)) throw new CocoonError('bad_request', t('error.envKeyInvalid', { key: key.slice(0, 64) }));
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
  return ['sh', '-c', snapshotScript(t, screenLines)];
}

/**
 * Everything an agent controls (status file, process name, screen) is stripped of control characters before it reaches
 * the output: a record separator in it would let an agent forge the records of other agents. Only tab and newline stay
 * in the display-message header and the screen (the header needs them as delimiters).
 */
export function snapshotScript(tmuxCommand: string, screenLines: number, statusDir = STATUS_DIR): string {
  const allControl = `tr -d '\\000-\\037\\177'`;
  const keepTabNewline = `tr -d '\\000-\\010\\013-\\037\\177'`;
  return `
for s in $(${tmuxCommand} list-sessions -F '#{session_name}' 2>/dev/null); do
  printf '${RECORD_SEP}%s\\t' "$(cat ${statusDir}/$s 2>/dev/null | ${allControl})"
  ${tmuxCommand} display-message -p -t "$s" '#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_current_command}' | ${keepTabNewline}
  ${tmuxCommand} capture-pane -p -t "$s" -S -${screenLines} | ${keepTabNewline}
done`;
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
