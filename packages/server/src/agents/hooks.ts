import { STATUS_BIN } from './tmux.ts';

/**
 * Native status hooks for agent CLIs, installed once per sandbox (as the sandbox user).
 * Claude Code: hooks in ~/.claude/settings.json. Codex: `notify` program in ~/.codex/config.toml.
 */
const claudeHook = (status: string) => [{ type: 'command', command: `${STATUS_BIN} ${status}` }];

export const CLAUDE_SETTINGS = JSON.stringify(
  {
    hooks: {
      UserPromptSubmit: [{ hooks: claudeHook('working') }],
      PreToolUse: [{ matcher: '*', hooks: claudeHook('working') }],
      PostToolUse: [{ matcher: '*', hooks: claudeHook('working') }],
      Notification: [{ matcher: 'permission_prompt', hooks: claudeHook('blocked') }],
      Stop: [{ hooks: claudeHook('done') }],
    },
  },
  null,
  2,
);

/** Skips Claude Code's first-run onboarding and trust dialogs inside the sandbox. */
export const claudeStateSeed = (workdir: string) =>
  JSON.stringify({
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    theme: 'dark',
    projects: { [workdir]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  });

export const CODEX_NOTIFY = `notify = ["${STATUS_BIN}", "done"]`;

/** Shell script (run as sandbox user) installing the hook configs if not already present. */
export const installHooksScript = `
set -e
mkdir -p "$HOME/.claude" "$HOME/.codex"
[ -f "$HOME/.claude/settings.json" ] || printf '%s' "$CLAUDE_SETTINGS" > "$HOME/.claude/settings.json"
[ -f "$HOME/.claude.json" ] || printf '%s' "$CLAUDE_STATE" > "$HOME/.claude.json"
if ! grep -q '^notify' "$HOME/.codex/config.toml" 2>/dev/null; then
  { printf '%s\\n' "$CODEX_NOTIFY"; cat "$HOME/.codex/config.toml" 2>/dev/null || true; } > "$HOME/.codex/config.toml.new"
  mv "$HOME/.codex/config.toml.new" "$HOME/.codex/config.toml"
fi
`;

/** Pre-approves an API key for Claude Code (it otherwise asks interactively). Needs node in the sandbox. */
export const approveClaudeKeyScript = `
node -e '
const fs = require("fs"), f = process.env.HOME + "/.claude.json";
let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
const r = s.customApiKeyResponses ??= { approved: [], rejected: [] };
r.approved ??= [];
const tail = process.env.KEY_TAIL;
if (!r.approved.includes(tail)) r.approved.push(tail);
fs.writeFileSync(f, JSON.stringify(s, null, 2));
' 2>/dev/null || true
`;
