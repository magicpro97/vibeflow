// src/commands/init.ts
//
//
// The `vf init` CLI entry point (issue #80, phase 9/14). After the
// facade split this file holds only the orchestration surface:
//
// - init(): the CLI command. Runs the deterministic Phase 1.x baseline
//   (via applyIntake), tool provisioning (Phase 1.6), the ctx7 auth +
//   find-skills fallback (Phases 1.7-1.8), then hands off to the Phase 2
//   AI enrichment.
// - reportPreflightRefusal(): the "no engine ready" refusal printer that
//   init() returns when the preflight gate refuses.
//
// The rest of the init cluster lives in sibling files, all reached
// through the _shared barrel (the no-cycle rule forbids direct sibling
// imports):
//   - init-apply.ts: applyIntake + the IntakeAnswers / ApplyIntake* types
//     + PreflightFn + DEFAULT_ENGINE + chosenEngines / contextFrom /
//     gateEngines.
//   - init-ctx7.ts: ensureCtx7Auth + defaultAskConfirm +
//     runFindSkillsFallback + Ctx7AuthResult.
//   - init-ai.ts: runInitAiEnrichment (Phase 2) + InitAiEnrichmentOpts.
import {
  BRIEF_PATH,
  CTX_DIR,
  DEFAULT_ENGINE,
  ENGINES,
  Spinner,
  applyIntake,
  assertCoordBriefReady,
  c,
  collectInitAskQuestionnaireData,
  cwd,
  existsSync,
  initAskQuestionnaireToIntakeAnswers,
  join,
  out,
  panel,
  type spawnSync,
  updateLastConsult,
  writeToolConfigs,
} from "./_shared.js";
import type {
  AsyncSpawner,
  Engine,
  EngineReadiness,
  HookConfig,
  IntakeAnswers,
  MemoryPhaseInject,
  PreflightFn,
  StepSpawner,
  ToolName,
  UnitDispatcher,
} from "./_shared.js";

import { writeInitArtifacts } from "./init-artifacts.js";

/** Print per-engine readiness hints, then a clear refusal line. Returns the nonzero exit code. */
// Test seam: exported so unit tests can verify the readiness listing
// format and the "no engine ready" exit code contract.
export function reportPreflightRefusal(readiness: EngineReadiness[] | undefined): number {
  out("vf");
  out("vf", c.red("No engine is ready — refusing to generate engine files."), {
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
    /** Override tool detection for Phase 1.6 (test seam). Defaults to TOOLS[name].detect(). */
    detectTool?: (name: ToolName) => boolean;
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
    // Test seam: bypass the interactive hooks menu. When provided, this
    // config is armed directly (no TTY/stdin). `null` simulates the user
    // cancelling the menu (init then leaves the existing policy untouched).
    // Production callers leave this undefined; the `process.stdin.isTTY`
    // gate is the only path for end users.
    hookSetup?: HookConfig | null;
    /** Test seam: override the interactive hooks confirm prompt (forwarded to writeInitArtifacts). Defaults to real confirmInput. */
    confirmInput?: (question: string, defaultValue?: boolean) => Promise<boolean>;
    // Test seam: drive Phase 1.5 (claude-mem opt-in) without a TTY or a
    // real install. Forwarded to runMemoryPhase. Production callers leave
    // this undefined; the real prompt + install run.
    memoryInject?: MemoryPhaseInject;
  } = {},
): Promise<number> {
  // A1 brief-surface gate (#167 + #194): `vf init` ALWAYS consults the
  // brief and gates on freshness, unless `--no-coord` opts out (the
  // OOB 2026-06-20 user feedback: "dùng vf init là chạy luôn ai mode
  // và ai tự điều phối luôn, không cần cờ --coord").
  const noCoord = flags["no-coord"] === true;
  if (!noCoord && !flags["dry-run"]) {
    // Auto-coord: consult the brief (marks it fresh) BEFORE the
    // gate runs. This way, `vf init` after a `vf state brief --consult`
    // (even minutes ago) is a single-step action — the user does NOT
    // see a "brief is stale" message; they see the auto-consult
    // happen as part of init.
    // Skip in dry-run mode: dry-run is a preview of the workflow
    // without actually running it; the brief consult would either
    // need to write a real mtime (contradicting dry-run semantics)
    // or refuse (blocking the preview). Either way, dry-run should
    // preview everything including the brief gate's verdict.
    // Skip if the brief DOESN'T EXIST: initial-setup init (no brief
    // yet) should proceed without the gate — the user is creating
    // the brief as part of init's questionnaire. This is the common
    // case for `vf init` on a fresh repo. The pre-existing test
    // surface (commands-coverage.test.ts) plants NO brief and
    // expects init to proceed normally.
    const briefPath = join(cwd(), BRIEF_PATH);
    if (existsSync(briefPath)) {
      // A1 FU #199: use the SHARED gate (shape + freshness) so init
      // and coord stay consistent. A malformed brief must refuse
      // init, not just coord. (The previous code only checked
      // freshness, which let a broken brief through init.)
      updateLastConsult(briefPath, Date.now());
      const code = assertCoordBriefReady(cwd(), Date.now());
      if (code !== 0) return code;
    }
  }
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
  initSpinner.start(dry ? "Preparing init dry run" : "Generating VibeFlow context");
  let result: ReturnType<typeof applyIntake>;
  try {
    result = applyIntake(answers, {
      dry,
      skipPreflight: dry,
      preflight: inject.preflight,
      useAi: false,
      // Keep MCP config in lockstep with SETTINGS. writeToolConfigs
      // comes from the tools.ts sibling via the _shared barrel bridge
      // (the cycle rule forbids importing it directly).
      syncToolConfigs: (base, settings) => {
        if (settings) writeToolConfigs(base, settings, engines);
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
    out("vf");
    out("vf", c.bold(`Generated ${result.files.length} files from canonical context.`));
    for (const rel of result.backedUp ?? []) {
      out("vf", c.dim(`  archived previous ${rel} under ${CTX_DIR}/backup/init-*`));
    }
  }

  return writeInitArtifacts({
    answers,
    result,
    dry,
    ai,
    useAgentTeam,
    initEngine,
    engines,
    flags,
    inject,
  });
}
