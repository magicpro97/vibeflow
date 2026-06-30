// src/commands/init-ai.ts
//
// Phase 2 AI-enrichment step for `vf init` (issue #80, phase 9/14).
// Extracted from src/commands/init.ts to keep init.ts under the 400-line
// cap. The init() CLI entry point runs Phases 1.x deterministically, then
// hands off to runInitAiEnrichment for the optional AI pass (agent-team
// workflow or the legacy single-shot runAiInit), including the --dry-run
// prompt previews.
//
// Cross-module symbols come through the _shared barrel (cycle rule:
// test/commands-no-cycle.test.ts). runAiInitWorkflow / runAiInit /
// buildAiInitPrompt and the scanner are loaded lazily via dynamic import,
// exactly as they were in the inline init() body, so the AI bundle is only
// pulled in when an enrichment actually runs.

// F3: installLogbus is needed so the engine-stdout/engine-stderr callbacks
// below actually persist to .vibeflow/logs/current.log and reach the SSE
// relay. Without it, the bus singleton is null and out() falls back to
// console-only — no file log, no UI stream, no replay. Mirrors the
// `orchestrate.ts:176` call. installLogbus is idempotent.
import { installLogbus } from "../logbus.js";
import {
  type AgentEngine,
  type AsyncSpawner,
  type Ctx7AuthResult,
  type Engine,
  type EngineReadiness,
  type IntakeAnswers,
  Spinner,
  type UnitDispatcher,
  type WorkflowPhase,
  buildEnrichmentPrompt,
  c,
  cwd,
  makeAsyncSpawner,
  out,
} from "./_shared.js";

/** Default streaming spawner for both enrichment paths: buffers engine
 * stdout/stderr per line and relays each non-empty line to the logbus
 * (engine-stdout / engine-stderr) prefixed with the engine tag. Extracted
 * because the agent-team and legacy branches built byte-identical closures. */
export function makeEnrichmentSpawner(prefix: string): AsyncSpawner {
  let lineBuf = "";
  let errLineBuf = "";
  const flush = (buf: string, channel: "engine-stdout" | "engine-stderr") => {
    const trimmed = buf.trim();
    if (trimmed) out(channel, `${prefix} ${trimmed}`);
  };
  const inner = makeAsyncSpawner({
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
  });
  // Flush the final partial line (no trailing newline) after each spawn and
  // reset buffers so output never leaks across spawn calls.
  return async (cmd, args, input) => {
    try {
      return await inner(cmd, args, input);
    } finally {
      flush(lineBuf, "engine-stdout");
      flush(errLineBuf, "engine-stderr");
      lineBuf = "";
      errLineBuf = "";
    }
  };
}

/** Options for {@link runInitAiEnrichment}. These are the exact closure
 * variables the Phase 2 block captured when it lived inline in init(). */
export interface InitAiEnrichmentOpts {
  /** --ai is on (the enrichment master switch). */
  ai: boolean;
  /** --dry-run: show prompts instead of dispatching. */
  dry: boolean;
  /** Phase 1 refused (no ready engine) — enrichment is skipped. */
  refused: boolean;
  /** The engine resolved from --engine / DEFAULT_ENGINE. */
  initEngine: Engine;
  /** --ai uses the agent-team workflow shape (default) vs legacy runAiInit. */
  useAgentTeam: boolean;
  /** The questionnaire produced workflow phases (Tier 2 units). */
  hasPhases: boolean;
  /** The intake answers (engines + workflowPhases drive prompt building). */
  answers: IntakeAnswers;
  /** ctx7 auth result (authenticated flag forwarded to the AI workflow). */
  ctx7Auth: Ctx7AuthResult;
  /** --autopilot: opt-in engine auto-fallback on the legacy runAiInit path. */
  autopilot: boolean;
  /** Test seams forwarded from init()'s inject parameter. */
  inject: {
    aiSpawner?: AsyncSpawner;
    aiPreflight?: (engines: Engine[], opts: { probe: boolean }) => EngineReadiness[];
    dispatcher?: UnitDispatcher;
  };
}

/** Run the Phase 2 AI-enrichment step (or its dry-run preview). Byte-for-byte
 * the body that previously lived inline in init() after Phase 1.8; the only
 * change is that the captured closure variables are now explicit parameters. */
export async function runInitAiEnrichment(opts: InitAiEnrichmentOpts): Promise<void> {
  const {
    ai,
    dry,
    refused,
    initEngine,
    useAgentTeam,
    hasPhases,
    answers,
    ctx7Auth,
    autopilot,
    inject,
  } = opts;

  // Phase 2: AI enrichment (only when --ai, not dry, and Phase 1 succeeded)
  if (ai && !dry && !refused) {
    // F3: install the logbus before any out("engine-stderr", …) can fire.
    // The onChunk / onStderrChunk callbacks below route engine output to
    // out() — without an installed bus, out() falls through to the
    // console-only fallback (logbus.ts:466-500) and the SSE relay / file
    // log get nothing. Mirrors the M2 contract at orchestrate.ts:176.
    // installLogbus is idempotent (replaces the active singleton).
    installLogbus();
    out("vf");
    const aiEngine = initEngine;
    const prefix = aiEngine ? `[${aiEngine}]` : "[ai]";
    if (useAgentTeam) {
      const aiSpinner = new Spinner();
      aiSpinner.start(" ");
      // B1/T5: --ai defaults to the agent-team workflow shape. The workflow
      // runs 5 adapter units in parallel (analyzer, instruction-writer,
      // skill-curator, context-updater, workflow-state-writer) and a
      // reviewer per unit. When the user supplied workflow phases, they
      // are passed so the planner generates Tier 2 units alongside the
      // Tier 1 baseline.
      const { runAiInitWorkflow } = await import("../ai-init.js");
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
        spawner: inject.aiSpawner ?? makeEnrichmentSpawner(prefix),
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
      const aiSpinner = new Spinner();
      aiSpinner.start(`➥ Running AI enrichment ${prefix}`);
      // Legacy --no-agent-team path: original runAiInit shape.
      // When workflow phases exist, use the enrichment prompt instead.
      const { runAiInit } = await import("../ai-init.js");
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
        spawner: inject.aiSpawner ?? makeEnrichmentSpawner(prefix),
        forceEngine: aiEngine,
        ctx7Auth: ctx7Auth.authenticated,
        // --autopilot: opt-in auto-fallback when the chosen engine is
        // unavailable or returns a permission error. Default false to
        // preserve single-shot behavior (any failure is the user's
        // problem to debug). With --autopilot, runAiInit transparently
        // retries with the next-best ready engine.
        autopilot: autopilot,
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
    const { scanRepo } = await import("../scanner.js");
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
    out("vf");
    out("vf", c.dim(`${prompt.slice(0, 1500)}…`));
  } else if (ai && dry) {
    // Dry-run --ai without phases: show the original AI init prompt
    out("vf");
    out("vf", c.dim("dry-run: prompt would be sent to the best available engine"));
    const { buildAiInitPrompt } = await import("../ai-init.js");
    const { scanRepo } = await import("../scanner.js");
    const base = cwd();
    const profile = scanRepo(base);
    const prompt = buildAiInitPrompt(profile, base);
    out("vf");
    out("vf", c.dim(`${prompt.slice(0, 1500)}…`));
  }
}
