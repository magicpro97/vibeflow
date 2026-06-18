// === Subcommand refactor (issue #80, phase 1/14) ===
// All imports + re-exports now live in src/commands/_shared.ts (the barrel).
// Function bodies stay in this file until each is extracted to its own
// per-subcommand module. PR1 only sets up the barrel.
import {
  BACKUP_SUBDIR,
  CTX_DIR,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_ROUNDS,
  ENGINES,
  ENGINE_INSTRUCTION_FILES,
  Spinner,
  TOOLS,
  VERSION,
  agentFiles,
  anyReady,
  appendFileSafe,
  appendJournal,
  applyDelete,
  assertInsideBase,
  basename,
  buildEnginePrompt,
  buildEnrichmentPrompt,
  c,
  canonicalFiles,
  chmodSync,
  collectInitAskQuestionnaireData,
  copySkillCreator,
  createCheckpoint,
  ctxPathIn,
  cwd,
  defaultContext,
  deleteUnit,
  detectQuota,
  detectRolesForRepo,
  discoverSkills,
  dispatchPrompt,
  downgradeBannerText,
  e2eEvaluateDynamicImportWarning,
  e2eUnicodeSelectorWarning,
  engineCommand,
  engineFiles,
  engineHookFiles,
  ensureIndex,
  evaluateHook,
  existsSync,
  findScopeConflicts,
  generateWorkflowArtifacts,
  gitState,
  goalEval,
  hasCommand,
  importSkillFromDir,
  importSkillsFromParent,
  importWorkflow,
  initAskQuestionnaireToIntakeAnswers,
  installLogbus,
  investigateUnit,
  isAbsolute,
  isGitRepo,
  isUnavailable,
  join,
  makeAsyncSpawner,
  matchSkillsForTask,
  mergeManagedBlock,
  orchestrateUnits,
  out,
  panel,
  parseHookInput,
  persistDispatch,
  planDelete,
  policyGates,
  preflightAll,
  preflightAllAsync,
  presentDecision,
  priorityRank,
  readFileSync,
  readSettings,
  readState,
  readyEngines,
  recomputeTotals,
  recoveryHint,
  renderSkillIndex,
  renderSkillNeeds,
  resolve,
  resolveSkillNeeds,
  resolveTools,
  restoreIgnored,
  rmSync,
  runDispatchAsync,
  runSelftest,
  scanRepo,
  settingsPath,
  skillForFile,
  spawnSync,
  statSync,
  summarizeProfile,
  syncSkillMirrors,
  table,
  thresholdFor,
  validateSkillRoots,
  verifySkillSync,
  writeFileSafe,
  writeSettings,
  writeState,
} from "./commands/_shared.js";
import type {
  AgentEngine,
  AsyncResearcher,
  AsyncSpawner,
  Checkpoint,
  CollisionPolicy,
  DeletePlan,
  DispatchResult,
  Engine,
  EngineProbe,
  EngineReadiness,
  FailureProtection,
  GitRunner,
  JsonMcpEntry,
  MergeResult,
  ProjectContext,
  QuotaSignal,
  Reviewer,
  RiskClass,
  SelftestReport,
  StdioServer,
  TomlMcpEntry,
  ToolName,
  ToolTier,
  UnitDispatcher,
  UnitInvestigationOutcome,
  UnitOutcome,
  VibeSettings,
  WorkUnit,
  WorkflowPhase,
  WorkflowState,
} from "./commands/_shared.js";
// === Re-export test seams + guardrail diagnostics (issue #80, phase 2/14) ===
// `tipState` + `resetTipStateForTests` + `liveGuardrailArmed` +
// `guardrailOffNote` live in src/commands/seams.ts. The facade re-exports
// them so existing callers
// (`import { tipState, resetTipStateForTests, liveGuardrailArmed,
// guardrailOffNote } from "../commands.js"`) keep working. The body also
// imports `tipState` directly because the `orchestrate` function (still
// in this file) uses it.
export {
  tipState,
  resetTipStateForTests,
  liveGuardrailArmed,
  guardrailOffNote,
} from "./commands/seams.js";
import { resolveRepo } from "./commands/_shared.js";
import { applyDispatch, mutateUnits, normalizeUnit } from "./commands/dispatch.js";
import { DEFAULT_ENGINE, applyIntake } from "./commands/init.js";
import type {
  ApplyIntakeOpts,
  ApplyIntakeResult,
  IntakeAnswers,
  PreflightFn,
} from "./commands/init.js";
import {
  announceLaunch,
  engineReady,
  orchestrate,
  readyStub,
  resolveEngine,
  resolveMode,
} from "./commands/orchestrate.js";
import {
  MS_PER_SECOND,
  computeKnowledgeHeavySource,
  handleUnitFailure,
  makeDispatcher,
  makeResearcher,
  makeReviewer,
  planProtection,
  repoGit,
  resolveProtection,
} from "./commands/protection.js";
import type { ProtectionRuntime } from "./commands/protection.js";
import { guardrailOffNote, liveGuardrailArmed, tipState } from "./commands/seams.js";
import { units } from "./commands/units.js";
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
// (issue #80, phase 4/14) `applyIntake` + the IntakeAnswers /
// ApplyIntakeOpts / ApplyIntakeResult / PreflightFn types now live
// in src/commands/init.ts. The facade re-exports them so existing
// callers (`import { applyIntake, IntakeAnswers, ... } from
// "../commands.js"`) keep working. The body imports applyIntake + the
// types directly because the `init` / `run` / `orchestrate` / etc
// functions (still in this file) reference them.
export { applyIntake, DEFAULT_ENGINE } from "./commands/init.js";
export type {
  ApplyIntakeOpts,
  ApplyIntakeResult,
  IntakeAnswers,
  PreflightFn,
} from "./commands/init.js";
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
  makeReviewer,
  makeDispatcher,
  computeKnowledgeHeavySource,
  makeResearcher,
} from "./commands/protection.js";
export type { ProtectionRuntime } from "./commands/protection.js";
// === Re-export the `run` subcommand (issue #80, phase 6.5/14) ===
// `vf run` was extracted to src/commands/run.ts. The facade
// re-exports it so the CLI dispatch (cli.ts → main.ts) keeps
// working with the same import path.
export { run } from "./commands/run.js";
export * from "./commands/_shared.js";

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

/** Print per-engine readiness hints, then a clear refusal line. Returns the nonzero exit code. */
// Test seam: exported so unit tests can verify the readiness listing
// format and the "no engine ready" exit code contract.
export function reportPreflightRefusal(readiness: EngineReadiness[] | undefined): number {
  out("vf", c.red("\nNo engine is ready — refusing to generate engine files."), {
    level: "error",
  });
  for (const r of readiness ?? []) {
    out("vf", `  ${c.yellow("!")} ${r.engine}: ${c.dim(r.detail)}`, {
      level: "error",
    });
  }
  out("vf", c.dim("Fix an engine above (or use `--dry-run` for an offline preview)."), {
    level: "error",
  });
  return 1;
}

