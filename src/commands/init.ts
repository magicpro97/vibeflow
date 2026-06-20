// src/commands/init.ts
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
  assertCoordBriefFresh,
  assertCoordBriefReady,
  basename,
  c,
  collectInitAskQuestionnaireData,
  copySkillCreator,
  cwd,
  ensureCtx7Auth,
  ensureToolIndex,
  existsSync,
  generateWorkflowArtifacts,
  hasCommand,
  initAskQuestionnaireToIntakeAnswers,
  join,
  out,
  panel,
  provisionTool,
  readSettings,
  runFindSkillsFallback,
  runInitAiEnrichment,
  spawnSync,
  updateLastConsult,
  writeSettings,
  writeToolConfigs,
} from "./_shared.js";
import type {
  AgentEngine,
  AsyncSpawner,
  Ctx7AuthResult,
  Engine,
  EngineReadiness,
  IntakeAnswers,
  PreflightFn,
  StepSpawner,
  UnitDispatcher,
  WorkflowPhase,
} from "./_shared.js";

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
  // A1 brief-surface gate (#167 + #194): `vf init` ALWAYS consults the
  // brief and gates on freshness, unless `--no-coord` opts out (the
  // OOB 2026-06-20 user feedback: "dùng vf init là chạy luôn ai mode
  // và ai tự điều phối luôn, không cần cờ --coord"). The legacy
  // `--coord` flag from A0 is accepted as a no-op for back-compat
  // (a follow-up PR can remove it).
  const noCoord = flags["no-coord"] === true;
  if (flags.coord) {
    out(
      "vf",
      c.yellow(
        "::notice: --coord is deprecated. `vf init` now consults the brief by default; pass --no-coord to opt out.",
      ),
    );
  }
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
  initSpinner.start(dry ? "➥ Preparing init dry run" : "➥ Generating VibeFlow context");
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

  // Phase 2: AI enrichment (only when --ai, not dry, and Phase 1 succeeded).
  // Extracted to src/commands/init-ai.ts (issue #80, phase 9/14); the
  // captured closure variables are passed explicitly. The dry-run prompt
  // previews live inside the same helper.
  await runInitAiEnrichment({
    ai,
    dry,
    refused: Boolean(result.refused),
    initEngine,
    useAgentTeam,
    hasPhases,
    answers,
    ctx7Auth,
    autopilot: Boolean(flags.autopilot),
    inject: {
      aiSpawner: inject.aiSpawner,
      aiPreflight: inject.aiPreflight,
      dispatcher: inject.dispatcher,
    },
  });

  return 0;
}
