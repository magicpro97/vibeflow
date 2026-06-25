// src/commands/init-apply.ts
//
// The deterministic intake → workflow-artifact generator for `vf init`
// (issue #80, phase 9/14). Extracted from src/commands/init.ts to keep
// init.ts under the 400-line cap.
//
// Contents:
// - IntakeAnswers: the structured shape of a `vf init` questionnaire
//   response. Used by the CLI, the web intake wizard, and the API.
// - PreflightFn / ApplyIntakeOpts / ApplyIntakeResult: types for
//   applyIntake and its options. The CLI (`init` in src/commands/init.ts)
//   passes options like `skipPreflight` to opt out of the hard gate.
// - chosenEngines / contextFrom: helpers that transform an IntakeAnswers
//   shape into an Engine[] and a ProjectContext.
// - gateEngines: the "hard creation gate" that runs a preflight and keeps
//   only ready engines, refusing entirely if none are ready.
// - applyIntake: the shared workflow generator. The MCP tool-config sync
//   (writeToolConfigs) is injected via ApplyIntakeOpts.syncToolConfigs so
//   this file stays free of any tool-machinery dependency. The CLI passes
//   the real function; tests skip it.
//
// All cross-module symbols come through the _shared barrel (cycle rule:
// test/commands-no-cycle.test.ts forbids sibling imports).

import {
  type AgentEngine,
  BACKUP_SUBDIR,
  CTX_DIR,
  ENGINES,
  ENGINE_INSTRUCTION_FILES,
  type Engine,
  type EngineReadiness,
  type ProjectContext,
  VERSION,
  type VibeSettings,
  type WorkflowPhase,
  type WorkflowState,
  agentFiles,
  anyReady,
  assertInsideBase,
  canonicalFiles,
  defaultContext,
  detectRolesForRepo,
  engineFiles,
  ensureIndex,
  existsSync,
  join,
  mergeManagedBlock,
  preflightAll,
  readFileSync,
  readSettings,
  readState,
  readyEngines,
  recomputeTotals,
  resolveRepo,
  scanRepo,
  settingsPath,
  summarizeProfile,
  writeFileSafe,
  writeSettings,
} from "./_shared.js";

import { ensureInitUpdated } from "../workflow/init-update.js";

export interface IntakeAnswers {
  goal?: string;
  engines?: string[];
  docSource?: string;
  taskSource?: string;
  fileTypes?: string[];
  expectedResult?: string;
  sample?: string;
  repoPath?: string;
  workflowPhases?: WorkflowPhase[];
}

function chosenEngines(engines?: string[]): Engine[] {
  const valid = (engines ?? []).filter((e): e is Engine => (ENGINES as string[]).includes(e));
  return valid.length ? valid : [...ENGINES];
}

// Exported for callers (the `init` CLI subcommand, run, orchestrate)
// that pass a single-engine `defaultEngine` to the readiness probe.
// Kept as `const` rather than `function` to preserve the original
// shape: callers compare `engine === DEFAULT_ENGINE` or fall through
// to it via `[...ENGINES]` when `engines` is empty.
export const DEFAULT_ENGINE: Engine = "copilot";

function contextFrom(answers: IntakeAnswers): ProjectContext {
  const base = defaultContext();
  const clean = (s?: string) => (s?.trim() ? s.trim() : undefined);
  return {
    ...base,
    goal: clean(answers.goal) ?? base.goal,
    docSource: clean(answers.docSource),
    taskSource: clean(answers.taskSource),
    fileTypes: answers.fileTypes?.map((s) => s.trim()).filter(Boolean),
    expectedResult: clean(answers.expectedResult),
    sample: clean(answers.sample),
  };
}

/** Injectable readiness check so the creation gate is testable without spawning engines. */
export type PreflightFn = (engines: Engine[]) => EngineReadiness[];

export interface ApplyIntakeOpts {
  dry?: boolean;
  useAi?: boolean;
  base?: string;
  /** Opt out of the hard creation gate (web `/api/init` and dry/offline paths). */
  skipPreflight?: boolean;
  /** Override the readiness check (tests inject a fake; default is a live probe). */
  preflight?: PreflightFn;
  /**
   * After writing the engine files, sync the per-engine MCP config
   * (Claude `.mcp.json`, Codex `config.toml`, Copilot add commands)
   * to mirror the current SETTINGS. Injected so init.ts stays
   * independent of the tools module. CLI defaults to
   * `writeToolConfigs`; tests may pass `undefined` to skip.
   */
  syncToolConfigs?: (base: string, settings: VibeSettings | undefined) => void;
}