export async function init(
  flags: Record<string, string | boolean>,
  inject: {
    preflight?: PreflightFn;
    spawner?: AsyncSpawner;
    // Test seam: when provided, the AI enrichment phase uses this
    // spawner instead of building its own (which would invoke the
    // real engine). Production callers leave this undefined.
    aiSpawner?: AsyncSpawner;
    // Test seam: when provided, the AI enrichment phase uses this
    // preflight (overriding its default real-probe). Production
    // callers leave this undefined.
    aiPreflight?: (engines: Engine[], opts: { probe: boolean }) => EngineReadiness[];
    // Test seam: forwarded to `runAiInitWorkflow` (B1/T5) when the
    // --ai path uses the agent-team shape. Ignored on the legacy
    // `runAiInit` path. Production callers leave this undefined.
    dispatcher?: UnitDispatcher;
    // Test seam: when provided, bypass the interactive `init-ask`
    // questionnaire and use this object as the intake answers.
    // Lets unit tests drive the workflow-artifacts block
    // (commands.ts L1341-1371) without depending on TTY + stdin.
    // Production callers leave this undefined.
    answers?: IntakeAnswers;
  } = {},
): Promise<number> {
  const initEngine: Engine =
    typeof flags.engine === "string" && (ENGINES as string[]).includes(flags.engine)
      ? (flags.engine as Engine)
      : DEFAULT_ENGINE;
  const engines = [initEngine];
  const dry = Boolean(flags["dry-run"]);
  const ai = !flags["no-ai"];
  // B1/T5 + Task 5b: AI enrichment is on by default; --no-ai opts out.
  // Without --no-ai, the agent-team workflow shape is used.
  // (runAiInitWorkflow). The --no-agent-team opt-out restores the
  // legacy runAiInit path. The default is the workflow because the
  // agent-team is the forward-looking surface; users on tight CI
  // budgets can opt out per-run.
  const useAgentTeam = ai && !flags["no-agent-team"];
  const ask = ai && !dry && !flags["no-ask"] && process.stdin.isTTY;
  // Test seam: when `inject.answers` is provided, use it directly and
  // skip the interactive questionnaire. Lets unit tests drive the
  // workflow-artifacts block (L1341-1371) without a TTY. Production
  // callers leave `inject.answers` undefined; the `ask` gate remains
  // the only path for end users.
  const injectedAnswers: IntakeAnswers | undefined = inject.answers;
  const questionnaire = ask && !injectedAnswers ? await collectInitAskQuestionnaireData() : null;
  const answers = injectedAnswers
    ? injectedAnswers
    : ask
      ? questionnaire && initAskQuestionnaireToIntakeAnswers(questionnaire, engines)
      : { engines };
  if (!answers) return process.stdin.isTTY ? 130 : 2;
  // Phase 1: deterministic baseline — always skip the VIBEFLOW_AI bridge so
  // the AI enrichment phase (Phase 2) is the only AI path.
  const initSpinner = new Spinner();
  initSpinner.start(dry ? "➥ Preparing init dry run" : "➥ Generating VibeFlow context");
  let result: ReturnType<typeof applyIntake>;
  try {
    result = applyIntake(answers, {
      dry,
      skipPreflight: dry,
      preflight: inject.preflight,
      useAi: false,
      // Keep MCP config in lockstep with SETTINGS. writeToolConfigs
      // is defined later in this file (PR8 will move it to
      // src/commands/tools.ts).
      syncToolConfigs: (base, settings) => {
        if (settings) writeToolConfigs(base, settings);
      },
    });
  } catch (err) {
    initSpinner.fail("VibeFlow context generation failed");
    throw err;
  }
  if (result.refused) initSpinner.fail("Engine preflight refused init");
  else initSpinner.succeed(dry ? "Init dry run prepared" : "VibeFlow context generated");

  if (result.refused) return reportPreflightRefusal(result.readiness);
  const label = dry ? "dry run" : "init";
  out("vf", panel("VibeFlow", c.bold(label)));
  const dropped = (result.readiness ?? []).filter((r) => r.level !== "ready");
  for (const r of dropped) {
    out("vf", c.yellow(`• skipped ${r.engine}: ${c.dim(r.detail)}`));
  }
  for (const rel of result.files) {
    out("vf", dry ? c.dim(`would write ${rel}`) : `${c.green("+")} ${rel}`);
  }
  if (!dry) {
    out("vf", c.bold(`\nGenerated ${result.files.length} files from canonical context.`));
    for (const rel of result.backedUp ?? []) {
      out("vf", c.dim(`  archived previous ${rel} under ${CTX_DIR}/backup/init-*`));
    }
  }

  // Phase 1.5: Deterministic workflow artifacts (from questionnaire phases)
  const hasPhases = Boolean(answers.workflowPhases?.length);
  if (!dry && hasPhases) {
    const targetEngines = (answers.engines ?? ["copilot"]) as AgentEngine[];
    const projectName = basename(cwd());
    const phases = answers.workflowPhases as WorkflowPhase[];
    const artifactFiles = generateWorkflowArtifacts({
      phases,
      engines: targetEngines,
      projectName,
      base: cwd(),
    });
    if (artifactFiles.length) {
      out("vf");
      out("vf", panel("Workflow", c.bold("artifacts")));
      for (const rel of artifactFiles) {
        out("vf", c.green(`+ ${rel}`));
      }
      out("vf", c.bold(`\nGenerated ${artifactFiles.length} workflow artifact(s).`));
    }
    // Only copy the skill-creator into engine folders when at
    // least one engine is ready. If preflight refused (no engines
    // ready), the skill files would sit unused; better to skip
    // the I/O and let the user re-run init when an engine is
    // installed.
    if (!result.refused) {
      for (const rel of copySkillCreator(cwd(), targetEngines)) {
        out("vf", c.green(`+ ${rel}/SKILL.md`));
      }
    }
  }

  // Phase 2: AI enrichment (only when --ai, not dry, and Phase 1 succeeded)
  if (ai && !dry && !result.refused) {
    out("vf");
    const aiEngine = initEngine;
    const prefix = aiEngine ? `[${aiEngine}]` : "[ai]";
    if (useAgentTeam) {
      let lineBuf = "";
      let errLineBuf = "";
      const aiSpinner = new Spinner();
      aiSpinner.start(" ");
      // B1/T5: --ai defaults to the agent-team workflow shape. The workflow
      // runs 7 adapter units in parallel (analyzer, instruction-writer,
      // skill-curator, tool-configurator, workflow-policy-writer,
      // workflow-state-writer, context-updater) and a reviewer per unit.
      // When the user supplied workflow phases, they are passed so the
      // planner generates Tier 2 units alongside the Tier 1 baseline.
      const { runAiInitWorkflow } = await import("./ai-init.js");
      const workflowResult = await runAiInitWorkflow({
        base: cwd(),
        intake: {
          goal: "init",
          engines: aiEngine ? [aiEngine] : [],
          ...(hasPhases ? { workflowPhases: answers.workflowPhases as WorkflowPhase[] } : {}),
        },
        forceEngine: aiEngine,
        preflight: inject.aiPreflight,
        dispatcher: inject.dispatcher,
        spawner:
          inject.aiSpawner ??
          makeAsyncSpawner({
            timeoutMs: 30_000_000,
            idleTimeoutMs: 300_000,
            onChunk(text) {
              lineBuf += text;
              const lines = lineBuf.split("\n");
              lineBuf = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) out("engine-stdout", `${prefix} ${trimmed}`);
              }
            },
            onStderrChunk(text) {
              errLineBuf += text;
              const lines = errLineBuf.split("\n");
              errLineBuf = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) out("engine-stderr", `${prefix} ${trimmed}`);
              }
            },
          }),
      });
      if (workflowResult.ok) {
        aiSpinner.succeed(`agent-team workflow complete (${workflowResult.engine ?? "?"})`);
        out(
          "vf",
          c.green(
            `✔ agent-team workflow complete (${workflowResult.units.length} units via ${workflowResult.reviews[0]?.reason ?? "reviewer"})`,
          ),
        );
      } else {
        aiSpinner.fail("agent-team workflow skipped");
        out("vf", c.yellow(`! agent-team workflow skipped: ${workflowResult.reason}`));
        out(
          "vf",
          c.dim(
            "  Deterministic context files are in place. Install an engine or fix PATH and re-run.",
          ),
        );
      }
    } else {
      let lineBuf = "";
      let errLineBuf = "";
      const aiSpinner = new Spinner();
      aiSpinner.start(`➥ Running AI enrichment ${prefix}`);
      // Legacy --no-agent-team path: original runAiInit shape.
      // When workflow phases exist, use the enrichment prompt instead.
      const { runAiInit } = await import("./ai-init.js");
      const phases = answers.workflowPhases as WorkflowPhase[];
      const aiResult = await runAiInit({
        base: cwd(),
        buildPrompt: hasPhases
          ? (profile, _base) => {
              const targetEngines = (answers.engines ?? ["copilot"]) as AgentEngine[];
              return buildEnrichmentPrompt(phases, targetEngines, profile, _base);
            }
          : undefined,
        dryRun: dry,
        spawner:
          inject.aiSpawner ??
          makeAsyncSpawner({
            timeoutMs: 30_000_000,
            idleTimeoutMs: 300_000,
            onChunk(text) {
              lineBuf += text;
              const lines = lineBuf.split("\n");
              lineBuf = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) out("engine-stdout", `${prefix} ${trimmed}`);
              }
            },
            onStderrChunk(text) {
              errLineBuf += text;
              const lines = errLineBuf.split("\n");
              errLineBuf = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) out("engine-stderr", `${prefix} ${trimmed}`);
              }
            },
          }),
        forceEngine: aiEngine,
        // --autopilot: opt-in auto-fallback when the chosen engine is
        // unavailable or returns a permission error. Default false to
        // preserve single-shot behavior (any failure is the user's
        // problem to debug). With --autopilot, runAiInit transparently
        // retries with the next-best ready engine.
        autopilot: Boolean(flags.autopilot),
        // Test seam: forward inject.aiPreflight so unit tests can stub
        // engine readiness checks in the AI enrichment phase. The
        // applyIntake call above uses inject.preflight (a different
        // PreflightFn signature) for the Phase 1 deterministic step.
        preflight: inject.aiPreflight,
      });
      if (aiResult.ok) {
        const used = aiResult.engine ?? "?";
        aiSpinner.succeed(`AI enrichment complete (${used})`);
        if (aiResult.fallback) {
          out(
            "vf",
            c.green(
              `✔ AI analysis complete (${used}; fell back from ${aiResult.fallback.original} via --autopilot)`,
            ),
          );
        } else {
          out("vf", c.green(`✔ AI analysis complete (${used})`));
        }
      } else {
        out("vf", c.yellow(`! AI analysis skipped: ${aiResult.reason ?? "unknown"}`));
        out(
          "vf",
          c.dim(
            "  Deterministic context files are in place. Install an engine or fix PATH and re-run.",
          ),
        );
      }
    }
  } else if (ai && dry && hasPhases) {
    // Dry-run --ai with phases: show the enrichment prompt
    out(
      "vf",
      c.dim("\ndry-run: workflow enrichment prompt would be sent to the best available engine"),
    );
    const { scanRepo } = await import("./scanner.js");
    const base = cwd();
    const profile = scanRepo(base);
    const phases = answers.workflowPhases as WorkflowPhase[];
    const targetEngines = (answers.engines ?? ["copilot"]) as AgentEngine[];
    const prompt = buildEnrichmentPrompt(
      phases,
      targetEngines,
      { name: profile.name, summary: profile.summary, languages: profile.languages },
      base,
    );
    out("vf", c.dim(`\n${prompt.slice(0, 1500)}…`));
  } else if (ai && dry) {
    // Dry-run --ai without phases: show the original AI init prompt
    out("vf", c.dim("\ndry-run: prompt would be sent to the best available engine"));
    const { buildAiInitPrompt } = await import("./ai-init.js");
    const { scanRepo } = await import("./scanner.js");
    const base = cwd();
    const profile = scanRepo(base);
    const prompt = buildAiInitPrompt(profile, base);
    out("vf", c.dim(`\n${prompt.slice(0, 1500)}…`));
  }

  return 0;
}

