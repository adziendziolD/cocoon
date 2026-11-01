import { SKILLS_DIR, type AgentAdapter } from '@cocoon/protocol';
import { GIT_HARDENED_SH } from '../sandbox/git-auth.ts';

/** Folder below $HOME in which the agent CLI of this adapter looks for skills (undefined = no skill support). */
export function skillsDirFor(adapter: AgentAdapter): string | undefined {
  return SKILLS_DIR[adapter];
}

/**
 * Installs skills from a GitHub repository into $HOME/$SKILLS_DIR (run in the sandbox as the agent user).
 * - SKILL_PATH points at a skill folder (containing SKILL.md) → installed as SKILL_NAME.
 * - Otherwise every skill folder directly below the path (or below its "skills/" folder) is installed.
 * Input env: SKILLS_DIR, SKILL_URL, SKILL_REF, SKILL_PATH, SKILL_NAME. Path and name are checked again here (no "..",
 * no absolute paths, name is a single folder name) although parseSkillSource already validates them.
 */
export const INSTALL_SKILL_SCRIPT = `set -e
bad() { echo "invalid skill name or path" >&2; exit 1; }
[ -z "$SKILL_PATH" ] || case "/$SKILL_PATH/" in */../*|*//*) bad;; esac
case "/$SKILLS_DIR/" in */../*|*//*) bad;; esac
case "$SKILL_NAME" in ''|.|..|*[!A-Za-z0-9._-]*) bad;; esac
${GIT_HARDENED_SH}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
if [ -n "$SKILL_REF" ]; then cgit clone --quiet --depth 1 --branch "$SKILL_REF" -- "$SKILL_URL" "$TMP/r"; else cgit clone --quiet --depth 1 -- "$SKILL_URL" "$TMP/r"; fi
SRC="$TMP/r"; [ -z "$SKILL_PATH" ] || SRC="$TMP/r/$SKILL_PATH"
[ -d "$SRC" ] || { echo "folder not found in repository: $SKILL_PATH" >&2; exit 1; }
DEST="$HOME/$SKILLS_DIR"; mkdir -p "$DEST"
put() { rm -rf "$DEST/$2"; cp -R "$1" "$DEST/$2"; rm -rf "$DEST/$2/.git"; }
if [ -f "$SRC/SKILL.md" ]; then put "$SRC" "$SKILL_NAME"; exit 0; fi
found=0
for d in "$SRC"/*/ "$SRC"/skills/*/; do
  d="\${d%/}"
  if [ -f "$d/SKILL.md" ]; then put "$d" "$(basename "$d")"; found=1; fi
done
[ "$found" = 1 ] || { echo "no SKILL.md found" >&2; exit 1; }`;