export interface ApplyIntakeResult {
  files: string[];
  state: WorkflowState;
  /** Per-engine readiness from the gate (present whenever the gate ran). */
  readiness?: EngineReadiness[];
  /** True when the gate refused creation because no engine was ready. */
  refused?: boolean;
  /** Relative paths of hand-edited engine files archived under .vibeflow/backup before merge. */
  backedUp?: string[];
}

/**
 * Resolve which engines to generate for. When the gate is active (not dry, not skipped) it
 * runs a live preflight and keeps only ready engines; refusing entirely if none are ready.
 * The default skip ties the offline/browser path (useAi:false) to "no gate" so a browser
 * request never blocks on a live probe — Wave C may also pass skipPreflight explicitly.
 */
function gateEngines(
  answers: IntakeAnswers,
  opts: ApplyIntakeOpts,
): { engines: Engine[]; readiness?: EngineReadiness[]; refused: boolean } {
  const chosen = chosenEngines(answers.engines);
  const skip = opts.skipPreflight ?? opts.useAi === false;
  // Bridge mode (VIBEFLOW_AI set) never spawns the named engine CLI — dispatch goes through
  // the bridge command — so a missing/unauthed named-engine binary must not block init.
  if (skip || opts.dry || process.env.VIBEFLOW_AI) return { engines: chosen, refused: false };
  const probe = opts.preflight ?? ((e: Engine[]) => preflightAll(e, { probe: false }));
  const readiness = probe(chosen);
  if (!anyReady(readiness)) return { engines: [], readiness, refused: true };
  return { engines: readyEngines(readiness), readiness, refused: false };
}

/**
 * Shared workflow generator used by both `vf init` (CLI) and the web intake wizard.
 * `useAi` is false for web-initiated init so a browser request never shells out to
 * $VIBEFLOW_AI; the CLI keeps the AI bridge enabled. When a workflow already exists in
 * `base`, its work units and attachments are preserved so re-submitting acts as an edit.
 *
 * Hard creation gate: for a real CLI init (not dry, not skipped) we preflight the chosen
 * engines and refuse creation when none is ready, generating only for ready engines
 * otherwise. The gate is parameterized via {@link ApplyIntakeOpts} so callers opt out.
 */
