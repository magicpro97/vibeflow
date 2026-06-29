// === src/commands.ts — the command facade (issue #80 complete) ===

// This facade is now a PURE re-export surface (issue #80 complete): every
// public command + helper lives in src/commands/*.ts and is re-exported
// below. No value imports remain because no function bodies live here.

// === Re-export test seams + guardrail diagnostics (issue #80, phase 2/14) ===
// `tipState` + `resetTipStateForTests` + `liveGuardrailArmed` +
// `guardrailOffNote` live in src/commands/seams.ts. The facade re-exports
// them so existing callers keep working.
export {
  tipState,
  resetTipStateForTests,
  liveGuardrailArmed,
  guardrailOffNote,
} from "./commands/seams.js";

// === Re-export the doctor subcommand + repo detection helpers ===
// (issue #80, phase 3/14) `doctor`, `detectRepo`, `RepoDetection`,
// `resolveRepo` now live in src/commands/doctor.ts. The facade
// re-exports them so existing callers
// (`import { doctor, detectRepo, RepoDetection, resolveRepo } from
// "../commands.js"`) keep working. The body of src/commands.ts also
// imports `resolveRepo` directly because the `init`/`run`/etc
// functions (still in this file) call it.
export { doctor, detectRepo, resolveRepo } from "./commands/doctor.js";
export type { RepoDetection } from "./commands/doctor.js";
// === Re-export the init subcommand + intake types ===
// (issue #80, phase 4/14 + phase 9/14) The `vf init` cluster is split
// across four files (init.ts + three siblings), all re-exported here so
// callers keep using
// `import { init, applyIntake, ... } from "../commands.js"` unchanged:
//   - init.ts: `init` (CLI entry point) + `reportPreflightRefusal`
//   - init-apply.ts: `applyIntake` + `DEFAULT_ENGINE` + the IntakeAnswers /
//     ApplyIntakeOpts / ApplyIntakeResult / PreflightFn types
//   - init-ctx7.ts: `ensureCtx7Auth` / `defaultAskConfirm` /
//     `runFindSkillsFallback` + `Ctx7AuthResult`
//   - init-ai.ts: `runInitAiEnrichment` + `InitAiEnrichmentOpts` (Phase 2)
export { init, reportPreflightRefusal } from "./commands/init.js";
export { applyIntake, DEFAULT_ENGINE } from "./commands/init-apply.js";
export { demo } from "./commands/demo.js";
export type {
  ApplyIntakeOpts,
  ApplyIntakeResult,
  IntakeAnswers,
  PreflightFn,
} from "./commands/init-apply.js";
export {
  ensureCtx7Auth,
  defaultAskConfirm,
  runFindSkillsFallback,
} from "./commands/init-ctx7.js";
export type { Ctx7AuthResult } from "./commands/init-ctx7.js";
export { runInitAiEnrichment } from "./commands/init-ai.js";
export type { InitAiEnrichmentOpts } from "./commands/init-ai.js";
// === Re-export the dispatch helpers (issue #80, phase 5/14) ===
// `applyDispatch` + `mutateUnits` + `normalizeUnit` now live in
// src/commands/dispatch.ts. The facade re-exports them so existing
// callers (server, tests, ui shell) keep working. The body
// imports `normalizeUnit` directly because the `run` orchestrator
// (still in this file) calls it as a fallback when
// state.work_units is empty.
export { applyDispatch, mutateUnits, normalizeUnit } from "./commands/dispatch.js";
// === Re-export the units subcommand (issue #80, phase 6/14) ===
// `units` now lives in src/commands/units.ts. The facade re-exports
// it so the CLI dispatch (`import { units } from "../commands.js"`)
// keeps working. The body does not call `units` directly — it's a
// pure CLI entry point.
export { units } from "./commands/units.js";
export { config, decision } from "./commands/config-decision.js";
// === Re-export the orchestrate subcommand (issue #80, phase 6/14) ===
// `orchestrate` + `resolveMode` / `resolveEngine` / `announceLaunch`
// (test seams) now live in src/commands/orchestrate.ts. The facade
// re-exports them so the CLI dispatch keeps working. The body keeps
// using them through the facade's value imports (orchestrate.ts
// imports them back from the facade via the barrel's re-export —
// see _shared.ts for the cycle-tolerant wiring).
export {
  orchestrate,
  resolveMode,
  resolveEngine,
  announceLaunch,
  readyStub,
  engineReady,
} from "./commands/orchestrate.js";
// === Re-export the protection cluster (issue #80, phase 6/14) ===
// These symbols now live in src/commands/protection.ts. The facade
// re-exports the public ones for tests and the `run` body (now in
// src/commands/run.ts, issue #80 phase 6.5/14).
export {
  MS_PER_SECOND,
  planProtection,
  repoGit,
  resolveProtection,
} from "./commands/protection.js";
export type { ProtectionRuntime } from "./commands/protection.js";

