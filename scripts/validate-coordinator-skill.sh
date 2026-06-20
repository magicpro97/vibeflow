#!/usr/bin/env bash
# scripts/validate-coordinator-skill.sh
#
# Validate the coordinator SKILL.md is well-formed:
#   - file exists at .vibeflow/skills/coordinator/SKILL.md
#   - YAML frontmatter present with name: coordinator
#   - description and when_to_load keys present
#   - body has 6 sections (## 0 through ## 5; the 5 main sections + §5
#     "The brief is the source of truth" per the A2 #168 spec)
#
# This is the "skill is shipped" gate. Exits 0 on valid, 1 on invalid.
# Issue: A2 #168.

set -euo pipefail

REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
SKILL="$REPO_ROOT/.vibeflow/skills/coordinator/SKILL.md"

err() { echo "::error file=$SKILL::${1:-validation failed}" >&2; exit 1; }
[ -f "$SKILL" ] || err "SKILL.md not found at $SKILL"

# Frontmatter must open on line 1, close with ---, and contain name+description+when_to_load
head -1 "$SKILL" | grep -q '^---$' || err "missing opening --- on line 1"
awk 'NR==2{ok=1; exit} END{exit !ok}' "$SKILL" || err "line 2 must follow the opening ---"

FM_END="$(awk 'NR>1 && /^---$/{print NR; exit}' "$SKILL")"
[ -n "$FM_END" ] || err "missing closing --- for frontmatter"

FM="$(sed -n "2,$((FM_END - 1))p" "$SKILL")"
echo "$FM" | grep -qE '^name:[[:space:]]*coordinator[[:space:]]*$' || err "frontmatter missing 'name: coordinator'"
echo "$FM" | grep -qE '^description:[[:space:]]*.' || err "frontmatter missing 'description'"
echo "$FM" | grep -qE '^when_to_load:[[:space:]]*.' || err "frontmatter missing 'when_to_load'"

# Body must have the 6 required section headings (0, 1, 2, 3, 4, 5).
for n in 0 1 2 3 4 5; do
  grep -qE "^## ${n}\. " "$SKILL" || err "missing section '## ${n}. ...'"
done

echo "::notice::coordinator SKILL.md is well-formed (6 sections + frontmatter)"