export function applyIntake(answers: IntakeAnswers, opts: ApplyIntakeOpts = {}): ApplyIntakeResult {
  const base = opts.base ?? resolveRepo(answers.repoPath);
  const ctx = contextFrom(answers);
  ctx.settings = readSettings(base);
  // Enrich context with an evidence-based scan of the target repo (PROJECT_CONTEXT.md).
  try {
    const profile = scanRepo(base);
    ctx.stack = summarizeProfile(profile);
    if (profile.summary && ctx.summary === defaultContext().summary) ctx.summary = profile.summary;
  } catch {
    /* scanning is best-effort; never block init */
  }
  const gate = gateEngines(answers, opts);
  const prev = readState(base);
  const state = recomputeTotals({
    task_id: prev?.task_id ?? "TASK-1",
    goal: ctx.goal,
    success_criteria: ctx.expectedResult ? [ctx.expectedResult] : (prev?.success_criteria ?? []),
    work_units: prev?.work_units ?? [],
    totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    attachments: prev?.attachments ?? [],
    // Stamp the current version so subsequent `vf init` calls can detect
    // whether a prior init has already run (issue #323, init-update).
    vibeflow_version: VERSION,
  });
  if (gate.refused) return { files: [], state, readiness: gate.readiness, refused: true };

  const useAi = opts.useAi !== false;
  const files: Record<string, string> = { ...canonicalFiles(ctx) };
  for (const engine of gate.engines) {
    Object.assign(files, engineFiles(engine, ctx, useAi));
  }
  // Per-role agent files: same body, engine-specific wrappers.
  // Honour `gate.engines` so `vf init --engine codex` writes only codex
  // files (not all 3). Default is all engines.
  const profile = scanRepo(base);
  const roles = detectRolesForRepo(base, profile);
  const targetEngines: readonly AgentEngine[] =
    gate.engines.length > 0 ? (gate.engines as readonly AgentEngine[]) : [DEFAULT_ENGINE];
  Object.assign(files, agentFiles(profile, roles, useAi, targetEngines));
  files[`${CTX_DIR}/WORKFLOW_STATE.json`] = JSON.stringify(state, null, 2);
  // Context files that hold human-curated content MUST survive re-init: a no-args `vf init`
  // must NOT clobber hand-edited specs. Preserve existing copies like SETTINGS.json and
  // TASK_CONTEXT.md already do. These files CAN be (re)generated — the write-loop below
  // checks via `PRESERVED_CONTEXT_FILES`. Only re-write when the file does not exist (first
  // init) OR the caller supplied an explicit goal (interactive init / `--goal`).
  const explicitGoal = Boolean(answers.goal?.trim());
  const PRESERVED_CONTEXT_FILES = new Set([
    "REQUIREMENTS.md",
    "PROJECT_CONTEXT.md",
    "WORKFLOW_POLICY.md",
    "SKILL_INDEX.md",
  ]);
  const written: string[] = [];
  const backedUp: string[] = [];
  // One backup run-dir per init so a re-init that rescues several hand-edited files groups them.
  const backupRun = join(base, BACKUP_SUBDIR, `init-${Date.now()}`);
  const engineFileSet = new Set(ENGINE_INSTRUCTION_FILES);
  for (const [rel, content] of Object.entries(files)) {
    const filename = rel.split("/").pop() ?? "";
    const isPreserved = rel.endsWith("TASK_CONTEXT.md") || PRESERVED_CONTEXT_FILES.has(filename);
    if (isPreserved && !explicitGoal && existsSync(join(base, rel))) {
      // Preserve the user's hand-curated context file; don't claim to write what we skipped.
      continue;
    }
    const abs = join(base, rel);
    // Root engine instruction files (CLAUDE.md/AGENTS.md/copilot-instructions.md) can collide
    // with files a human wrote. Merge into the marked region instead of truncating, and archive
    // any hand-edited original before we touch it (the data-loss P1 fix). Everything else lives
    // under .vibeflow/ — VibeFlow's own namespace — and keeps the simple write.
    if (engineFileSet.has(rel)) {
      const existing = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      if (existing != null) assertInsideBase(abs, base);
      const merged = mergeManagedBlock(existing, content);
      if (!opts.dry) {
        if (merged.backup && existing != null) {
          writeFileSafe(join(backupRun, rel), existing);
          backedUp.push(rel);
        }
        writeFileSafe(abs, merged.content);
      }
      written.push(rel);
      continue;
    }
    if (!opts.dry) writeFileSafe(abs, content);
    written.push(rel);
  }
  // SETTINGS.json is owned by the settings layer, not the canonical templates: seed it with
  // the off-by-default baseline ONLY on first init. On every subsequent init the user's file
  // is left untouched so enabling codegraph/lsp (or tuning failureProtection) survives re-init.
  if (!opts.dry && !existsSync(settingsPath(base))) {
    writeSettings(base, {});
    written.push(`${CTX_DIR}/SETTINGS.json`);
  }
  // Keep MCP config in lockstep with the instructions: if any optional tool is enabled,
  // (re)write the engine MCP registrations so the injected "prefer codegraph > LSP" block
  // references servers that are actually registered. Skipped on dry runs.
  // Always write MCP config to strip managed servers when tools are disabled.
  // If we skip this, stale .mcp.json entries for absent binaries break engine startup
  // (Claude Code reads .mcp.json and tries to launch every registered MCP server).
  if (!opts.dry && opts.syncToolConfigs) {
    opts.syncToolConfigs(base, ctx.settings);
  }
  // Seed the work-journal catalog (knowledge/index.md) so the engine has a file to maintain.
  // Create-if-absent only — never clobbers a human-curated index. Skipped on dry runs.
  if (!opts.dry) ensureIndex(base);
  // Issue #323: seed bundled vf skill + sync skills + stamp version on re-init.
  // Runs on every init (first or re-init) to catch upgrades and restore a
  // deleted vf skill. Short-circuits internally when already current.
  if (!opts.dry) ensureInitUpdated(base);
  return {
    files: written,
    state,
    readiness: gate.readiness,
    refused: false,
    backedUp,
  };
}