export {
  computeKnowledgeHeavySource,
  analyzeDiff,
  defaultDiffReader,
  makeDispatcher,
  makeReviewer,
  makeWorktreeOps,
  defaultWorktreeOps,
  makeResearcher,
} from "./commands/dispatch-runtime.js";
export type { DiffReader, WorktreeOps } from "./commands/dispatch-runtime.js";
// `vf run` was extracted to src/commands/run.ts. The facade
// re-exports it so the CLI dispatch (cli.ts → main.ts) keeps
// working with the same import path.
export { run } from "./commands/run.js";

/** Global state: the "watch live" tip prints at most once per process. */
// `tipState` + `resolveMode` / `resolveEngine` / `resolveRisk` / `announceLaunch` / `readyStub` / `engineReady`
// now live in src/commands/orchestrate.ts (issue #80, phase 6/14). The body keeps using them
// through the facade's value imports (orchestrate.ts imports them back from the facade via the
// barrel's re-export — see _shared.ts for the cycle-tolerant wiring).

/** A read-only research step backed by the real dispatcher: each round dispatches a research
 * prompt (never writes) and reports the engine's self-assessed confidence. Used by
 * {@link investigateUnit} to raise confidence on a unit below the bar before we block it.
 */
// `makeResearcher` / `persistInvestigation` / the protection
// cluster (MS_PER_SECOND, ProtectionRuntime, repoGit,
// resolveProtection, planProtection, persistCheckpoint,
// persistQuota, recordQuota, rollbackCheckpoint,
// handleUnitFailure, skippedByQuota, computeKnowledgeHeavySource,
// makeDispatcher, makeReviewer) now live in
// src/commands/protection.ts (issue #80, phase 6/14, paired with
// orchestrate.ts). The facade re-exports the public seam
// (`makeResearcher`, `makeDispatcher`, `makeReviewer`,
// `planProtection`, `repoGit`, `resolveProtection`,
// `computeKnowledgeHeavySource`) for tests and the `run` body
// (extracted to src/commands/run.ts in issue #80 phase 6.5/14).

// `vf run` was extracted to src/commands/run.ts (issue #80, phase 6.5/14).
// Re-exported from this facade at `./commands/run.js` so the CLI
// dispatch (cli.ts → main.ts) keeps the same import path. The
// contract is preserved verbatim — see src/commands/run.ts:1-150
// for the inline rationale (logbus install, engine validation,
// state/goal check, dispatch-prompt write, engineCommand gate,
// planProtection gate, runDispatchAsync dispatch, handleUnitFailure
// recovery, --rollback-on-fail).

// `vf skills` was extracted to src/commands/skills.ts (issue #80, phase 7/14).
// Re-exported from this facade at `./commands/skills.js` so the CLI
// dispatch (cli.ts → main.ts) keeps the same import path. The body
// is preserved verbatim — see src/commands/skills.ts:1-250 for the
// full file (top-of-file rationale + imports + body). Subcommand
// dispatch on list/validate/search/resolve/sync/verify-sync/import/init;
// the `init` subcommand refuses to overwrite an existing SKILL.md.
export { skills } from "./commands/skills.js";
export { skillForFile } from "./skills/resolver.js";