// `vf run` was extracted to src/commands/run.ts (issue #80, phase 6.5/14).
// Re-exported from this facade at `./commands/run.js` so the CLI
// dispatch (cli.ts → main.ts) keeps the same import path. The
// contract is preserved verbatim — see src/commands/run.ts:1-150
// for the inline rationale (logbus install, engine validation,
// state/goal check, dispatch-prompt write, engineCommand gate,
// planProtection gate, runDispatchAsync dispatch, handleUnitFailure
// recovery, --rollback-on-fail).

export function skills(sub: string | undefined, rest: string[] = []): number {
  const repo = cwd();
  const found = discoverSkills(repo);
  if (sub === undefined || sub === "list") {
    if (!found.length) {
      out(
        "vf",
        c.dim(`No skills discovered under ${CTX_DIR}/skills, .kiro/skills, or .claude/skills.`),
      );
      return 0;
    }
    process.stdout.write(renderSkillIndex(found));
    return 0;
  }
  if (sub === "validate") {
    const result = validateSkillRoots(repo);
    for (const w of result.warnings) out("vf", c.yellow(`! ${w}`));
    for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
    if (result.ok) {
      out("vf", c.green(`✔ ${result.skills.length} skill(s) valid`));
      return 0;
    }
    out("vf", c.red(`✗ ${result.errors.length} validation error(s)`), { level: "error" });
    return 1;
  }
  if (sub === "search") {
    const term = rest.join(" ").trim();
    if (!term) {
      out("vf", c.red("Usage: vf skills search <term>"), {
        level: "error",
      });
      return 2;
    }
    const matches = matchSkillsForTask(found, term);
    if (!matches.length) {
      out("vf", c.dim(`No skill matched "${term}".`));
      return 0;
    }
    for (const m of matches) {
      out("vf", `${c.bold(m.skill.name)} ${c.dim(`(${m.score.toFixed(2)})`)} — ${m.reason}`);
    }
    return 0;
  }
  if (sub === "resolve") {
    // Demand-driven: derive skill NEEDS from the repo scan + saved intake, then report
    // which are satisfied locally and which must be acquired on demand (never pre-installed).
    const state = readState(repo);
    const profile = scanRepo(repo);
    const attachments = (state?.attachments ?? []).map((a) => a.name);
    const needs = resolveSkillNeeds({
      repo,
      attachments,
      task: state?.goal,
      profile,
    });
    process.stdout.write(renderSkillNeeds(needs));
    return 0;
  }
  if (sub === "sync") {
    // Parse `--mode pointer|full` (or `--mode=pointer|full`) from `rest`.
    // Default is "pointer"; explicit non-"full" value (e.g. "pointer") is
    // preserved instead of being silently dropped to default.
    // Unknown values produce a clear error.
    let mode: "pointer" | "full" = "pointer";
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok === "--mode") {
        const v = rest[i + 1];
        if (v !== "full" && v !== "pointer") {
          out("vf", c.red(`✗ --mode must be 'pointer' or 'full', got '${v ?? "(missing)"}'`), {
            level: "error",
          });
          return 2;
        }
        mode = v;
      }
      if (typeof tok === "string" && tok.startsWith("--mode=")) {
        const v = tok.slice("--mode=".length);
        if (v !== "full" && v !== "pointer") {
          out("vf", c.red(`✗ --mode must be 'pointer' or 'full', got '${v}'`), {
            level: "error",
          });
          return 2;
        }
        mode = v;
      }
    }
    const result = syncSkillMirrors(repo, { mode });
    for (const w of result.warnings) out("vf", c.yellow(`! ${w}`));
    for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
    if (result.ok) {
      out(
        "vf",
        c.green(
          `✔ synced ${result.synced.length} skill mirror(s) (mode=${result.mode}) → ${result.synced.slice(0, 3).join(", ")}${result.synced.length > 3 ? "…" : ""}`,
        ),
      );
      return 0;
    }
    out("vf", c.red(`✗ ${result.errors.length} sync error(s)`), { level: "error" });
    return 1;
  }
  if (sub === "verify-sync") {
    const result = verifySkillSync(repo);
    for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
    if (result.ok) {
      out("vf", c.green(`✔ all ${result.synced.length} mirror(s) in sync`));
      return 0;
    }
    out("vf", c.red(`✗ ${result.errors.length} mirror(s) out of sync`), { level: "error" });
    return 1;
  }
  if (sub === "import") {
    const target = rest.join(" ").trim();
    if (!target) {
      out("vf", c.red("Usage: vf skills import <dir>   (a directory containing SKILL.md)"), {
        level: "error",
      });
      return 2;
    }
    // Heuristic: if target is an existing directory with a SKILL.md child,
    // treat as a single-skill import; otherwise treat as a parent dir of
    // multiple skills. `context7:<query>` is a network lookup and is not
    // auto-executed — surface a hint to the user.
    if (target.startsWith("context7:")) {
      out(
        "vf",
        c.yellow(
          `! context7 lookup not auto-executed. Run \`vf discover skills ${target.slice("context7:".length)} --yes\` first, then \`vf skills import <download-dir>\`.`,
        ),
      );
      return 2;
    }
    const result = importSkillFromDir(repo, target);
    // If single-skill import found nothing, try parent-dir import.
    const finalResult = result.imported.length > 0 ? result : importSkillsFromParent(repo, target);
    for (const w of finalResult.warnings) out("vf", c.yellow(`! ${w}`));
    for (const e of finalResult.errors) out("vf", c.red(`✗ ${e}`));
    if (finalResult.ok) {
      out(
        "vf",
        c.green(
          `✔ imported ${finalResult.imported.length} skill(s): ${finalResult.imported.join(", ")}`,
        ),
      );
      return 0;
    }
    out("vf", c.red(`✗ import failed: ${finalResult.errors.join("; ")}`), { level: "error" });
    return 1;
  }
  if (sub === "init") {
    const name = rest[0]?.trim();
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      out("vf", c.red("Usage: vf skills init <name>  (lowercase-hyphen, e.g. compose-screen-ux)"), {
        level: "error",
      });
      return 2;
    }
    const dir = join(repo, CTX_DIR, "skills", name);
    const skillMd = join(dir, "SKILL.md");
    if (existsSync(skillMd)) {
      out("vf", c.red(`Skill "${name}" already exists at ${skillMd}.`), {
        level: "error",
      });
      return 1;
    }
    writeFileSafe(skillMd, skillTemplate(name));
    out("vf", c.green(`+ scaffolded skill ${c.bold(name)} → ${skillMd}`));
    out(
      "vf",
      c.dim(
        "Edit triggers/capabilities so `vf skills search <task>` matches it, then fill the steps.",
      ),
    );
    return 0;
  }
  out(
    "vf",
    c.dim(`vf skills ${sub} — registry operations are configured via providers (see docs).`),
  );
  return 0;
}

/** A starter SKILL.md: valid frontmatter (so discoverSkills/parseSkill accept it) + a steps stub. */
function skillTemplate(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: One-line summary of what this skill does and when to apply it.",
    "status: draft",
    "capabilities:",
    "  - capability-keyword",
    "triggers:",
    "  - trigger-keyword",
    "requires:",
    "  filesystem: read",
    "  network: false",
    "  shell: false",
    "---",
    "",
    `# ${name}`,
    "",
    "## When to use",
    "Describe the task shape that should invoke this skill.",
    "",
    "## Steps",
    "1. First concrete step.",
    "2. Next step.",
    "",
    "## Verification",
    "How to prove the skill was applied correctly (command output, file check, test).",
    "",
  ].join("\n");
}

/**
 * External docs/skill discovery via Context7 — network only with explicit approval.
 * Rides the stdlib `fetch` HTTP path (zero-install); `inject.fetchFn` is a test-only seam so
 * suites never hit the wire. Discovery results are experimental at most and skill names are
 * sanitized to a path-safe slug before they are surfaced.
 */
export async function discover(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
  inject: { fetchFn?: typeof fetch } = {},
): Promise<number> {
  const query = rest.join(" ").trim();
  const approved = Boolean(flags.yes);
  if (sub !== "docs" && sub !== "skills") {
    out("vf", c.red("Usage: vf discover <docs|skills> <query> [--yes]"), {
      level: "error",
    });
    return 2;
  }
  if (!query) {
    out("vf", c.red(`Usage: vf discover ${sub} <query> [--yes]`), {
      level: "error",
    });
    return 2;
  }
  const opts = { approved, fetchFn: inject.fetchFn };
  const { lookupDocsHttp: lookup, searchSkillsHttp: search } = await import(
    "./discovery/context7.js"
  );
  const outcome = sub === "docs" ? await lookup(query, opts) : await search(query, opts);
  if (outcome.approvalRequired) {
    out("vf", c.yellow(`${outcome.reason} Re-run with --yes to approve the network lookup.`));
    return 0;
  }
  if (!outcome.ok) {
    out("vf", c.red(outcome.reason ?? "discovery failed"), {
      level: "error",
    });
    return 1;
  }
  for (const r of outcome.results) {
    const tag = r.status ? c.yellow(`[${r.status}]`) : c.dim(`[${r.kind}]`);
    const slug = r.name ? c.dim(` name: ${r.name}`) : "";
    out("vf", `${tag} ${c.bold(r.title)} — ${r.snippet}${slug}`);
  }
  if (!outcome.results.length) out("vf", c.dim("(no results)"));
  return 0;
}

