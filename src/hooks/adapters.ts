/**
 * Hook adapters: project the single VibeFlow hook protocol onto each engine's native
 * hook configuration. Every generated config delegates to one entrypoint — `vf hook` —
 * which reads a JSON event on stdin and returns an allow/warn/require_approval/block
 * decision (see hooks/runner.ts). One source of truth, three engines + git.
 *
 * Enforcement honesty: as of issue #79, Claude Code AND GitHub Copilot CLI both expose
 * a native pre-action vetoing hook (PreToolUse / preToolUse, fail-closed). Codex CLI
 * has no equivalent vetoing pre-tool hook today, so we wire it as DETECTION-ONLY
 * (post-hoc events) and surface a downgrade banner instead of advertising blocking
 * we cannot actually honor.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine } from "../core.js";

/** Resolve the absolute path to dist/cli.js (or src/cli.ts in dev). */
function cliPath(): string {
  const self = fileURLToPath(import.meta.url);
  const normalized = self.replace(/\\/g, "/");
  if (normalized.endsWith("/dist/cli.js")) return self;
  // In dev (bun test / ts-node): self is src/hooks/adapters.ts → walk up to root then dist/.
  const root = join(dirname(self), "..", "..");
  return join(root, "dist", "cli.js");
}

/** Whether an engine can veto an action before it runs, or only detect after the fact. */
export interface EngineEnforcementCapability {
  preActionBlocking: "native" | "post-hoc-only";
}

const ENFORCEMENT: Record<Engine, EngineEnforcementCapability> = {
  claude: { preActionBlocking: "native" },
  codex: { preActionBlocking: "post-hoc-only" },
  copilot: { preActionBlocking: "native" },
};

/** Report whether an engine enforces guardrails natively or post-hoc only. */
export function engineEnforcement(engine: Engine): EngineEnforcementCapability {
  return ENFORCEMENT[engine];
}

/**
 * Reusable warning shown when an engine cannot veto actions before they run. Empty for
 * engines with native blocking. commands.ts calls this to print the banner.
 */
export function downgradeBannerText(engine: Engine): string {
  if (engineEnforcement(engine).preActionBlocking === "native") return "";
  return `! ${engine}: detection-only guardrails. This engine has no vetoing pre-action hook, so VibeFlow can only flag risky actions after they happen (post-command/post-write/verify-result), not block them beforehand. Use Claude Code for native blocking.`;
}

/** Per-command warning for detection-only engines. Empty for native engines. */
export function perCommandWarning(engine: Engine): string {
  if (engineEnforcement(engine).preActionBlocking === "native") return "";
  return `! ${engine}: detection-only — this action was flagged but NOT blocked. Use Claude Code for native blocking.`;
}

/** Claude Code `.claude/settings.json` hooks section delegating to `vf hook`.
 *  Uses absolute path so the subprocess always finds the CLI regardless of PATH. */
export function claudeHookConfig(): string {
  const cmd = cliPath();
  // Exec form (`command` + `args`), NOT a shell string: Claude spawns argv directly with no
  // shell, so an absolute path containing a space, `$`, or a backtick is passed verbatim.
  // A shell-string `node "<path>" hook` only survives spaces — `$`/backtick still expand
  // inside double quotes and make `node` load the wrong path (the hook then exits non-zero
  // with no JSON; per the hooks spec that is a NON-blocking error, so the tool call still
  // runs but the guardrail is silently skipped and a stack trace is shown).
  const delegate = [{ type: "command", command: "node", args: [cmd, "hook"] }];
  const config = {
    hooks: {
      PreToolUse: [
        { matcher: "Edit|Write", hooks: delegate },
        { matcher: "Bash", hooks: delegate },
      ],
      PostToolUse: [{ matcher: "Edit|Write", hooks: delegate }],
      Stop: [{ matcher: "", hooks: delegate }],
    },
  };
  return JSON.stringify(config, null, 2);
}

/** Codex `.codex/hooks.json` — DETECTION-ONLY (post-hoc events; no vetoing pre-* hooks).
 *  NOTE: this emits a VibeFlow-internal schema ({detectionOnly, hooks:{"post-command":…}}),
 *  which does NOT match Codex's native hooks schema (PascalCase events + matcher, like Claude's).
 *  Reconciling that is a separate change; here we only keep the path double-quoted so it at
 *  least survives spaces. The quote does NOT survive `$`/backtick in the path — the robust
 *  exec form used by claudeHookConfig isn't applied until the schema question is resolved. */
export function codexHookConfig(): string {
  const cmd = cliPath();
  const config = {
    detectionOnly: true,
    hooks: {
      "post-command": `node "${cmd}" hook`,
      "post-write": `node "${cmd}" hook`,
      "verify-result": `node "${cmd}" hook`,
    },
  };
  return JSON.stringify(config, null, 2);
}

/** Build a shell command that runs `vf hook` with the absolute CLI path.
 *  Path is double-quoted to survive spaces on POSIX paths like `/Users/linhn/foo bar/...`
 *  and Windows paths like `C:\Program Files\...`. `hook` is a literal arg.
 *  The trailing `# vibeflow-guardrail` marker is consumed as a bash/sh comment and is
 *  also the stable string the `liveGuardrailArmed` probe matches against (issue #79
 *  re-review: the previous `vf hook` substring never appeared in real generated configs
 *  because generators emit `node "<abs>" hook`, not `vf hook`). */
function hookCommand(): string {
  return `"${cliPath()}" hook # vibeflow-guardrail`;
}

/** Copilot `.github/hooks/copilot.json` — NATIVE enforcement via preToolUse (fail-closed).
 *  Per docs.github.com/en/copilot/reference/hooks-reference:
 *    - preToolUse: non-zero exit DENIES the tool call (fail-closed)
 *    - postToolUse: can inject additionalContext
 *  Schema: {version:1, hooks:{<camelCaseEvent>:[{type:"command", bash, powershell, timeoutSec}]}}
 *  `bash` covers POSIX, `powershell` covers Windows — Copilot picks by host OS. */
export function copilotHookConfig(): string {
  const cmd = hookCommand();
  const config = {
    version: 1,
    hooks: {
      preToolUse: [{ type: "command", bash: cmd, powershell: cmd, timeoutSec: 60 }],
      postToolUse: [{ type: "command", bash: cmd, powershell: cmd, timeoutSec: 30 }],
    },
  };
  return JSON.stringify(config, null, 2);
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

/** All engine hook configs as a path→content map for a target repo. */
export function engineHookFiles(): Record<string, string> {
  return {
    ".claude/settings.json": claudeHookConfig(),
    ".codex/hooks.json": codexHookConfig(),
    ".github/hooks/copilot.json": copilotHookConfig(),
    ".githooks/pre-commit": gitPreCommit(),
    ".githooks/post-checkout": gitPostCheckout(),
    ".githooks/post-merge": gitPostMerge(),
  };
}