// `vf discover` was extracted to src/commands/discover.ts (issue #80, phase 7/14).
// Re-exported from this facade at `./commands/discover.js`. Network only,
// fail-closed posture preserved (usage → 2; approval required → 0; failure → 1).
export { discover } from "./commands/discover.js";

// `vf hook` / `vf hook --selftest` / `vf hooks` were extracted to
// src/commands/hooks.ts (issue #80, phase 7/14). Re-exported from this
// facade at `./commands/hooks.js`. Fail-closed posture preserved
// (issue #79, PR #107): unrecognized stdin → BLOCK on live tool gate.
// `hookSelftest` writes .vibeflow/knowledge/hook-selfcheck.json. `hooks`
// is the small cluster CLI around `installHooks` (git config; surfaced
// stderr on failure per PR28 audit Task 7 M3).
export { armHooks, emitHookFiles, hook, hookSelftest, hooks } from "./commands/hooks.js";

// Split into three modules (issue #136): tools.ts (main CLI logic),
// tools-detect.ts (engine detection), tools-mcp-config.ts (MCP config I/O).
// The facade re-exports the public surface so existing callers
// (`import { tools, verify, ... } from "../commands.js"`) keep working.
export {
  tools,
  toolsSync,
  toolsStatus,
  probeIndexHealth,
  ensureToolIndex,
  provisionTool,
} from "./commands/tools.js";
export type { StepSpawner } from "./commands/tools.js";
export { verify, detectToolchain } from "./commands/tools-detect.js";
export type { ToolchainPlan } from "./commands/tools-detect.js";
export { repoLanguages, writeToolConfigs } from "./commands/tools-mcp-config.js";
// === Re-export the workflow cluster (issue #80, phase 8/14) ===
// `vf workflow` + `printVersion` now live in src/commands/workflow.ts.
// The facade re-exports them so the CLI dispatch keeps working.
export { workflow, printVersion } from "./commands/workflow.js";
// === Re-export the help cluster (issue #80, phase 8/14) ===
// `printHelp` + `hasCommandHelp` + `printCommandHelp` now live in
// src/commands/help.ts. The facade re-exports them so the CLI
// dispatch (`vf --help`, `vf <sub> --help`) keeps working.
export { printHelp, hasCommandHelp, printCommandHelp } from "./commands/help.js";
// === Re-export the state cluster (issue #184, A0 brief surface) ===
// `vf state brief` + the auto-coord gate + the staleness helpers live in
// src/commands/state.ts. The facade re-exports the public surface so
// the CLI dispatch keeps working and the contract test
// (test/commands-state.test.ts) can import the helpers.
export {
  assertCoordBriefFresh,
  brief,
  BRIEF_FRESH_MS,
  BRIEF_PATH,
  BRIEF_SECTIONS,
  formatBriefForHuman,
  isBriefFresh,
  readBrief,
  readBriefLastConsult,
  state,
  updateLastConsult,
  validateBriefShape,
  printCoordGatePassed,
} from "./commands/state.js";
// F0 review #3: atomic write extracted to its own module (state.ts
// was over the 400-line cap). The facade re-exports it from here
// so callers can `import { atomicWriteFileSync } from "commands"`.
export { atomicWriteFileSync } from "./commands/atomic-write.js";
export { assertCoordBriefReady } from "./commands/state.js";
export type { Brief, BriefInject, OutFn } from "./commands/state.js";
// === Re-export the coord shim (issue #184 A0 stub, A1 #167+#194 real) ===
// `vf coord` lives in src/commands/coord.ts. A0 shipped the brief-
// freshness stub; A1 replaced the body with the real shim (auto-coord +
// tool-deny-list) while keeping the A0 signature + exit-code contract.
export {
  coord,
  defaultEngineSpawner,
  defaultToolDenier,
  DEFAULT_DENIED_TOOLS,
} from "./commands/coord.js";
export type { CoordInject, DeniedToolCall, Engine } from "./commands/coord.js";