/** Hook entry: read a JSON event from stdin, score risk, print a decision, set exit code. */
// Test seam: accepts a custom stdin source and timeout so unit tests
// can drive the hook flow without a real process.stdin.
export async function hook(
  inject: {
    stdin?: { on: any; once: any; resume: any; pause: any };
    stdinTimeoutMs?: number;
  } = {},
): Promise<number> {
  // Claude Code spawns the hook with a JSON payload on stdin but does NOT
  // close the pipe. The kernel/pipe can split the payload across multiple
  // "data" events (e.g. > 64 KiB crosses the typical pipe chunk boundary),
  // so we MUST accumulate chunks until the stream ends (or times out) and
  // only then try to parse. Using `once("data", …)` (the old shape) read
  // only the first chunk, truncating multi-chunk JSON; parseHookInput then
  // failed on the partial prefix and the live tool gate fail-opened —
  // letting any unrecognized input through. The fix uses `on("data", …)`
  // with a balanced-brace check to detect a complete JSON object, falling
  // back to the timeout if the stream never produces a complete payload.
  // A 5 s timeout guards against a hook that receives no input at all
  // (fallback session where the hook pipe is /dev/null or similar).
  const stdin = inject.stdin ?? process.stdin;
  const timeoutMs = inject.stdinTimeoutMs ?? 5000;
  const MAX_STDIN_BYTES = 1 * 1024 * 1024; // 1 MiB hard cap (security: CWE-400)
  let raw = "";
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    stdin.pause();
  };
  const finish = (resolve: () => void) => {
    clearTimeout(timer);
    settle();
    resolve();
  };
  let timer: ReturnType<typeof setTimeout>;
  await new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      // Timeout: either no data at all (fallback session, fail-open) or
      // partial data (truncated stream, fail-CLOSED on the live gate).
      finish(resolve);
    }, timeoutMs);
    stdin.on("data", (chunk: Buffer) => {
      if (settled) return;
      const text = chunk.toString("utf8");
      // Cap total bytes read to avoid OOM from a hostile/greedy peer.
      if (raw.length + text.length > MAX_STDIN_BYTES) {
        raw = raw + text.slice(0, MAX_STDIN_BYTES - raw.length);
        finish(resolve);
        return;
      }
      raw += text;
      // Try to detect a complete JSON object. If parseHookInput succeeds
      // and yields a non-null HookInput, the payload is complete. This
      // handles multi-chunk JSON without waiting for `end` (which may
      // never come — Claude Code keeps the pipe open).
      if (raw.trim()) {
        try {
          const parsed = parseHookInput(raw);
          if (parsed !== null) {
            finish(resolve);
            return;
          }
        } catch {
          // Not yet a complete JSON; keep accumulating until timeout.
        }
      }
    });
    stdin.resume();
  });
  // Decide the gate outcome.
  // - raw is empty (no input ever arrived): fallback session, fail-OPEN.
  // - raw is non-empty but parseHookInput fails: hostile/truncated input,
  //   fail-CLOSED on the live tool gate (was: fail-open, security bug).
  const trimmed = raw.trim();
  if (!trimmed) {
    out(
      "vf",
      JSON.stringify({
        decision: "allow",
        risk: "none",
        reasons: ["no hook input — allowing (fallback session)"],
      }),
    );
    return 0;
  }
  const input = parseHookInput(trimmed);
  if (!input) {
    out(
      "vf",
      JSON.stringify({
        decision: "block",
        risk: "high",
        reasons: ["unrecognized hook input — blocking (fail-closed on live tool gate)"],
      }),
    );
    return 2;
  }
  const result = evaluateHook(input);
  // presentDecision emits the structured Claude "ask" envelope for PreToolUse approvals while
  // keeping the exit-code veto (2) correct for block / require_approval on every engine.
  const { json, exitCode } = presentDecision(result, input);
  out("vf", json);
  return exitCode;
}

/** Where the dogfood self-test report lands — knowledge/ survives checkpoint gitignore. */
const SELFCHECK_REL = `${CTX_DIR}/knowledge/hook-selfcheck.json`;

/**
 * `vf hook --selftest` (item 3): run the FIXED attack+benign corpus through the real decision
 * path with NO engine spawn, write an auditable report to .vibeflow/knowledge/hook-selfcheck.json,
 * and return 0 only when every case holds (each attack blocked, each benign allowed). A regression
 * returns nonzero. `now`/`base` are injectable so tests stay deterministic and never dirty the repo.
 */
export function hookSelftest(
  inject: {
    base?: string;
    now?: () => string;
    // Test seam: inject a custom runSelftest to simulate regressions
    // (i.e. report.failed > 0) for the failure-branch coverage at
    // line 2068-2069.
    runSelftest?: (now: () => string) => SelftestReport;
  } = {},
): number {
  const base = inject.base ?? cwd();
  const now = inject.now ?? (() => new Date().toISOString());
  const report = (inject.runSelftest ?? runSelftest)(now);
  writeFileSafe(join(base, SELFCHECK_REL), JSON.stringify(report, null, 2));
  for (const c0 of report.cases) {
    const mark = c0.pass ? c.green("✓") : c.red("✗");
    out("vf", `${mark} [${c0.expected}→${c0.actual}] ${c0.risk} · ${c0.input}`);
  }
  if (report.failed > 0) {
    out("vf", c.red(`\n${report.failed}/${report.cases.length} self-test case(s) regressed.`));
    return 1;
  }
  out(
    "vf",
    c.green(`\nhook self-test: ${report.passed}/${report.cases.length} pass → ${SELFCHECK_REL}`),
  );
  return 0;
}

/** True when an engine's hook config actually delegates to `vf hook` (the only way the
 *  live per-tool-call guardrail is armed). For Claude Code, that means a `PreToolUse`
 *  entry in `.claude/settings.json` whose command points at our CLI. For GitHub
 *  Copilot, a `preToolUse` entry in `.github/hooks/copilot.json` whose `bash` /
 *  `powershell` field points at our CLI. Codex has no native pre-tool veto, so its
 *  config alone does not arm the guardrail. The probe matches on either the
 *  `# vibeflow-guardrail` sentinel (Copilot) or a `dist/cli.js hook` argv (Claude) so
 *  unrelated mentions of "vf hook" can never read as ON (issue #79 re-review). */

function installHooks(): number {
  // PR28 audit Task 7 (M3): the old code only printed a green success line when
  // git exited 0. On non-zero exit (not a git repo, read-only filesystem, missing
  // .githooks dir, etc.) it silently returned the bad status — the user saw
  // nothing. Now we surface the git stderr AND a hint about the most likely cause.
  // The stdio is still "inherit" for stdout so the git output stays visible in
  // CI / scripted invocations; we just need to know when it FAILED.
  const r = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
    stdio: ["ignore", "inherit", "pipe"],
  });
  const status = r.status ?? 0;
  if (status === 0) {
    out("vf", c.green("Installed: core.hooksPath → .githooks"));
    return 0;
  }
  // Failure: surface stderr + likely cause. The hint text is intentionally generic —
  // the most common failure in this codebase is "not a git repo" (this command is
  // sometimes run from a fresh clone before `git init`), followed by "filesystem is
  // read-only" (CI on a release branch) and "permission denied on .git/config".
  const stderr = r.stderr?.toString()?.trim() ?? "";
  out(
    "vf",
    c.red(
      `git config core.hooksPath failed (status ${status}). ${stderr ? `git said: ${stderr}. ` : ""}Are you inside a git repo with write access to .git/config?`,
    ),
    { level: "error" },
  );
  return status;
}

export function hooks(
  sub: string | undefined,
  flags: Record<string, string | boolean> = {},
): number {
  switch (sub) {
    case "install":
      return installHooks();
    case undefined:
    case "status": {
      const r = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" });
      const path = r.stdout.trim();
      out(
        "vf",
        path
          ? `core.hooksPath = ${path}`
          : c.yellow("core.hooksPath not set — run `vf hooks install`"),
      );
      // The live per-tool-call guardrail only exists if .claude/settings.json delegates a
      // PreToolUse hook to `vf hook`. Report it LOUDLY — a silent "OFF" reads as "protected".
      out("vf", liveGuardrailArmed(cwd()) ? c.green("live guardrail: ON") : guardrailOffNote());
      return 0;
    }
    case "emit": {
      const files = engineHookFiles();
      // Default to a DRY RUN: writing .claude/settings.json hot-reloads a PreToolUse hook
      // into the running agent, so never overwrite engine configs without explicit --yes.
      if (!flags.yes || flags["dry-run"]) {
        for (const rel of Object.keys(files)) out("vf", `${c.dim("[dry-run]")} ${rel}`);
        out(
          "vf",
          c.yellow(
            ".claude/settings.json installs a PreToolUse hook that affects the running agent.",
          ),
        );
        out("vf", c.dim("Re-run with --yes to write."));
        return 0;
      }
      // --yes: write per-engine hook configs into the active repo, all delegating to `vf hook`.
      for (const [rel, content] of Object.entries(files)) {
        const dest = join(cwd(), rel);
        writeFileSafe(dest, content);
        // Git only runs hooks under core.hooksPath if they're executable — chmod the shell hooks.
        if (rel.startsWith(".githooks/")) {
          try {
            chmodSync(dest, 0o755);
          } catch {
            /* best-effort: non-POSIX filesystems may not support the bit */
          }
        }
        out("vf", `${c.green("+")} ${rel}`);
      }
      return 0;
    }
    default:
      out("vf", c.red(`Unknown: vf hooks ${sub}`), {
        level: "error",
      });
      return 2;
  }
}

