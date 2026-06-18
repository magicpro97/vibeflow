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

// === Protection / rollout helpers ===
// (issue #80, phase 6/14) The protection cluster lives in
// src/commands/protection.ts. orchestrate.ts imports it through
// the facade (../commands.js) — but only for the public seam
// (`MS_PER_SECOND`, `planProtection`, `repoGit`,
// `resolveProtection`, `makeReviewer`, `makeDispatcher`,
// `ProtectionRuntime` type, `computeKnowledgeHeavySource`,
// `makeResearcher`, `handleUnitFailure`). The barrel
// intentionally does NOT re-export them: the cycle
// `commands.ts → _shared.ts → commands.ts` trips
// verbatimModuleSyntax (TS2303 "Circular definition of import
// alias"). The cycle is resolved by letting orchestrate.ts
// import directly from the facade — at call time, after the
// facade's module init has populated the bindings. This is
// the standard ESM cycle-tolerance pattern.
// Note for PR7: when the `run` subcommand moves to
// src/commands/run.ts, the run body will also need these
// symbols. Either re-export them through the barrel (after
// breaking the cycle via a wrapper) or add a sibling-only
// `import from "../commands/protection.js"`. The latter is
// the recommended approach for run.ts.

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
