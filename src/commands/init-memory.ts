// src/commands/init-memory.ts
//
// `vf init` Phase 1.5: the claude-mem opt-in. Prompts (on a TTY) whether to
// install claude-mem for spec/plan recall, persists the answer to
// settings.memory, and — when accepted — wires claude-mem for the workflow's
// chosen engines (one shared ~/.claude-mem store, one IDE hook per engine)
// and appends the usage guide to WORKFLOW_POLICY.md.
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
  ensureInstalledForEngines as realEnsureInstalledForEngines,
} from "../memory.js";
import { confirmInput } from "../terminal-prompts.js";
import { type Engine, c, out, writeSettings } from "./_shared.js";

/** Injection seams so unit tests drive Phase 1.5 without a TTY or a real install. */
export interface MemoryPhaseInject {
  /** TTY probe. Defaults to `process.stdin.isTTY`. */
  isTTY?: () => boolean;
  /** Y/n prompt. Defaults to a `confirmInput` wrapper (default yes). */
  ask?: (question: string) => Promise<boolean>;
  /** Per-engine wiring. Defaults to the real {@link realEnsureInstalledForEngines}. */
  ensureInstalledForEngines?: typeof realEnsureInstalledForEngines;
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
  return await ask("Install claude-mem for spec/plan recall (shared across your engines)?");
}

/**
 * Phase 1.5 entry point. `base` is the repo root; `engines` are the workflow's
 * chosen engines (claude-mem wires one IDE hook per engine over a single shared
 * store). Best-effort throughout: a per-engine failure warns and continues; a
 * decline persists the setting and skips install; init never blocks on memory.
 */
export async function runMemoryPhase(
  base: string,
  flags: Record<string, string | boolean>,
  engines: Engine[],
  inject: MemoryPhaseInject = {},
): Promise<void> {
  const decision = await resolveDecision(flags, inject);
  if (decision === null) return; // non-TTY, no flag → silent skip

  // Persist the answer regardless of install outcome.
  writeSettings(base, { memory: decision });
  if (!decision) return;

  const wireEngines = inject.ensureInstalledForEngines ?? realEnsureInstalledForEngines;
  const appendGuide = inject.appendMemoryGuide ?? realAppendMemoryGuide;

  // Defensive: init always carries at least the default engine, but never wire
  // an empty list (it would install nothing yet claim success).
  const targets = engines.length ? engines : (["claude"] as Engine[]);

  out("vf");
  out("vf", c.bold("claude-mem"));
  out(
    "vf",
    c.cyan(
      `  ▶ Wiring claude-mem for ${targets.join(", ")} — first run downloads the plugin (~1–2 min)…`,
    ),
  );
  const { wired, failed } = wireEngines(targets, { cwd: base });
  if (wired.length) out("vf", c.green(`  ✔ wired: ${wired.join(", ")}`));
  for (const f of failed) {
    out("vf", c.yellow(`  ! ${f.engine} failed — continuing (${f.reason})`));
  }
  // The store + guide are shared, so append once any engine wired successfully.
  if (wired.length && appendGuide(base)) {
    out("vf", c.green("  + memory guide added to WORKFLOW_POLICY.md"));
  }
}
