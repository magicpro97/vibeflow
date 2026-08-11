/**
 * Git hook generators. Moved byte-equivalently out of hooks/adapters.ts (issue
 * #748 — adapters.ts hit the 400-line cap). `cliPath` + the three shell hook
 * generators live here; `gitPrePush` (the #748 current-HEAD review-evidence
 * gate) is new. adapters.ts imports/re-exports these so existing call sites and
 * tests keep working untouched.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the absolute path to dist/cli.js (or src/cli.ts in dev). */
export function cliPath(): string {
  const self = fileURLToPath(import.meta.url);
  const normalized = self.replace(/\\/g, "/");
  if (normalized.endsWith("/dist/cli.js")) return self;
  // In dev (bun test / ts-node): self is src/hooks/git-hooks.ts → walk up to root then dist/.
  const root = join(dirname(self), "..", "..");
  return join(root, "dist", "cli.js");
}

/**
 * A portable git pre-commit that funnels staged files through `vf hook`. Fails CLOSED:
 * command not found or empty decision → block. Calls `node <absolute-path> hook`.
 */
export function gitPreCommit(): string {
  const cmd = cliPath();
  return [
    "#!/usr/bin/env sh",
    "# VibeFlow guardrail: route staged changes through the universal hook decision.",
    "# Fails closed — if the hook cannot decide, the commit is blocked.",
    "# Bypass intentionally with `git commit --no-verify` only when you know why.",
    "set -eu",
    "files=$(git diff --cached --name-only --diff-filter=ACM | sed 's/.*/\"&\"/' | paste -sd, -)",
    'event=$(printf \'{"event":"pre-write","files":[%s]}\' "$files")',
    "# Capture the decision; if node fails to run, fail closed.",
    `if ! decision=$(printf "%s" "$event" | node "${cmd}" hook); then`,
    '  echo "vibeflow hook: could not evaluate changes — blocking (fail-closed)" >&2',
    "  exit 1",
    "fi",
    'echo "$decision"',
    'case "$decision" in',
    '  *\\"decision\\":\\"block\\"*) echo "blocked by VibeFlow hook" >&2; exit 1 ;;',
    '  *\\"decision\\":\\"require_approval\\"*) echo "VibeFlow hook needs approval — blocking commit; review then --no-verify if intended" >&2; exit 1 ;;',
    '  "") echo "vibeflow hook: empty decision — blocking (fail-closed)" >&2; exit 1 ;;',
    "esac",
    `ie_output=$(node "${cmd}" skills impact-evidence --staged 2>&1) || { echo "$ie_output" >&2; exit 1; }`,
    'echo "vibeflow hook: allowed"',
    "",
  ].join("\n");
}

/** Re-index code-navigation tools when the working tree's branch changes, so a code graph
 * never goes stale. `post-checkout` gets ($1 prev, $2 new, $3 flag); flag=1 means a branch
 * checkout (vs a file checkout) — only then is a re-index warranted. Best-effort: never
 * blocks the checkout (|| true), and `vf tools sync` itself is a no-op unless codegraph is
 * enabled AND its binary is present. */
export function gitPostCheckout(): string {
  const cmd = cliPath();
  return [
    "#!/usr/bin/env sh",
    "# VibeFlow: keep the code-navigation index in sync on branch change.",
    "# Args: $1=prev-HEAD $2=new-HEAD $3=branch-flag (1 = branch checkout).",
    '[ "${3:-0}" = "1" ] || exit 0',
    `node "${cmd}" tools sync >/dev/null 2>&1 || true`,
    "",
  ].join("\n");
}

/** Re-index after a merge brings in new code (post-merge has no branch-flag arg). Best-effort. */
export function gitPostMerge(): string {
  const cmd = cliPath();
  return [
    "#!/usr/bin/env sh",
    "# VibeFlow: refresh the code-navigation index after a merge pulls in new code.",
    `node "${cmd}" tools sync >/dev/null 2>&1 || true`,
    "",
  ].join("\n");
}

/**
 * #748 pre-push gate. POSIX sh reading git's stdin records:
 *   <local-ref> <local-sha> <remote-ref> <remote-sha>
 * Ignores tags/deletions, requires pushed local refs to equal current HEAD,
 * derives a review base (existing branch = remote sha; new branch = merge-base
 * against the remote's HEAD), then runs `review check --base <base>` once — an
 * evidence-only check that never launches the toolchain. Any failure blocks.
 * `verifyCmd` overrides the delegated command (test seam); the dogfood
 * .githooks/pre-push swaps it to bun.
 */
export function gitPrePush(verifyCmd?: string): string {
  const verify = verifyCmd ?? `node "${cliPath()}"`;
  return [
    "#!/usr/bin/env sh",
    "# VibeFlow pre-push gate: block pushes without current-HEAD review evidence.",
    "# # vibeflow-managed — generated; re-run `vf hooks install` (or `vf init`) to refresh.",
    "# Fails closed: missing/current-HEAD mismatched/any evidence-check failure blocks.",
    "# Bypass with `git push --no-verify` — remote `review-thread-gate` (CI) stays authoritative.",
    "set -eu",
    'remote_name="${1:-origin}"',
    'base=""',
    "count=0",
    "while read -r local_ref local_sha remote_ref remote_sha; do",
    '  case "$local_ref" in refs/heads/*) ;; *) continue ;; esac',
    '  if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then continue; fi',
    "  head_sha=$(git rev-parse --verify HEAD)",
    '  if [ "$local_sha" != "$head_sha" ]; then',
    '    echo "vibeflow pre-push: refusing $local_ref — pushed sha $local_sha is not current HEAD ($head_sha)." >&2',
    '    echo "Check out the branch you intend to push, then push again." >&2',
    "    exit 1",
    "  fi",
    '  if [ "$remote_sha" != "0000000000000000000000000000000000000000" ]; then',
    '    candidate="$remote_sha"',
    "  else",
    '    if ! candidate=$(git merge-base HEAD "refs/remotes/${remote_name}/HEAD" 2>/dev/null); then',
    '      echo "vibeflow pre-push: cannot resolve review base for new branch $local_ref" >&2',
    '      echo "Run review evidence first, or push with --no-verify (CI stays authoritative)." >&2',
    "      exit 1",
    "    fi",
    "  fi",
    '  if [ -n "$base" ] && [ "$base" != "$candidate" ]; then',
    '    echo "vibeflow pre-push: multi-branch push with different review bases — push one branch at a time." >&2',
    "    exit 1",
    "  fi",
    '  base="$candidate"',
    "  count=$((count + 1))",
    "done",
    'if [ "$count" -eq 0 ]; then exit 0; fi',
    'if ! @@VF_VERIFY@@ review check --base "$base"; then',
    '  echo "vibeflow pre-push: review evidence required but missing/invalid for $base" >&2',
    '  echo "Run vf review evidence --base <base> --result <review-result.json>, then" >&2',
    '  echo "vf review check --base <base>." >&2',
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ]
    .join("\n")
    .replace("@@VF_VERIFY@@", verify);
}
