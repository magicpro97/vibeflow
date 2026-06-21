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
export * from "../hooks/templates.js";
export * from "../init-hooks.js";
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

// === init Phase 1.5 (claude-mem) re-exported from init-memory.ts ===
// The `init` subcommand runs the memory opt-in between the deterministic
// baseline and AI enrichment. The cycle rule forbids init.ts from importing
// the sibling (./init-memory.js) directly, so it goes through this barrel.
export { runMemoryPhase } from "./init-memory.js";
export type { MemoryPhaseInject } from "./init-memory.js";

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

// === init subcommand helpers re-exported from init-apply.ts ===
// (issue #80, phase 6/14 + 9/14) The orchestrate subcommand uses
// DEFAULT_ENGINE (the canonical default for resolveEngine) and
// PreflightFn (the preflight probe type). Phase 9/14 split the intake/
// apply cluster out of init.ts into init-apply.ts, so these now come from
// that sibling. init.ts itself also pulls applyIntake + the intake types
// back through this barrel (cycle rule forbids the direct sibling import).
export { DEFAULT_ENGINE, applyIntake } from "./init-apply.js";
export type {
  ApplyIntakeOpts,
  ApplyIntakeResult,
  IntakeAnswers,
  PreflightFn,
} from "./init-apply.js";

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

// === tools subcommand helpers re-exported from tools.ts ===
// (issue #80, phase 9/14) The `init` subcommand (extracted to
// src/commands/init.ts in this phase) calls writeToolConfigs /
// provisionTool / ensureToolIndex in its Phase 1.6 tool-provisioning
// block, and types its sync spawner with StepSpawner. The cycle rule
// forbids init.ts from importing directly from ./tools.js, so we
// re-export the three values + the type through this barrel — the same
// sibling-to-sibling bridge as resolveRepo / normalizeUnit / the
// protection cluster above.
export { ensureToolIndex, provisionTool, writeToolConfigs } from "./tools.js";
export type { StepSpawner } from "./tools.js";

// === init ctx7/find-skills helpers re-exported from init-ctx7.ts ===
// (issue #80, phase 9/14) The `init` CLI entry point (in
// src/commands/init.ts) calls ensureCtx7Auth (Phase 1.7) and
// runFindSkillsFallback (Phase 1.8). Those helpers were split into the
// init-ctx7.ts sibling to keep init.ts under the 400-line cap. The cycle
// rule forbids init.ts from importing the sibling directly, so they come
// through this barrel (same bridge pattern as resolveRepo above).
export {
  ensureCtx7Auth,
  defaultAskConfirm,
  runFindSkillsFallback,
} from "./init-ctx7.js";
export type { Ctx7AuthResult } from "./init-ctx7.js";

// === init AI-enrichment step re-exported from init-ai.ts ===
// (issue #80, phase 9/14) The `init` CLI entry point (in
// src/commands/init.ts) runs the Phase 2 AI enrichment via
// runInitAiEnrichment, split into the init-ai.ts sibling to keep init.ts
// under the 400-line cap. The cycle rule routes it through this barrel.
export { runInitAiEnrichment } from "./init-ai.js";
export type { InitAiEnrichmentOpts } from "./init-ai.js";

// === Reusable hook-emit helper re-exported from hooks.ts ===
// `vf init`'s interactive hooks step arms the engine guardrail configs via the
// same writer `vf hooks emit --yes` uses. The cycle rule routes the cross-sibling
// import through this barrel.
export { armHooks, emitHookFiles } from "./hooks.js";

// === Re-export the state cluster (issue #184, A0 brief surface) ===
// `coord.ts` and `init.ts` use `isBriefFresh` to gate non-trivial
// actions on the brief's last-consult mtime. The cycle rule forbids
// sibling imports, so we re-export through this barrel.
export {
  BRIEF_FRESH_MS,
  BRIEF_PATH,
  BRIEF_SECTIONS,
  assertCoordBriefFresh,
  brief,
  formatBriefForHuman,
  isBriefFresh,
  printCoordGatePassed,
  readBrief,
  readBriefLastConsult,
  state,
  updateLastConsult,
  validateBriefShape,
} from "./state.js";
// F0/A1 #199: the shared gate (shape + freshness) lives in its own
// module to keep state.ts under the 400-line cap. Re-exported here
// so callers can `import { assertCoordBriefReady } from "commands"`.
export { assertCoordBriefReady } from "./state-gate.js";
// F0 review #3: atomic write is in its own module (atomic-write.ts).
// state.ts re-exports the frontmatter helpers; atomic write is a generic
// file-IO helper that doesn't belong to the state cluster.
export { atomicWriteFileSync } from "./atomic-write.js";
export type { Brief, BriefInject, OutFn } from "./state.js";
// === Re-export the coord shim (issue #184 A0 stub, A1 #167+#194 real) ===
// `coord.ts` is the A0 stub (brief freshness only) plus the A1 real
// shim (auto-coord + tool-deny-list). The A0↔A1 contract keeps the
// signature stable: the body grew but the surface did not. Re-exported
// here for the facade and tests; the helper `defaultToolDenier` +
// `DEFAULT_DENIED_TOOLS` are exposed too so callers can reuse the
// B5 audit-fixed policy outside the shim.
export {
  coord,
  defaultToolDenier,
  DEFAULT_DENIED_TOOLS,
} from "./coord.js";
export type { CoordInject, DeniedToolCall, Engine } from "./coord.js";

// A4 review surface (issue #170). Re-exported through the barrel
// so review-cross.ts (A5) and other A* commands can import via
// the no-cycle path.
export {
  review,
  parseReviewVerdict,
  readTargetContent,
  buildReviewPrompt,
  DEFAULT_REVIEW_ENGINE,
} from "./review.js";
export type { ReviewTarget, ReviewVerdict, ReviewResult } from "./review.js";

// A5 review-cross surface (issue #171). Same no-cycle rationale.
export {
  reviewCross,
  readPilotData,
  appendPilotData,
  computeDisagreementRate,
  DEFAULT_CROSS_ENGINES,
  PILOT_DATA_PATH,
} from "./review-cross.js";
export type { PilotEncounter } from "./review-cross.js";