/** Plan which toolchain gates `vf verify` should run, by detecting the project's build system.
 * Pure + injectable (exists/readScripts) so it's testable without a real filesystem. */
export type ToolchainPlan =
  | { kind: "npm"; runner: string; gates: string[] }
  | { kind: "gradle"; cmd: string }
  | { kind: "monorepo"; runner: string; dir: string; gates: string[] }
  | { kind: "none" };

export function detectToolchain(
  base: string,
  opts: {
    exists?: (p: string) => boolean;
    readScripts?: (p: string) => string[];
    runner?: string;
  } = {},
): ToolchainPlan {
  const exists = opts.exists ?? existsSync;
  const runner = opts.runner ?? (hasCommand("bun") ? "bun" : "npm");
  const readScripts =
    opts.readScripts ??
    ((p: string) =>
      Object.keys(
        (JSON.parse(readFileSync(p, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {},
      ));
  const root = join(base, "package.json");
  if (exists(root)) {
    const gates = readScripts(root).filter((s) => ["typecheck", "lint", "test"].includes(s));
    return { kind: "npm", runner, gates };
  }
  if (
    ["build.gradle.kts", "build.gradle", "settings.gradle.kts"].some((f) => exists(join(base, f)))
  ) {
    return { kind: "gradle", cmd: exists(join(base, "gradlew")) ? "./gradlew" : "gradle" };
  }
  for (const d of ["web", "app", "frontend"]) {
    const p = join(base, d, "package.json");
    if (exists(p)) {
      const gates = readScripts(p).filter((s) =>
        ["typecheck", "lint", "test", "build"].includes(s),
      );
      return { kind: "monorepo", runner, dir: join(base, d), gates };
    }
  }
  return { kind: "none" };
}

export function verify(inject: { spawner?: typeof spawnSync } = {}): number {
  let failed = 0;
  const base = cwd();
  const runGate = (label: string, cmd: string, args: string[], dir = base) => {
    out("vf", c.cyan(`▶ ${label}`));
    // Test seam: tests inject a fake spawner to avoid the 28s
    // gradle download on CI. Production callers fall through to
    // the real spawnSync.
    const r = (inject.spawner ?? spawnSync)(cmd, args, { stdio: "inherit", cwd: dir });
    if (r.status !== 0) {
      failed++;
      out("vf", c.red(`✗ ${label} failed`));
    } else {
      out("vf", c.green(`✓ ${label}`));
    }
  };

  // Toolchain gates — detect the project's build system instead of assuming npm.
  const plan = detectToolchain(base);
  if (plan.kind === "npm") {
    for (const gate of plan.gates)
      runGate(`${plan.runner} run ${gate}`, plan.runner, ["run", gate]);
    if (plan.gates.length === 0)
      out("vf", c.dim("package.json has no typecheck/lint/test scripts."));
  } else if (plan.kind === "gradle") {
    runGate(`${plan.cmd} check`, plan.cmd, ["check"]);
  } else if (plan.kind === "monorepo") {
    const label = plan.dir.split("/").pop();
    for (const gate of plan.gates)
      runGate(`(${label}) ${plan.runner} run ${gate}`, plan.runner, ["run", gate], plan.dir);
  } else {
    out(
      "vf",
      c.yellow(
        "⚠ no package.json or Gradle build found — skipping toolchain gates (unsupported build system)",
      ),
    );
  }

  // Policy gates (confidence / evidence / scope) over the workflow ledger.
  const report = policyGates(readState());
  for (const ok of report.passed) out("vf", c.green(`✓ ${ok}`));
  for (const w of report.warnings) out("vf", c.yellow(`⚠ ${w}`));
  for (const f of report.failures) {
    failed++;
    out("vf", c.red(`✗ ${f}`));
  }

  // e2e advisory gates — non-fatal warnings only.
  for (const w of e2eUnicodeSelectorWarning(base)) out("vf", c.yellow(`⚠ ${w}`));
  for (const w of e2eEvaluateDynamicImportWarning(base)) out("vf", c.yellow(`⚠ ${w}`));

  if (failed > 0) {
    out("vf", c.red(`\n${failed} gate(s) failed.`));
    appendJournal(base, "verify", "fail", [
      `${failed} gate(s) failed`,
      ...report.failures.map((f) => `- ${f}`),
    ]);
    return 1;
  }
  out("vf", c.green("\nAll configured gates passed."));
  appendJournal(base, "verify", "pass", [
    `${report.passed.length} gate(s) passed`,
    ...(report.warnings.length ? [`${report.warnings.length} warning(s)`] : []),
  ]);
  return 0;
}

/** Spawn seam for tool installs — defaults to a real spawnSync, injectable for tests. */
export type StepSpawner = (cmd: string, args: string[]) => { status: number };
const VALID_TOOLS: ToolName[] = ["codegraph", "lsp"];

function isToolName(v: string | undefined): v is ToolName {
  return v === "codegraph" || v === "lsp";
}

/** Languages detected in the active repo, used to build LSP install plans + entries. */
// Test seam: exported so unit tests can exercise the try/catch fallback
// (line 2293-2294) by injecting a throwing scanRepo.
export function repoLanguages(
  base: string,
  inject: { scanRepo?: (b: string) => { languages: string[] } } = {},
): string[] {
  const scan = inject.scanRepo ?? scanRepo;
  try {
    return scan(base).languages;
  } catch {
    return [];
  }
}

/** Render the priority ladder (highest first) from settings for `vf tools status`. */
function renderPriority(settings: VibeSettings): string {
  const rank = priorityRank(settings);
  const tiers: ToolTier[] = ["codegraph", "lsp", "native"];
  return [...tiers].sort((a, b) => rank[b] - rank[a]).join(" > ");
}

/** `vf tools status` — show enabled/installed/priority for each optional tool. */
function toolsStatus(base: string, detectFn?: (name: ToolName) => boolean): number {
  const settings = readSettings(base);
  const languages = repoLanguages(base);
  out("vf", c.bold("Optional developer tools\n"));
  for (const name of VALID_TOOLS) {
    const tool = TOOLS[name];
    const enabled = settings.tools[name];
    const installed = (detectFn ?? tool.detect.bind(tool))(name);
    const en = enabled ? c.green("enabled") : c.dim("disabled");
    const inst = installed ? c.green("installed") : c.yellow("not installed");
    out("vf", `  ${c.bold(tool.title)} [${en}, ${inst}]`);
    out("vf", `    ${c.dim(tool.description)}`);
    if (enabled && !installed) {
      out(
        "vf",
        c.yellow(
          `    ! enabled but binary not on PATH — MCP server won't start. Run \`vf tools install ${name}\`.`,
        ),
      );
    }
  }
  out("vf", `\n  priority: ${c.cyan(renderPriority(settings))}`);
  if (languages.length) out("vf", `  detected languages: ${c.dim(languages.join(", "))}`);
  out("vf", c.dim("\n  Re-run `vf init` after changing tools to regenerate instructions."));
  return 0;
}

/** Repo-relative MCP config files VibeFlow owns and may safely read+rewrite. */
const CLAUDE_MCP_FILE = ".mcp.json";
const CODEX_MCP_FILE = join(".codex", "config.toml");

/** Claude `.mcp.json` shape (only the slice we touch). */
interface ClaudeMcpFile {
  mcpServers: Record<string, StdioServer>;
}

/** Every MCP server name VibeFlow manages, across BOTH tools — the keys we may remove. */
function managedClaudeServerNames(base: string, languages: string[]): string[] {
  const ctx = { workspace: base, languages };
  const all = resolveTools({ codegraph: true, lsp: true }, "claude", ctx);
  const names: string[] = [];
  for (const entry of all.entries) {
    for (const name of Object.keys((entry as JsonMcpEntry).servers)) names.push(name);
  }
  return names;
}

/** Read the repo-owned `.mcp.json` (safe: no secrets). `corrupt` is set when an existing file
 * cannot be parsed, so callers can refuse to overwrite it and avoid losing unrelated servers. */
function readClaudeMcp(path: string): ClaudeMcpFile & { corrupt: boolean } {
  if (!existsSync(path)) return { mcpServers: {}, corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ClaudeMcpFile>;
    return { mcpServers: parsed.mcpServers ?? {}, corrupt: false };
  } catch {
    return { mcpServers: {}, corrupt: true };
  }
}

/**
 * Merge enabled-tool servers into the repo's `.mcp.json` (claude). Managed keys are first
 * stripped (so disabling removes them), then re-added for currently-enabled tools. Unrelated
 * servers are preserved. Returns true when the file changed.
 */
function writeClaudeMcp(base: string, settings: VibeSettings, languages: string[]): boolean {
  const path = join(base, CLAUDE_MCP_FILE);
  const file = readClaudeMcp(path);
  if (file.corrupt) {
    out(
      "vf",
      c.yellow(`! ${CLAUDE_MCP_FILE} is not valid JSON — left untouched. Fix it, then re-run.`),
    );
    return false;
  }
  for (const name of managedClaudeServerNames(base, languages)) delete file.mcpServers[name];
  const ctx = { workspace: base, languages };
  const merged = resolveTools(settings.tools, "claude", ctx);
  for (const entry of merged.entries) {
    Object.assign(file.mcpServers, (entry as JsonMcpEntry).servers);
  }
  const hasServers = Object.keys(file.mcpServers).length > 0;
  if (!hasServers && !existsSync(path)) return false;
  writeFileSafe(path, JSON.stringify({ mcpServers: file.mcpServers }, null, 2));
  return true;
}

/** Serialize one codex `[mcp_servers.x]` section (minimal, only the shapes we emit). */
function tomlSection(entry: TomlMcpEntry): string {
  const lines = [`[${entry.section}]`, `command = ${JSON.stringify(entry.command)}`];
  lines.push(`args = ${JSON.stringify(entry.args)}`);
  if (entry.disabledTools && entry.disabledTools.length > 0) {
    lines.push(`disabled_tools = ${JSON.stringify(entry.disabledTools)}`);
  }
  return lines.join("\n");
}

/**
 * Apply structural gating on codex: when codegraph is enabled, disable the lower-priority
 * LSP servers' tools so the priority is structural, not just advisory in the instructions.
 */
function gateCodexEntries(entries: TomlMcpEntry[], settings: VibeSettings): TomlMcpEntry[] {
  if (!settings.tools.codegraph) return entries;
  return entries.map((entry) =>
    entry.section.startsWith("mcp_servers.lsp-") ? { ...entry, disabledTools: entry.tools } : entry,
  );
}

/**
 * Write a repo-local `.codex/config.toml` for the enabled tools. We DO NOT merge the user's
 * `~/.codex/config.toml`: a zero-dep TOML round-trip of an arbitrary user file risks
 * corruption, so VibeFlow owns this scoped file instead. Returns true when written.
 */
function writeCodexMcp(base: string, settings: VibeSettings, languages: string[]): boolean {
  const ctx = { workspace: base, languages };
  const merged = resolveTools(settings.tools, "codex", ctx);
  const entries = gateCodexEntries(merged.entries as TomlMcpEntry[], settings);
  const path = join(base, CODEX_MCP_FILE);
  if (entries.length === 0) {
    if (existsSync(path)) rmSync(path);
    return false;
  }
  const header =
    "# Managed by VibeFlow (`vf tools`). Repo-local codex MCP config — merge into\n" +
    "# ~/.codex/config.toml or point codex at it. Edit `vf tools enable/disable` to regenerate.";
  writeFileSafe(path, `${header}\n\n${entries.map(tomlSection).join("\n\n")}`);
  return true;
}

/**
 * Copilot's MCP config (`~/.copilot/mcp-config.json`) holds a live secret, so VibeFlow NEVER
 * reads or writes it. Instead we PRINT the exact `copilot mcp add` command per enabled server
 * for the user to run themselves. Returns the printed command count.
 */
function printCopilotMcp(base: string, settings: VibeSettings, languages: string[]): number {
  const ctx = { workspace: base, languages };
  const merged = resolveTools(settings.tools, "copilot", ctx);
  if (merged.entries.length === 0) return 0;
  out("vf", c.bold("\nCopilot (run these — VibeFlow won't touch your secret ~/.copilot):"));
  let count = 0;
  for (const entry of merged.entries) {
    for (const [name, server] of Object.entries((entry as JsonMcpEntry).servers)) {
      const args = server.args.map((a) => JSON.stringify(a)).join(" ");
      out("vf", c.cyan(`  copilot mcp add ${name} -- ${server.command} ${args}`.trim()));
      count++;
    }
  }
  return count;
}

/**
 * Wire enabled tools into every engine's MCP config: merge claude's `.mcp.json`, write the
 * repo-local codex `config.toml` (with structural gating), and print copilot's add commands.
 * Pure tool modules build the entries; the WRITING lives here. Languages drive LSP entries.
 */
function writeToolConfigs(base: string, settings: VibeSettings): void {
  const languages = repoLanguages(base);
  writeClaudeMcp(base, settings, languages);
  writeCodexMcp(base, settings, languages);
  printCopilotMcp(base, settings, languages);
}

/** `vf tools enable|disable <tool>` — flip the flag in SETTINGS.json and report. When enabling
 * with `--yes`, also PROVISION the tool (install the binary if missing, build the index if
 * absent) and report honest readiness, instead of only warning about a missing binary. */
function toolsToggle(
  base: string,
  name: ToolName,
  on: boolean,
  opts: { approved?: boolean; spawner?: StepSpawner; detect?: (name: ToolName) => boolean } = {},
): number {
  const settings = writeSettings(base, { tools: { ...readSettings(base).tools, [name]: on } });
  const word = on ? c.green("enabled") : c.yellow("disabled");
  out("vf", `${word} ${c.bold(TOOLS[name].title)} in ${settingsPath(base)}`);
  writeToolConfigs(base, settings);
  out("vf", `  wrote MCP config to ${join(base, CLAUDE_MCP_FILE)}`);
  if (on && !(opts.detect ?? TOOLS[name].detect.bind(TOOLS[name]))(name)) {
    // Enabling writes .mcp.json pointing at the tool's binary — but if that binary isn't on
    // PATH the MCP server can't start and dispatched engines silently get no navigation.
    if (opts.approved && opts.spawner) {
      const rc = provisionTool(base, name, opts.spawner);
      if (rc !== 0) {
        out(
          "vf",
          c.yellow(
            `  note: ${name} stays enabled in ${settingsPath(base)} but is NOT provisioned — re-run \`vf tools enable ${name} --yes\` after fixing the failure, or \`vf tools disable ${name}\`.`,
          ),
          {
            level: "error",
          },
        );
        return rc;
      }
    } else {
      out(
        "vf",
        c.yellow(
          `  ! ${TOOLS[name].title} binary not found on PATH — the MCP server will not start until it is installed.`,
        ),
      );
      out(
        "vf",
        c.dim(
          `    Run \`vf tools enable ${name} --yes\` to install + index it now, or \`vf tools install ${name}\` for the plan.`,
        ),
      );
    }
  } else if (on && opts.approved && opts.spawner) {
    // Binary present but the per-repo artifact (e.g. code index) may be missing — build it.
    const rc = ensureToolIndex(base, name, opts.spawner);
    if (rc !== 0) return rc;
  }
  out(
    "vf",
    c.dim(
      settings.tools[name] === on ? "Re-run `vf init` to regenerate instructions." : "no change",
    ),
  );
  return 0;
}

/** Run an ordered set of install steps via the spawner, stopping on the first failure.
 * Generic over any tool — drives entirely off the registry's plans, no per-tool branching. */
function runToolSteps(steps: { cmd: string; args: string[] }[], spawner: StepSpawner): boolean {
  for (const step of steps) {
    out("vf", c.cyan(`\n▶ ${step.cmd} ${step.args.join(" ")}`));
    const { status } = spawner(step.cmd, step.args);
    if (status !== 0) {
      out("vf", c.red(`✗ step failed (${status}).`), {
        level: "error",
      });
      return false;
    }
  }
  return true;
}

/** Install a tool (its full install plan) then build its per-repo index if it has one.
 * Generic: reads installPlan/indexPlan off the registry descriptor. Returns an exit code. */
function provisionTool(base: string, name: ToolName, spawner: StepSpawner): number {
  const tool = TOOLS[name];
  const ctx = { workspace: base, languages: repoLanguages(base) };
  if (!runToolSteps(tool.installPlan(ctx).steps, spawner)) {
    out("vf", c.red(`  ${tool.title} is enabled but not provisioned.`), {
      level: "error",
    });
    return 1;
  }
  out("vf", c.green(`  ✓ ${tool.title} installed.`));
  return 0;
}

/** Build a tool's per-repo artifact only when its descriptor reports it absent. Tools with no
 * per-repo artifact (no indexPresent/indexPlan) are no-ops. Exported for direct testing. */
export function ensureToolIndex(base: string, name: ToolName, spawner: StepSpawner): number {
  const tool = TOOLS[name];
  if (!tool.indexPlan || !tool.indexPresent) return 0;
  if (tool.indexPresent(base)) {
    out("vf", c.dim(`  ${tool.title} index present.`));
    return 0;
  }
  const ctx = { workspace: base, languages: repoLanguages(base) };
  if (!runToolSteps(tool.indexPlan(ctx).steps, spawner)) return 1;
  out("vf", c.green(`  ✓ built ${tool.title} index.`));
  return 0;
}

/** `vf tools install <tool>` — print the plan; only execute steps when `--yes` is passed. */
function toolsInstall(
  base: string,
  name: ToolName,
  approved: boolean,
  spawner: StepSpawner,
): number {
  const ctx = { workspace: base, languages: repoLanguages(base) };
  const plan = TOOLS[name].installPlan(ctx);
  out("vf", c.bold(`Install plan for ${TOOLS[name].title}:`));
  for (const step of plan.steps) {
    out("vf", `  ${c.cyan(`${step.cmd} ${step.args.join(" ")}`)}\n    ${c.dim(step.description)}`);
  }
  if (!approved) {
    out("vf", c.yellow("\nNo changes made. Re-run with --yes to execute the plan."));
    return 0;
  }
  for (const step of plan.steps) {
    out("vf", c.cyan(`\n▶ ${step.cmd} ${step.args.join(" ")}`));
    const { status } = spawner(step.cmd, step.args);
    if (status !== 0) {
      out("vf", c.red(`✗ step failed (${status}). Stopping.`), {
        level: "error",
      });
      return 1;
    }
  }
  out(
    "vf",
    c.green(`\nInstalled ${TOOLS[name].title}. Run \`vf tools enable ${name}\` to wire it.`),
  );
  return 0;
}

/**
 * `vf tools` — manage the optional code-navigation tools (codegraph, lsp). Subcommands:
 * status (default), enable/disable <tool>, install <tool> (--yes to execute). The install
 * path mirrors the discovery/hooks approval gate: print-only without --yes, never auto-run.
 */
export function tools(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
  inject: { spawner?: StepSpawner; base?: string; detect?: (name: ToolName) => boolean } = {},
): number {
  const base = inject.base ?? cwd();
  if (sub === undefined || sub === "status") return toolsStatus(base, inject.detect);
  const name = rest[0];
  if ((sub === "enable" || sub === "disable" || sub === "install") && !isToolName(name)) {
    out("vf", c.red(`Usage: vf tools ${sub} <${VALID_TOOLS.join("|")}>`), {
      level: "error",
    });
    return 2;
  }
  const spawner: StepSpawner =
    inject.spawner ??
    ((cmd, args) => ({ status: spawnSync(cmd, args, { stdio: "inherit" }).status ?? 0 }));
  if (sub === "enable")
    return toolsToggle(base, name as ToolName, true, {
      approved: Boolean(flags.yes),
      spawner,
      detect: inject.detect,
    });
  if (sub === "disable")
    return toolsToggle(base, name as ToolName, false, { detect: inject.detect });
  if (sub === "install") {
    return toolsInstall(base, name as ToolName, Boolean(flags.yes), spawner);
  }
  if (sub === "sync") return toolsSync(base, spawner);
  out("vf", c.red(`Unknown: vf tools ${sub}`), {
    level: "error",
  });
  return 2;
}

/** `vf tools sync` — re-index every enabled tool whose binary is present and that has a
 * per-repo index. Called by the post-checkout/post-merge git hooks so a code graph never
 * goes stale across branch switches. A no-op (exit 0) when nothing is enabled/installed, so
 * it's safe to wire as a best-effort hook. Always rebuilds (the index is branch-specific). */
export function toolsSync(
  base: string,
  spawner: StepSpawner,
  inject: { detect?: (name: ToolName) => boolean } = {},
): number {
  const settings = readSettings(base);
  const detect = inject.detect ?? ((name: ToolName) => TOOLS[name].detect());
  let synced = 0;
  for (const name of VALID_TOOLS) {
    const tool = TOOLS[name];
    if (!settings.tools[name]) continue; // not enabled
    if (!tool.indexPlan || !tool.indexPresent) continue; // no per-repo index (e.g. lsp)
    if (!detect(name)) continue; // binary not installed — nothing to run
    out("vf", c.cyan(`▶ re-indexing ${tool.title}`));
    if (!runToolSteps(tool.indexPlan({ workspace: base, languages: [] }).steps, spawner)) {
      out("vf", c.red(`✗ ${tool.title} re-index failed.`), {
        level: "error",
      });
      return 1;
    }
    synced++;
  }
  out("vf", synced ? c.green(`✓ synced ${synced} tool index(es).`) : c.dim("nothing to sync."));
  return 0;
}

export function printVersion(): number {
  out("vf", VERSION);
  return 0;
}

/** Print a delete plan: the workflow summary + targets to remove + preserved files. */
function printDeletePlan(plan: DeletePlan, willApply: boolean): void {
  out("vf", c.bold("Workflow delete plan\n"));
  out("vf", plan.summary);
  out("vf", c.bold("\nWould remove:"));
  for (const t of plan.targets) out("vf", `  ${c.red("-")} ${t}`);
  if (!plan.targets.length) out("vf", c.dim("  (nothing)"));
  if (plan.preserved.length) {
    out("vf", c.bold("\nPreserved:"));
    for (const p of plan.preserved) out("vf", `  ${c.green("•")} ${p}`);
  }
  if (!willApply) {
    out("vf", c.yellow("\nDry run. Re-run with --yes to delete the targets above."));
  }
}

/** `vf workflow delete` — plan (always), then delete only with --yes. Never nukes silently. */
function workflowDelete(flags: Record<string, string | boolean>): number {
  const base = resolveRepo(typeof flags.repo === "string" ? flags.repo : undefined);
  const plan = planDelete(base, { all: Boolean(flags.all) });
  if (!plan.targets.length) {
    out("vf", c.yellow(plan.summary));
    return 0;
  }
  const apply = Boolean(flags.yes);
  printDeletePlan(plan, apply);
  if (!apply) return 0;
  const removed = applyDelete(plan);
  out("vf", c.green(`\nRemoved ${removed.length} target(s).`));
  return 0;
}

/** `vf workflow delete-unit <name>` — remove one unit; list names when not found. */
function workflowDeleteUnit(
  name: string | undefined,
  flags: Record<string, string | boolean>,
): number {
  const base = resolveRepo(typeof flags.repo === "string" ? flags.repo : undefined);
  if (!name?.trim()) {
    out("vf", c.red("Usage: vf workflow delete-unit <name> [--repo <path>]"), {
      level: "error",
    });
    return 2;
  }
  const state = deleteUnit(base, name);
  if (!state) {
    const existing = readState(base);
    out("vf", c.red(`No such unit "${name}".`), {
      level: "error",
    });
    const names = existing?.work_units.map((u) => u.name) ?? [];
    out("vf", names.length ? `Available: ${names.join(", ")}` : c.dim("(no work units)"));
    return 1;
  }
  out("vf", c.green(`Removed unit "${name}". ${state.work_units.length} remaining.`));
  return 0;
}

/** Print the outcome of a merge: added / renamed / conflicts / goal reconciliation. */
function printMergeResult(result: MergeResult): void {
  out("vf", c.bold("Import plan\n"));
  out("vf", `added: ${result.added.length ? result.added.join(", ") : "(none)"}`);
  for (const [from, to] of result.renamed) out("vf", c.yellow(`renamed: ${from} → ${to}`));
  for (const conflict of result.conflicts) out("vf", c.yellow(`conflict: ${conflict.detail}`));
  out("vf", c.dim(result.goalReconciliation));
}

/** `vf workflow import <srcPath>` — merge another workflow; persist only with --yes. */
function workflowImport(src: string | undefined, flags: Record<string, string | boolean>): number {
  const base = resolveRepo(typeof flags.repo === "string" ? flags.repo : undefined);
  if (!src?.trim()) {
    out(
      "vf",
      c.red("Usage: vf workflow import <srcPath> [--on-collision rename|skip|replace] [--yes]"),
      {
        level: "error",
      },
    );
    return 2;
  }
  const onNameCollision = resolveCollision(flags);
  const result = importWorkflow(base, src, { onNameCollision });
  if (!result) {
    out("vf", c.red("Import failed: a workflow must exist in BOTH the source and this repo."), {
      level: "error",
    });
    return 1;
  }
  printMergeResult(result);
  if (!flags.yes) {
    out("vf", c.yellow("\nDry run. Re-run with --yes to persist the merged workflow."));
    return 0;
  }
  writeState(base, result.merged);
  out("vf", c.green(`\nMerged: ${result.merged.work_units.length} total unit(s).`));
  return 0;
}

/** Resolve the collision policy flag, defaulting to "rename" (the safest non-destructive merge). */
function resolveCollision(flags: Record<string, string | boolean>): CollisionPolicy {
  const raw = flags["on-collision"];
  return raw === "skip" || raw === "replace" ? raw : "rename";
}

/**
 * `vf workflow` — manage a saved workflow. Subcommands: delete [--all] [--yes],
 * delete-unit <name>, import <srcPath> [--on-collision] [--yes]. Destructive paths are
 * dry by default and always print exactly what they will touch before --yes acts.
 */
export function workflow(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
): number {
  if (sub === "delete") return workflowDelete(flags);
  if (sub === "delete-unit") return workflowDeleteUnit(rest[0], flags);
  if (sub === "import") return workflowImport(rest[0], flags);
  out("vf", c.red("Usage: vf workflow <delete|delete-unit|import> …"), {
    level: "error",
  });
  return 2;
}

export function printHelp(): number {
  out(
    "vf",
    `${c.bold("VibeFlow")} v${VERSION} — orchestrate Claude Code, Codex & Copilot CLI

  ${c.bold("Usage:")} vf [command] [options]

  ${c.bold("Commands:")}
    ${c.cyan("(none)")}            open the local web UI
    ${c.cyan("ui")}                open the local web UI
    ${c.cyan("doctor")}            check required and optional tools (--probe for live engine readiness)
    ${c.cyan("init")}             generate canonical context + engine files (--engine, --no-ask, --no-ai, --dry-run)
    ${c.cyan("run <engine>")}      dispatch claude | codex | copilot (--yes to launch)
    ${c.cyan("orchestrate")}       plan + dispatch work units in parallel, review, goal-eval (--engine, --yes, --concurrency)
    ${c.cyan("workflow [sub]")}    delete [--all] | delete-unit <name> | import <src> [--on-collision] (--yes to apply)
    ${c.cyan("units [sub]")}       status | show <name> | resources | evidence <name> | add <name> | update <name> [--status s] [--confidence n] | delete <name>
    ${c.cyan("skills [sub]")}      list | search <term> | resolve | validate | sync | verify-sync | import
    ${c.cyan("tools [sub]")}       status | enable <tool> | disable <tool> | install <tool> (--yes)
    ${c.cyan("discover <kind>")}   docs|skills <query> via Context7 (--yes approves network)
    ${c.cyan("hook")}              evaluate a JSON hook event from stdin (allow/warn/require_approval/block)
    ${c.cyan("hooks [sub]")}       status | install | emit (write engine hook configs)
    ${c.cyan("verify")}            typecheck / lint / test + confidence / evidence / scope gates
    ${c.cyan("help, --version")}   show help / version

  ${c.dim("Run `vf <command> --help` for command-specific usage.")}
  `,
  );
  return 0;
}

/** Per-subcommand help blocks. Keys mirror the routing switch in cli.ts. Each entry is a short
 * usage/description/flags block; derived from the actual command implementations above. */
const COMMAND_HELP: Record<string, () => string> = {
  ui: () => `${c.bold("vf ui")} ${c.dim("[--port <n>] [--no-open]")}
Open the local web UI (intake wizard + workflow console). This is also the default
command when you run \`vf\` with no arguments.

${c.bold("Options:")}
  --port <n>    bind to a specific port (default: an ephemeral free port)
  --no-open     start the server without launching a browser

${c.bold("Examples:")}
  vf
  vf ui --port 4173 --no-open`,

  doctor: () => `${c.bold("vf doctor")} ${c.dim("[--probe]")}
Check required (node, git) and optional (bun, engine CLIs, docker) tools, plus
per-engine readiness.

${c.bold("Options:")}
  --probe       run a live engine round-trip instead of a presence/auth check

${c.bold("Examples:")}
  vf doctor
  vf doctor --probe`,

  init: () => `${c.bold("vf init")} ${c.dim("[--engine <claude|codex|copilot>] [--no-ask] [--no-ai] [--dry-run]")}
Generate the canonical context + engine instruction files and a workflow ledger.
By default a hard creation gate refuses when no engine is ready; --dry-run previews
offline (writes nothing). When --engine is omitted, init targets the centralized
DEFAULT_ENGINE (currently "claude"; both init and orchestrate share this default).
AI enrichment is ON by default — pass --no-ai to skip the headless engine dispatch.

${c.bold("Options:")}
  --engine <e>   generate for a single engine (default: claude)
  --no-ask       skip the intake questionnaire in TTY mode
  --no-ai        skip AI enrichment (deterministic context files only)
  --dry-run      read-only preview — print what would be written, change nothing

${c.bold("Examples:")}
  vf init --engine claude
  vf init --no-ask
  vf init --no-ai
  vf init --dry-run`,

  run: () => `${c.bold("vf run")} ${c.dim("<claude|codex|copilot> [--yes]")}
Write the dispatch prompt for one engine. Without --yes it is a read-only dry run;
--yes launches the engine CLI behind the source-protection gate.

${c.bold("Options:")}
  --yes               launch the engine (otherwise dry-run only)
  --auto-wip          snapshot a dirty tree before launching instead of refusing
  --require-git       refuse to launch outside a git repo
  --rollback-on-fail  reset the tree to the pre-dispatch checkpoint on failure

${c.bold("Examples:")}
  vf run claude
  vf run codex --yes`,

  orchestrate:
    () => `${c.bold("vf orchestrate")} ${c.dim("[--engine <e>] [--yes] [--concurrency <n>] [--risk <class>]")}
Dispatch every saved work unit (bounded-parallel), run an independent reviewer,
record evidence, then evaluate the goal. Default mode is a read-only dry run.

${c.bold("Options:")}
  --engine <e>        target engine (default: claude)
  --yes               real run — launch the engine (otherwise dry preview)
  --concurrency <n>   max units dispatched in parallel
  --risk <class>      docs | simple-code | feature | architecture | security | deploy
  --auto-wip / --require-git / --rollback-on-fail   source-protection toggles

${c.bold("Examples:")}
  vf orchestrate
  vf orchestrate --engine codex --yes --concurrency 2`,

  workflow: () => `${c.bold("vf workflow")} ${c.dim("<delete | delete-unit | import> …")}
Manage a saved workflow. Destructive paths are dry by default and print exactly what
they will touch before --yes applies them.

${c.bold("Subcommands:")}
  delete [--all] [--yes]                          remove the workflow (or everything with --all)
  delete-unit <name> [--repo <path>]              remove a single work unit
  import <src> [--on-collision rename|skip|replace] [--yes]   merge another workflow

${c.bold("Examples:")}
  vf workflow delete
  vf workflow import ../other-repo --yes`,

  units:
    () => `${c.bold("vf units")} ${c.dim("[status | show <name> | resources | evidence <name> | add <name> | update <name> | delete <name>]")}
Inspect and mutate work units in the workflow ledger.

${c.bold("Subcommands:")}
  status                                  list every unit and its gates (default)
  show <name>                             print one unit as JSON
  resources                               totals: units / tokens / cost / wall-seconds
  evidence <name>                         list a unit's recorded evidence
  evidence <name> --add "<text>"          append an evidence record to a unit
  add <name>                              add a new (pending) unit
  update <name> [--status s] [--confidence n]   patch a unit
  delete <name>                           remove a unit

${c.bold("Examples:")}
  vf units status
  vf units update auth --status done --confidence 1`,

  skills: () =>
    `${c.bold("vf skills")} ${c.dim("[list | search <term> | resolve | validate | sync | verify-sync | import]")}
Inspect locally discovered skills, validate the store, sync to engine mirrors,
and import external skills into the canonical store.

${c.bold("Subcommands:")}
  list                       list discovered skills (default)
  search <term>              rank skills matching a task description
  resolve                    report which skill needs are satisfied locally vs. on demand
  validate                   validate skill format per Anthropic standard (errors, warnings)
  sync [--mode pointer|full] sync .vibeflow/skills → engine mirrors
  verify-sync                verify each engine mirror has every canonical skill
  import <dir-or-query>      import a local skill dir (or context7 query) into the canonical store

${c.bold("Examples:")}
  vf skills list
  vf skills search "read a pdf"
  vf skills validate
  vf skills sync --mode pointer
  vf skills import .vibeflow/skills/external-skill
  vf skills import context7:react-hooks`,

  tools:
    () => `${c.bold("vf tools")} ${c.dim("[status | enable <tool> | disable <tool> | install <tool> [--yes]]")}
Manage the optional code-navigation tools (codegraph, lsp).

${c.bold("Subcommands:")}
  status                  show enabled/installed/priority for each tool (default)
  enable <tool>           enable a tool and wire its MCP config
  disable <tool>          disable a tool and remove its MCP config
  install <tool> [--yes]  print the install plan; --yes executes it

${c.dim("tool = codegraph | lsp")}

${c.bold("Examples:")}
  vf tools status
  vf tools enable codegraph`,

  discover: () => `${c.bold("vf discover")} ${c.dim("<docs|skills> <query> [--yes]")}
Look up external docs or skills via Context7. The network is only touched with
explicit approval.

${c.bold("Options:")}
  --yes         approve the network lookup (otherwise prints an approval prompt)

${c.bold("Examples:")}
  vf discover docs react --yes
  vf discover skills "pdf reader" --yes`,

  hook: () => `${c.bold("vf hook")} ${c.dim("[--selftest]")}
Read a JSON hook event from stdin, score its risk, and print a decision
(allow / warn / require_approval / block) with the matching exit code.

${c.bold("Options:")}
  --selftest    run the fixed attack+benign corpus and write an audit report

${c.bold("Examples:")}
  echo '{"tool":"Bash","input":"rm -rf /"}' | vf hook
  vf hook --selftest`,

  hooks: () => `${c.bold("vf hooks")} ${c.dim("[status | install | emit [--yes] [--dry-run]]")}
Manage git/engine hook wiring (all hooks delegate to \`vf hook\`).

${c.bold("Subcommands:")}
  status     show the configured core.hooksPath (default)
  install    point git core.hooksPath at .githooks
  emit       write per-engine hook config files into the repo
             (dry-run by default; pass --yes to actually write)

${c.bold("Examples:")}
  vf hooks status
  vf hooks install
  vf hooks emit           ${c.dim("# dry-run: show what would be written")}
  vf hooks emit --yes`,

  verify: () => `${c.bold("vf verify")}
Run the project's toolchain gates (typecheck / lint / test, auto-detected for
npm/Gradle/monorepo) plus the policy gates (confidence / evidence / scope) over the
workflow ledger. Returns nonzero if any gate fails.

${c.bold("Examples:")}
  vf verify`,
};

/** True when `cmd` is a known subcommand that carries its own help block. */
export function hasCommandHelp(cmd: string | undefined): boolean {
  return cmd !== undefined && cmd in COMMAND_HELP;
}

/** Print the help block for a single subcommand. Falls back to global help when unknown. */
export function printCommandHelp(cmd: string): number {
  const render = COMMAND_HELP[cmd];
  if (!render) return printHelp();
  out("vf", render());
  return 0;
}
