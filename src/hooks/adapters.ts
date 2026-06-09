/**
 * Hook adapters: project the single VibeFlow hook protocol onto each engine's native
 * hook configuration. Every generated config delegates to one entrypoint — `vf hook` —
 * which reads a JSON event on stdin and returns an allow/warn/require_approval/block
 * decision (see hooks/runner.ts). One source of truth, three engines + git.
 *
 * Enforcement honesty: only Claude Code exposes a native pre-action vetoing hook
 * (PreToolUse). Codex and Copilot have no equivalent vetoing pre-* hook today, so we
 * wire them as DETECTION-ONLY (post-hoc events) and surface a downgrade banner instead
 * of advertising blocking we cannot actually honor.
 */

import type { Engine } from "../core.js";

/** Whether an engine can veto an action before it runs, or only detect after the fact. */
export interface EngineEnforcementCapability {
  preActionBlocking: "native" | "post-hoc-only";
}

const ENFORCEMENT: Record<Engine, EngineEnforcementCapability> = {
  claude: { preActionBlocking: "native" },
  codex: { preActionBlocking: "post-hoc-only" },
  copilot: { preActionBlocking: "post-hoc-only" },
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

/** Claude Code `.claude/settings.json` hooks section delegating to `vf hook`. */
export function claudeHookConfig(): string {
  const cmd = "vf hook";
  const delegate = [{ type: "command", command: cmd }];
  const config = {
    hooks: {
      // Writes are intercepted via PreToolUse with a tool-name matcher (PreWrite is not a
      // real Claude hook event — see code.claude.com/docs/en/hooks).
      PreToolUse: [
        { matcher: "Edit|Write", hooks: delegate },
        { matcher: "Bash", hooks: delegate },
      ],
      PostToolUse: [{ matcher: "Edit|Write", hooks: delegate }],
      Stop: [{ matcher: "*", hooks: delegate }],
    },
  };
  return JSON.stringify(config, null, 2);
}

/** Codex `.codex/hooks.json` — DETECTION-ONLY (post-hoc events; no vetoing pre-* hooks). */
export function codexHookConfig(): string {
  const config = {
    detectionOnly: true,
    hooks: {
      "post-command": "vf hook",
      "post-write": "vf hook",
      "verify-result": "vf hook",
    },
  };
  return JSON.stringify(config, null, 2);
}

/** Copilot `.github/copilot-hooks.json` — DETECTION-ONLY (post-hoc events only). */
export function copilotHookConfig(): string {
  const config = {
    detectionOnly: true,
    events: ["post-command", "post-write", "verify-result"],
    command: "vf hook",
  };
  return JSON.stringify(config, null, 2);
}

/**
 * A portable git pre-commit that funnels staged changes through `vf hook`. Fails CLOSED:
 * if `vf hook` errors or emits no decision the commit is blocked, and it stops on both
 * `block` and `require_approval`.
 */
export function gitPreCommit(): string {
  return [
    "#!/usr/bin/env sh",
    "# VibeFlow guardrail: route staged changes through the universal hook decision.",
    "# Fails closed — if the hook cannot decide, the commit is blocked.",
    "# Bypass intentionally with `git commit --no-verify` only when you know why.",
    "set -eu",
    "files=$(git diff --cached --name-only --diff-filter=ACM | sed 's/.*/\"&\"/' | paste -sd, -)",
    'event=$(printf \'{"event":"pre-write","files":[%s]}\' "$files")',
    "# Capture the decision; if vf hook fails to run, fail closed.",
    'if ! decision=$(printf "%s" "$event" | vf hook); then',
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
  return [
    "#!/usr/bin/env sh",
    "# VibeFlow: keep the code-navigation index in sync on branch change.",
    "# Args: $1=prev-HEAD $2=new-HEAD $3=branch-flag (1 = branch checkout).",
    '[ "${3:-0}" = "1" ] || exit 0',
    "vf tools sync >/dev/null 2>&1 || true",
    "",
  ].join("\n");
}

/** Re-index after a merge brings in new code (post-merge has no branch-flag arg). Best-effort. */
export function gitPostMerge(): string {
  return [
    "#!/usr/bin/env sh",
    "# VibeFlow: refresh the code-navigation index after a merge pulls in new code.",
    "vf tools sync >/dev/null 2>&1 || true",
    "",
  ].join("\n");
}

/** All engine hook configs as a path→content map for a target repo. */
export function engineHookFiles(): Record<string, string> {
  return {
    ".claude/settings.json": claudeHookConfig(),
    ".codex/hooks.json": codexHookConfig(),
    ".github/copilot-hooks.json": copilotHookConfig(),
    ".githooks/pre-commit": gitPreCommit(),
    ".githooks/post-checkout": gitPostCheckout(),
    ".githooks/post-merge": gitPostMerge(),
  };
}
