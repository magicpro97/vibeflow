// === Subcommand refactor (issue #80, phase 1/14) ===
// All imports + re-exports now live in src/commands/_shared.ts (the barrel).
// Function bodies stay in this file until each is extracted to its own
// per-subcommand module. PR1 only sets up the barrel.
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
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
import { type DiscoveryResult, searchSkillsHttp } from "./discovery/context7.js";
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
    // Test seam: override the `hasCommand` lookup used by the codegraph
    // provisioning block (commands.ts L437). Lets unit tests force the
    // `codegraph` binary to look missing so the else-branch (L445-460)
    // runs. Production callers leave this undefined.
    hasCommandFn?: (cmd: string) => boolean;
    // Test seam: forwarded to the bare `ensureCtx7Auth()` call at
    // L469. Lets unit tests stub the whoami spawner / askConfirm so
    // the ctx7 path (L466-470) executes without blocking on stdin.
    // Production callers leave this undefined.
    ctx7Inject?: {
      spawner?: typeof spawnSync;
      askConfirm?: (q: string) => Promise<boolean | null>;
    };
    // Test seam: replace the real `spawnSync` used by the codegraph
    // install + index blocks (commands.ts L433-436). Lets unit tests
    // drive the install path with a stub spawner. Production callers
    // leave this undefined.
    syncSpawner?: StepSpawner;
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

  // Phase 1.6: Tool provisioning — auto-install codegraph if missing,
  // enable in settings, write MCP config, and build index.
  if (!dry) {
    const syncSpawner: StepSpawner =
      inject.syncSpawner ??
      ((cmd, args) => {
        const result = spawnSync(cmd, args, { cwd: cwd(), stdio: "inherit" });
        return { status: result.status ?? 1 };
      });
    const hasCodegraph = (inject.hasCommandFn ?? hasCommand)("codegraph");
    if (hasCodegraph) {
      const curSettings = readSettings(cwd());
      if (!curSettings.tools?.codegraph) {
        writeSettings(cwd(), { tools: { ...curSettings.tools, codegraph: true } });
        out("vf", c.green("+ enabled codegraph"));
      }
      writeToolConfigs(cwd(), readSettings(cwd()), engines);
      ensureToolIndex(cwd(), "codegraph", syncSpawner);
    } else {
      out("vf", c.cyan("▶ Installing codegraph globally via npm..."));
      const rc = provisionTool(cwd(), "codegraph", syncSpawner);
      if (rc === 0) {
        writeSettings(cwd(), { tools: { ...readSettings(cwd()).tools, codegraph: true } });
        out("vf", c.green("+ enabled codegraph"));
        writeToolConfigs(cwd(), readSettings(cwd()), engines);
      } else {
        out(
          "vf",
          c.yellow(
            "! codegraph install failed — skipping. Run `vf tools install codegraph` manually.",
          ),
        );
      }
    }
  }

  // Phase 1.7: ctx7 auth check — prompt user to login before AI enrichment
  // so the skill-curator unit can use ctx7 CLI directly if authenticated.
  let ctx7Auth: Ctx7AuthResult = { authenticated: false, fallback: true };
  if (ai && !dry && !result.refused && process.stdin.isTTY) {
    out("vf");
    out("vf", c.bold("ctx7 Auth"));
    ctx7Auth = await ensureCtx7Auth(inject.ctx7Inject ?? {});
  }

  // Phase 1.8: find-skills fallback — when ctx7 not authenticated, search
  // Context7 HTTP API for matching skills (zero-install, no auth needed).
  if (ai && !dry && !result.refused && ctx7Auth.fallback) {
    out("vf");
    out("vf", c.bold("Find-Skills"));
    await runFindSkillsFallback(cwd());
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
      // runs 8 adapter units in parallel (analyzer, instruction-writer,
      // skill-curator, tool-configurator, workflow-policy-writer,
      // workflow-state-writer, context-updater, quickstart-writer) and a
      // reviewer per unit. When the user supplied workflow phases, they
      // are passed so the planner generates Tier 2 units alongside the
      // Tier 1 baseline.
      const { runAiInitWorkflow } = await import("./ai-init.js");
      const workflowResult = await runAiInitWorkflow({
        base: cwd(),
        intake: {
          goal: "init",
          engines: aiEngine ? [aiEngine] : [],
          ...(hasPhases ? { workflowPhases: answers.workflowPhases as WorkflowPhase[] } : {}),
        },
        forceEngine: aiEngine,
        ctx7Auth: ctx7Auth.authenticated,
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
        ctx7Auth: ctx7Auth.authenticated,
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

/**
 * Check ctx7 auth status. If not logged in, prompt the user to login via
 * device OAuth flow. Returns the auth result so the caller can decide
 * whether to use ctx7 CLI or the find-skills HTTP fallback.
 *
 * Timeout / non-TTY / skip → fallback mode.
 */
export interface Ctx7AuthResult {
  authenticated: boolean;
  /** true when ctx7 login was skipped or failed (use find-skills fallback). */
  fallback: boolean;
}

export async function ensureCtx7Auth(
  inject: {
    spawner?: typeof spawnSync;
    askConfirm?: (q: string) => Promise<boolean | null>;
  } = {},
): Promise<Ctx7AuthResult> {
  const spawn = inject.spawner ?? spawnSync;
  const ask = inject.askConfirm ?? defaultAskConfirm;
  if (!process.stdin.isTTY) {
    return { authenticated: false, fallback: true };
  }

  // Step 1: quick check
  const whoami = spawn("npx", ["ctx7", "whoami"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const alreadyAuth =
    whoami.status === 0 && whoami.stdout != null && !whoami.stdout.includes("Not logged in");

  if (alreadyAuth) {
    return { authenticated: true, fallback: false };
  }

  // Step 2: prompt user
  out("vf", c.yellow("⚠ ctx7 not logged in"));
  out("vf", c.dim("  ctx7 provides up-to-date library docs for automatic skill discovery."));

  const answer = await ask("  Login now via device OAuth? (Y/n) ");

  if (answer === false || answer === null) {
    out("vf", c.yellow("! ctx7 login skipped — using find-skills (HTTP) fallback"));
    return { authenticated: false, fallback: true };
  }

  // Step 3: run device OAuth login
  out("vf", c.cyan("▶ Starting ctx7 device login..."));
  out("vf", c.dim("  Open the URL below in any browser and enter the code to approve."));

  const login = spawn("npx", ["ctx7", "login", "--no-browser"], {
    stdio: "inherit",
    timeout: 120_000,
  });

  if (login.status === 0) {
    out("vf", c.green("✔ ctx7 authenticated"));
    return { authenticated: true, fallback: false };
  }

  out("vf", c.yellow("! ctx7 login failed or timed out — using find-skills (HTTP) fallback"));
  return { authenticated: false, fallback: true };
}

/**
 * Prompt the user a Y/n question on stdin. Returns true for "y"/""/"Y",
 * false for "n", or null on timeout. Exported for direct unit-test
 * coverage of the PR129 default-ask-confirm path (issue #80 rebase;
 * previously a private function). The `createInterface` parameter is
 * an optional test seam: production callers leave it undefined and
 * the real `node:readline` is used.
 */
export function defaultAskConfirm(
  q: string,
  deps: { createInterface?: typeof createInterface } = {},
): Promise<boolean | null> {
  const mkRl = deps.createInterface ?? createInterface;
  return new Promise((res) => {
    const rl = mkRl({ input: process.stdin, output: process.stdout });
    const timer = setTimeout(() => {
      rl.close();
      res(null);
    }, 15_000);
    rl.question(q, (a) => {
      clearTimeout(timer);
      rl.close();
      res(a.trim().toLowerCase() === "y" || a.trim() === "");
    });
  });
}

/**
 * Find-skills fallback: use Context7 HTTP API (zero-install, no auth needed)
 * to discover skills for the detected stack. Writes results to
 * `.vibeflow/ai-context/find-skills-results.md` so the AI engine can
 * use them during Phase 2 instead of relying on ctx7 CLI.
 */
export async function runFindSkillsFallback(base: string): Promise<void> {
  // Exported for test coverage of the PR129 find-skills fallback path
  // (issue #80 rebase; was a private function on main). Production callers
  // are only `init()` — exporting does not widen the API surface.
  const profile = scanRepo(base);

  // Build search queries from the detected stack
  const queries = new Set<string>();

  // Filter out noisy/placeholder values
  function isNoise(v: string): boolean {
    const lower = v.toLowerCase();
    return (
      lower === "" ||
      lower.length < 3 ||
      lower.includes("none") ||
      lower.includes("not found") ||
      lower.includes("see ") ||
      lower === "configured" ||
      lower === "present" ||
      lower === "yes" ||
      lower === "no" ||
      lower.includes("(see")
    );
  }

  for (const fw of profile.frameworks) {
    if (!isNoise(fw)) queries.add(fw.toLowerCase());
  }

  const majorLangs = new Set([
    "typescript",
    "javascript",
    "java",
    "python",
    "go",
    "rust",
    "kotlin",
    "ruby",
    "php",
    "c#",
    "c++",
    "swift",
    "scala",
  ]);
  for (const lang of profile.languages) {
    const lower = lang.toLowerCase();
    if (majorLangs.has(lower)) queries.add(lower);
  }

  // Add findings that describe real stack components
  for (const f of profile.findings) {
    const val = f.value.toLowerCase();
    if (isNoise(val)) continue;
    const comp = f.component.toLowerCase();
    if (
      comp.includes("framework") ||
      comp.includes("database") ||
      comp.includes("cache") ||
      comp.includes("build") ||
      comp.includes("test") ||
      comp.includes("ui") ||
      comp.includes("orm") ||
      comp.includes("package") ||
      comp.includes("language")
    ) {
      queries.add(val);
    }
  }

  // Add package manager and manifest-specific technology hints
  if (profile.packageManager && !isNoise(profile.packageManager)) {
    queries.add(profile.packageManager.toLowerCase());
  }
  // Derive technology hints from manifest filenames
  for (const m of profile.manifests) {
    const mq = m
      .replace(/\.json$/i, "")
      .replace(/\.yaml$/i, "")
      .replace(/\.yml$/i, "")
      .toLowerCase();
    if (!isNoise(mq)) queries.add(mq);
  }

  // Search Context7 HTTP API in parallel (no auth needed, bounded 8s per call)
  const allResults: DiscoveryResult[] = [];
  const seen = new Set<string>();

  const outcomes = await Promise.allSettled(
    [...queries].map((q) => searchSkillsHttp(q, { approved: true, timeoutMs: 8000 })),
  );

  for (const o of outcomes) {
    if (o.status === "fulfilled" && o.value.ok) {
      for (const r of o.value.results) {
        const key = r.name ?? r.title;
        if (key && !seen.has(key)) {
          seen.add(key);
          allResults.push(r);
        }
      }
    }
  }

  // Write results as markdown for the AI engine
  const ctxDir = join(base, CTX_DIR, "ai-context");
  try {
    mkdirSync(ctxDir, { recursive: true });
  } catch {
    /* best effort */
  }

  if (allResults.length > 0) {
    const lines: string[] = [
      "# Find-Skills Results (Context7 HTTP API)",
      "",
      `Discovered ${allResults.length} library/skill candidates for the detected stack.`,
      `Search queries used: ${[...queries].join(", ")}`,
      "",
      "| Library | Description | Source |",
      "|---------|-------------|--------|",
    ];
    for (const r of allResults) {
      const name = r.name ?? r.title;
      const desc = r.snippet.replace(/\n/g, " ").slice(0, 120);
      lines.push(`| ${name} | ${desc} | ${r.source} |`);
    }
    lines.push("");
    lines.push(
      "Each entry above is a known Context7 library. Use `npx ctx7 docs <name>`",
      "to fetch full documentation, then author the corresponding SKILL.md",
      "following ANTHROPIC_SKILL_STANDARD.md.",
    );

    writeFileSafe(join(ctxDir, "find-skills-results.md"), lines.join("\n"));
    out("vf", c.green(`✔ find-skills: ${allResults.length} library/skill candidate(s) discovered`));
  } else {
    const fallbackNote = [
      "# Find-Skills Results (Context7 HTTP API)",
      "",
      "No results from Context7 HTTP API for the detected stack.",
      `Search queries tried: ${[...queries].join(", ")}`,
      "",
      "Fall back to web search and manual skill authoring as described in step 3c.",
    ];
    writeFileSafe(join(ctxDir, "find-skills-results.md"), fallbackNote.join("\n"));
    out("vf", c.yellow("! find-skills: no candidates discovered"));
  }
}

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
export { hook, hookSelftest, hooks } from "./commands/hooks.js";

// === Re-export the tools cluster (issue #80, phase 8/14) ===
// `vf tools` + `verify` + `repoLanguages` + `ensureToolIndex` +
// `toolsSync` + `detectToolchain` + `StepSpawner` + `ToolchainPlan` +
// `toolsStatus` + `probeIndexHealth` + `writeToolConfigs` + `provisionTool`
// now live in src/commands/tools.ts. The facade re-exports the public
// surface so existing callers (`import { tools, verify, ... } from
// "../commands.js"`) keep working. The body also imports `writeToolConfigs`
// and `provisionTool` directly because the `init` function (still in this
// file) calls them as part of tool auto-provisioning + SETTINGS ↔ MCP-config
// lockstep (see Phase 1.6 in `init`).
export {
  tools,
  toolsSync,
  toolsStatus,
  probeIndexHealth,
  verify,
  repoLanguages,
  ensureToolIndex,
  detectToolchain,
  writeToolConfigs,
  provisionTool,
} from "./commands/tools.js";
export type { StepSpawner, ToolchainPlan } from "./commands/tools.js";
import type { StepSpawner } from "./commands/tools.js";
import { ensureToolIndex, provisionTool, writeToolConfigs } from "./commands/tools.js";
// === Re-export the workflow cluster (issue #80, phase 8/14) ===
// `vf workflow` + `printVersion` now live in src/commands/workflow.ts.
// The facade re-exports them so the CLI dispatch keeps working.
export { workflow, printVersion } from "./commands/workflow.js";
// === Re-export the help cluster (issue #80, phase 8/14) ===
// `printHelp` + `hasCommandHelp` + `printCommandHelp` now live in
// src/commands/help.ts. The facade re-exports them so the CLI
// dispatch (`vf --help`, `vf <sub> --help`) keeps working.
export { printHelp, hasCommandHelp, printCommandHelp } from "./commands/help.js";
