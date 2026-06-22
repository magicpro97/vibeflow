// src/commands/seams.ts
//
// Test seams + diagnostic helpers for the per-subcommand files. These
// are symbols that production code uses internally but that tests /
// the CLI need to reach into. Issue #80, phase 2/14.
//
// Currently:
// - `tipState` + `resetTipStateForTests` — the "watch live" tip in
//   `orchestrate` is once-only per process. Tests reset the flag so
//   they can exercise the tip branch in isolation.
// - `liveGuardrailArmed` + `guardrailOffNote` + helpers — diagnostic
//   functions the `doctor` and `init` subcommands call to report
//   whether the live PreToolUse guardrail is wired up. The doctor
//   table needs both as separate symbols; they moved here so the
//   `doctor` extraction (PR3) does not have to reach back into
//   `src/commands.ts` for them.
//
// No subcommand file may import from this module directly except via
// `./_shared.js` (the ESM cycle rule). For now, the public surface of
// the facade (`src/commands.ts`) re-exports these symbols so existing
// callers keep working without modification.

import { c, join, readFileSync } from "./_shared.js";

/** Global state: the "watch live" tip prints at most once per process. */
// Test seam: exported so unit tests can reset the once-only tip
// flag before exercising it. Production callers never call this —
// the tip is genuinely once-only per process.
export const tipState = { shown: false };

export function resetTipStateForTests(): void {
  tipState.shown = false;
}

/** Stable sentinel embedded by `hookCommand()` in every generated shell command.
 *  Used by `liveGuardrailArmed` to detect a real config (issue #79 re-review: the
 *  earlier `vf hook` substring never matched real generator output, which emits
 *  `node "<abs>" hook` for Claude and `"<abs>" hook # vibeflow-guardrail` for Copilot). */
const GUARDRAIL_SENTINEL = "vibeflow-guardrail";

export function liveGuardrailArmed(base: string): boolean {
  // Claude Code: .claude/settings.json with a PreToolUse entry that delegates to `vf hook`.
  if (liveGuardrailArmedClaude(base)) return true;
  // GitHub Copilot CLI: .github/hooks/copilot.json with a preToolUse entry that
  // delegates to `vf hook` (issue #79 — Copilot's preToolUse is fail-closed).
  if (liveGuardrailArmedCopilot(base)) return true;
  // Codex: no native pre-tool veto today, so its config alone does not arm the guardrail.
  return false;
}

function liveGuardrailArmedClaude(base: string): boolean {
  try {
    const raw = readFileSync(join(base, ".claude", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: unknown; args?: unknown }> }> };
    };
    const pre = parsed.hooks?.PreToolUse;
    if (!Array.isArray(pre)) return false;
    return pre.some((entry) =>
      (entry.hooks ?? []).some((h) => hookDelegatesToVibeflow(h.command, h.args)),
    );
  } catch {
    return false;
  }
}

function liveGuardrailArmedCopilot(base: string): boolean {
  try {
    const raw = readFileSync(join(base, ".github", "hooks", "copilot.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      hooks?: { preToolUse?: Array<{ bash?: unknown; powershell?: unknown }> };
    };
    const pre = parsed.hooks?.preToolUse;
    if (!Array.isArray(pre)) return false;
    return pre.some((entry) => {
      const bash = typeof entry.bash === "string" ? entry.bash : "";
      const ps = typeof entry.powershell === "string" ? entry.powershell : "";
      return commandDelegatesToVibeflow(bash) || commandDelegatesToVibeflow(ps);
    });
  } catch {
    return false;
  }
}

/** Returns true iff a shell command line was emitted by VibeFlow's hook generator.
 *  Matches on either the `# vibeflow-guardrail` sentinel (Copilot; bash/sh comment)
 *  or a trailing `dist/cli.js` argv token followed by `hook` (Claude shell-string variant).
 *  The path may be quoted (`node "<abs>/dist/cli.js" hook`) so an optional closing quote is
 *  allowed between the path and `hook`. Both are stable markers hand-written configs won't contain. */
function commandDelegatesToVibeflow(cmd: string): boolean {
  if (cmd.includes(GUARDRAIL_SENTINEL)) return true;
  // Match Claude's pattern: `node /abs/path/dist/cli.js hook` or the quoted variant.
  return /dist\/cli\.js"?\s+hook\b/.test(cmd);
}

/** True iff a Claude hook entry delegates to `vf hook`, covering BOTH forms the generator
 *  may emit: the exec form (`command:"node", args:["<abs>/dist/cli.js","hook"]`) and the
 *  legacy shell-string form (`command:"node \"<abs>/dist/cli.js\" hook"`). Exec form is the
 *  current generator output; the string check keeps older configs recognized. */
function hookDelegatesToVibeflow(command: unknown, args: unknown): boolean {
  // Exec form: the cli.js path is an element of args, with "hook" present too.
  if (Array.isArray(args)) {
    const strs = args.filter((a): a is string => typeof a === "string");
    if (strs.some((a) => /dist\/cli\.js$/.test(a)) && strs.includes("hook")) return true;
  }
  // Shell-string form: everything is in the command string.
  return typeof command === "string" && commandDelegatesToVibeflow(command);
}

/** A loud, actionable note when the live guardrail is OFF — silence reads as "protected". */
export function guardrailOffNote(): string {
  return c.yellow(
    "live guardrail: OFF — risky tool calls are NOT intercepted. Run `vf hooks emit --yes` to arm the PreToolUse gate.",
  );
}
