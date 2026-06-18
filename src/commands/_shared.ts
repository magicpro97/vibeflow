// src/commands/_shared.ts
//
// Barrel of shared imports for the per-subcommand modules in src/commands/.
// Each subcommand file (`doctor.ts`, `init.ts`, `dispatch.ts`, etc.) imports
// from here instead of reaching back into the parent src/ tree. This keeps
// the per-subcommand files flat and makes the dependency graph inspectable.
//
// Per-subcommand files MUST NOT import anything from src/commands.ts
// (the facade) — that would create a cycle. They may import from this
// barrel, or from src/* directly for narrowly-scoped needs.
//
// Refs: issue #80 (split src/commands.ts).
//
// Implementation: each `export *` re-exports the values and types of one
// source module. We use `export *` per source rather than a single
// `export *` of everything because TS would otherwise be unable to
// re-export the same name from multiple sources (the first wins, silent
// overwrite of types).

// Re-export Node.js builtins we need, but be explicit to avoid
// `link`/`exists` collisions between node:fs and other modules.
export { spawnSync } from "node:child_process";
export { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
export { basename, isAbsolute, join, resolve } from "node:path";

export * from "../adapters.js";
export * from "../agents/detect-roles.js";
export * from "../agents/render.js";
export * from "../core.js";
export * from "../dispatch.js";
export * from "../gates.js";
export * from "../hooks/adapters.js";
export * from "../hooks/runner.js";
export * from "../hooks/selftest.js";
export * from "../init-intake.js";
export * from "../journal.js";
export * from "../orchestrator/investigate.js";
export * from "../orchestrator/run.js";
export * from "../preflight.js";
export * from "../safety/checkpoint.js";
export * from "../safety/quota.js";
export * from "../scanner.js";
export * from "../settings.js";
export * from "../skills/importer.js";
export * from "../skills/registry.js";
export * from "../skills/resolver.js";
export * from "../skills/sync.js";
export * from "../skills/validator.js";
export * from "../tools/index.js";
export * from "../ui.js";
export * from "../workflow-artifacts.js";
export * from "../workflow/lifecycle.js";
export * from "../workflow/merge.js";
export * from "../logbus.js";

// === Test seams + guardrail diagnostics re-exported from seams.ts ===
// (issue #80, phase 3/14) The doctor subcommand uses liveGuardrailArmed
// and guardrailOffNote. The cycle rule forbids doctor.ts from importing
// from a sibling (./seams.js), so we re-export the two names through
// this barrel. seam.ts is the only sibling allowed to be referenced
// from here because the facade pattern is the *only* legitimate way to
// expose a sibling to other subcommand files.
export { liveGuardrailArmed, guardrailOffNote } from "./seams.js";

// === doctor subcommand helpers re-exported from doctor.ts ===
// (issue #80, phase 4/14) The init subcommand uses resolveRepo to
// validate a user-supplied repo path. The cycle rule forbids
// init.ts from importing from a sibling (./doctor.js), so we
// re-export resolveRepo through this barrel.
export { resolveRepo } from "./doctor.js";

// === dispatch helpers re-exported from dispatch.ts ===
// (issue #80, phase 6/14) The units subcommand uses mutateUnits
// to round-trip the workflow ledger. The cycle rule forbids
// units.ts from importing from a sibling (./dispatch.js), so we
// re-export mutateUnits through this barrel. applyDispatch /
// normalizeUnit stay in the dispatch.ts sibling pair and are
// imported by the facade only.
export { mutateUnits } from "./dispatch.js";

// === Protection / rollout helpers re-exported from protection.ts ===
// (issue #80, phase 6.5/14) The `run` subcommand
// (src/commands/run.ts) and orchestrate (already in
// src/commands/orchestrate.ts) share the same protection
// cluster. Earlier we tried to re-export them through the
// facade (`../commands.js`) but verbatimModuleSyntax rejects
// that cycle (TS2449 / TS2724). Now that the protection
// cluster lives in its own file (./protection.ts), the
// re-export is sibling-to-sibling via this barrel — the
// same pattern as seams.ts / doctor.ts / dispatch.ts above.
// `run.ts` still imports the symbols from this barrel so its
// sibling-dependency footprint stays at zero (per the
// test/commands-no-cycle.test.ts guard).
export {
  MS_PER_SECOND,
  computeKnowledgeHeavySource,
  handleUnitFailure,
  makeDispatcher,
  makeResearcher,
  makeReviewer,
  planProtection,
  repoGit,
  resolveProtection,
} from "./protection.js";
export type { ProtectionRuntime } from "./protection.js";

// === init subcommand helpers re-exported from init.ts ===
// (issue #80, phase 6/14) The orchestrate subcommand uses
// DEFAULT_ENGINE (the canonical default for resolveEngine) and
// PreflightFn (the preflight probe type). They live in
// src/commands/init.ts; the cycle rule forbids orchestrate.ts
// from importing them directly, so we re-export through the
// barrel.
export { DEFAULT_ENGINE } from "./init.js";
export type { PreflightFn } from "./init.js";

// === dispatch helpers re-exported from dispatch.ts ===
// (issue #80, phase 6/14) The orchestrate subcommand uses
// normalizeUnit to shape the "one unit for the whole task"
// fallback when state.work_units is empty. mutateUnits
// (re-exported above from dispatch.ts) is the parent operation.
export { normalizeUnit } from "./dispatch.js";

// === test seams re-exported from seams.ts ===
// (issue #80, phase 6/14) The orchestrate subcommand uses
// tipState to gate the "watch live" tip so it prints at most
// once per process. The cycle rule forbids orchestrate.ts from
// importing tipState from seams.ts directly.
export { tipState } from "./seams.js";

// === orchestrate subcommand helpers re-exported from orchestrate.ts ===
// (issue #80, phase 6.5/14) The `run` subcommand (in
// src/commands/run.ts) shares the engine-readiness test
// seams with orchestrate (`readyStub` for the injected-spawner
// path, `engineReady` for the live preflight probe). The cycle
// rule forbids run.ts from importing directly from
// ./orchestrate.js, so we re-export through this barrel.
export { engineReady, readyStub } from "./orchestrate.js";