// === Re-export the plan cluster (issue #169, A3) ===
// `vf plan <artifact>` dispatches a planner engine, parses the 6
// canonical sections, writes the plan file. The dispatch is injected
// for testability (production wires the real engine dispatcher).
export {
  plan,
  PLAN_SECTIONS,
  PLANS_DIR,
  DEFAULT_PLAN_ENGINE,
  SLUG_MAX,
  slugify,
} from "./commands/plan.js";

// === Re-export the review cluster (issue #170, A4) ===
// `vf review <target>` dispatches a reviewer engine, parses the
// verdict (approve | revise | block), logs to the logbus. The
// dispatch is injected for testability. HUMAN-ONLY in v0.8.0;
// A5 (auto cross-debate) is a follow-up.
export {
  review,
  parseReviewVerdict,
  readTargetContent,
  buildReviewPrompt,
  DEFAULT_REVIEW_ENGINE,
} from "./commands/review.js";
export type { ReviewTarget, ReviewVerdict, ReviewResult } from "./commands/review.js";

// === Re-export the review-cross cluster (issue #171, A5) ===
// `vf review --cross <target>` dispatches TWO engines, extracts
// disagreements, surfaces them to the human, logs pilot data.
// The `--cross` flag is the EXPLICIT opt-in (A4's HUMAN-ONLY guard
// refuses `--auto` and `VF_REVIEW_AUTO=1`).
export {
  reviewCross,
  readPilotData,
  appendPilotData,
  computeDisagreementRate,
  DEFAULT_CROSS_ENGINES,
  PILOT_DATA_PATH,
} from "./commands/review-cross.js";
export type { PilotEncounter } from "./commands/review-cross.js";

// === Re-export the worktree cluster (issue #172, A6) ===
// `vf worktree create|remove|list` — symlink node_modules from
// the parent repo, skip `bun install`. The TS wrapper is a thin
// shell-out to git + `scripts/create-worktree.sh`. The
// `runCommandSync` inject is the test seam (same pattern as
// `vf review`'s dispatch inject).
export {
  worktree,
  worktreeCreate,
  worktreeRemove,
  worktreeList,
  buildCreateArgs,
  defaultWorktreePath,
} from "./commands/worktree.js";
export type { WorktreeAction, WorktreeInject, RunCommandResult } from "./commands/worktree.js";

// === Re-export the pr cluster (issue #173, A7) ===
// `vf pr create <issue>` — MagicPro97 PR convention (Confidence +
// Opus review evidence + DCO trailer + Fixes #N + magicpro97 account).
// The dispatch is injected for testability.
export {
  pr,
  verifyGhAccount,
  findCommitsLackingDco,
  pushBranch,
  createPr,
  addPrToProject,
  detectActiveBranch,
  readBodyFile,
  defaultPrBody,
  REQUIRED_GH_ACCOUNT,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_ACCOUNT,
  EXIT_DCO,
  EXIT_PUSH,
  EXIT_PR_CREATE,
} from "./commands/pr.js";

// === Re-export the pr-queue cluster (issue #174, A8) ===
// `vf pr queue <list|add|claim|release>` — single-writer JSONL queue +
// `mkdirSync`-style atomic file lock. Foundation for A9 (merge-when-green).
// Note: EXIT_OK and EXIT_USAGE are re-exported by the A7 pr cluster above,
// so we only export the A8-specific ones.
export {
  prQueue,
  addEntry,
  readQueue,
  listFree,
  acquireLock,
  releaseLock,
  claimEntry,
  releaseClaim,
  formatRow,
  QUEUE_PATH,
  LOCK_DIR,
  EXIT_NOT_FOUND,
  EXIT_LOCK_HELD,
  EXIT_IO,
} from "./commands/pr-queue.js";
export type { QueueEntry } from "./commands/pr-queue.js";
