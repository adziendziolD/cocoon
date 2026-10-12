/**
 * Sections CoCoon writes into the user-level memory file of every agent CLI (e.g. which repositories and shared
 * services a sandbox has). Each section sits between its own markers and is replaced on every write.
 */
export const AGENT_NOTE_FILES = ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.config/opencode/AGENTS.md', '.pi/agent/AGENTS.md', '.gemini/GEMINI.md', '.qwen/QWEN.md'];

/** Shell script (run as the sandbox user) that replaces section `key` with $NOTES (empty $NOTES removes it). */
export function agentNotesScript(key: string): string {
  const start = `<!-- cocoon-${key}:start -->`;
  const end = `<!-- cocoon-${key}:end -->`;
  return `for rel in ${AGENT_NOTE_FILES.join(' ')}; do
  f="$HOME/$rel"; mkdir -p "$(dirname "$f")"
  if [ -f "$f" ]; then sed -i '/${start}/,/${end}/d' "$f"; fi
  [ -n "$NOTES" ] && printf '%s\\n%s\\n%s\\n' '${start}' "$NOTES" '${end}' >> "$f"
  [ -s "$f" ] || rm -f "$f"
done`;
}
