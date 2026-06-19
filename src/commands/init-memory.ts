// src/commands/init-memory.ts
//
// `vf init` Phase 1.5: the claude-mem opt-in. Prompts (on a TTY) whether to
// install claude-mem for spec/plan recall, persists the answer to
// settings.memory, and — when accepted — installs claude-mem (non-interactive,
// bounded) and appends the usage guide to WORKFLOW_POLICY.md.
//
// Design: docs/superpowers/specs/2026-06-18-claude-mem-integration-design.md.
// The setting records the opt-in but does NOT gate this prompt (config and
// init are independent, per the agreed semantics).
//
// Cross-module symbols come through the _shared barrel (cycle rule). The
// memory backend (src/memory.ts) is imported directly — it is not a sibling
// command, so the no-sibling-import rule does not apply.
import {
  appendMemoryGuide as realAppendMemoryGuide,
  ensureInstalled as realEnsureInstalled,
  isInstalled as realIsInstalled,
} from "../memory.js";
import { confirmInput } from "../terminal-prompts.js";
import { c, out, writeSettings } from "./_shared.js";

/** Injection seams so unit tests drive Phase 1.5 without a TTY or a real install. */
export interface MemoryPhaseInject {
  /** TTY probe. Defaults to `process.stdin.isTTY`. */
  isTTY?: () => boolean;
  /** Y/n prompt. Defaults to a `confirmInput` wrapper (default yes). */
  ask?: (question: string) => Promise<boolean>;
  isInstalled?: typeof realIsInstalled;
  ensureInstalled?: typeof realEnsureInstalled;
  appendMemoryGuide?: typeof realAppendMemoryGuide;
}

/**
 * Resolve the install decision from flags / TTY prompt.
 * Returns `true`/`false` when decided, or `null` to skip entirely
 * (non-TTY with no flag — neither install nor settings write).
 */
async function resolveDecision(
  flags: Record<string, string | boolean>,
  inject: MemoryPhaseInject,
): Promise<boolean | null> {
  if (flags.memory) return true;
  if (flags["no-memory"]) return false;
  const isTTY = inject.isTTY ?? (() => Boolean(process.stdin.isTTY));
  if (!isTTY()) return null;
  const ask = inject.ask ?? ((q: string) => confirmInput(q, true));
  return await ask("Install claude-mem for spec/plan recall?");
}

/**
 * Phase 1.5 entry point. `base` is the repo root. Best-effort throughout:
 * a failed install warns and continues; init never blocks on memory.
 */
export async function runMemoryPhase(
  base: string,
  flags: Record<string, string | boolean>,
  inject: MemoryPhaseInject = {},
): Promise<void> {
  const decision = await resolveDecision(flags, inject);
  if (decision === null) return; // non-TTY, no flag → silent skip

  // Persist the answer regardless of install outcome.
  writeSettings(base, { memory: decision });
  if (!decision) return;

  const isInstalled = inject.isInstalled ?? realIsInstalled;
  const ensureInstalled = inject.ensureInstalled ?? realEnsureInstalled;
  const appendGuide = inject.appendMemoryGuide ?? realAppendMemoryGuide;

  out("vf");
  out("vf", c.bold("claude-mem"));
  if (isInstalled()) {
    out("vf", c.dim("  claude-mem already installed."));
    if (appendGuide(base)) out("vf", c.green("  + memory guide added to WORKFLOW_POLICY.md"));
    return;
  }
  out("vf", c.cyan("  ▶ Installing claude-mem (non-interactive)..."));
  const res = await ensureInstalled({ cwd: base });
  if (res.ok) {
    out("vf", c.green("  ✔ claude-mem installed"));
    if (appendGuide(base)) out("vf", c.green("  + memory guide added to WORKFLOW_POLICY.md"));
  } else {
    out("vf", c.yellow(`  ! claude-mem install failed — continuing (${res.reason ?? "unknown"})`));
  }
}
