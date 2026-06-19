// src/commands/init.ts
// size-waiver: #137 — A8 init + phonnt's 8-adapter agent-team workflow (293 new lines); 400-line cap waived to ~700.
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
  buildEnrichmentPrompt,
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
  makeAsyncSpawner,
  out,
  panel,
  provisionTool,
  pruneUnselectedEngineFolders,
  readSettings,
  runFindSkillsFallback,
  runInitAiEnrichment,
  runMemoryPhase,
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
  MemoryPhaseInject,
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
    // Test seam: forwarded to `ensureCtx7Auth` so unit tests can
    // stub the ctx7 OAuth flow without spawning a real `npx ctx7`
    // process. Production callers leave this undefined.
    ctx7Inject?: Parameters<typeof ensureCtx7Auth>[0];
    // Test seam: override `hasCommand(<binary>)` so unit tests can
    // stub PATH lookups (e.g. make `codegraph`/`gh` look absent
    // without the test depending on what's actually on PATH).
    // Production callers leave this undefined.
    hasCommandFn?: (cmd: string) => boolean;
    // Test seam: override the per-step spawner used by
    // provisionTool (codegraph install + index build) so unit tests
    // can stub the full tool-install pipeline without spawning
    // `npm` or `codegraph`. Production callers leave this undefined.
    syncSpawner?: StepSpawner;
    // Test seam: drive Phase 1.5 (claude-mem opt-in) without a TTY or a
    // real install. Forwarded to runMemoryPhase. Production callers leave
    // this undefined; the real prompt + install run.
    memoryInject?: MemoryPhaseInject;
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

  // Phase 1.5: Deterministic workflow artifacts (from questionnaire phases).
  // Engine selection: tie Phase 1.5 (deterministic) to the same single
  // engine as Phase 2 (AI) — i.e. the engine the user actually selected
  // via --engine (default copilot). This prevents the previous bug
  // where the questionnaire's `engines` answer (which can contain
  // multiple engines for cross-engine parity probes) caused
  // generateWorkflowArtifacts + copySkillCreator to fan out skill/agent
  // mirror folders to ALL engines in the list, even though Phase 2 only
  // ever dispatches to ONE engine. Net effect: with engine=copilot,
  // only `.github/skills/` is created; `.claude/skills/` and
  // `.agents/skills/` stay absent. Operators who want multi-engine
  // parity should re-run `vf init` with each engine explicitly.
  // Single-engine scope: the deterministic workflow-artifact +
  // skill-creator copy is locked to the engine the user selected
  // (--engine / default copilot). Operators who want each engine's
  // mirror populated must re-run `vf init --engine <name>` for
  // every engine — the mirrors are not cross-mirrored from this
  // single pass. Warn BEFORE the I/O so the user can abort.
  out("vf", c.yellow("⚠ single-engine scope; re-run for each engine you want to mirror to"));
  const hasPhases = Boolean(answers.workflowPhases?.length);
  if (!dry && hasPhases) {
    const projectName = basename(cwd());
    const phases = answers.workflowPhases as WorkflowPhase[];
    const artifactFiles = generateWorkflowArtifacts({
      phases,
      engines: [initEngine],
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
    // installed. Mirror target is locked to the single selected
    // engine (same rationale as the workflow artifacts above).
    if (!result.refused) {
      for (const rel of copySkillCreator(cwd(), [initEngine])) {
        out("vf", c.green(`+ ${rel}/SKILL.md`));
      }
    }
  }

  // Pre-Phase-2 safety net: prune any stale engine-mirror folders left
  // over from a previous init run. This is idempotent — if no stale
  // folders exist, it returns an empty list and the log line is silent.
  // Phase 2 AI enrichment may run `ctx7 skills install --universal`
  // which writes to `.agents/skills/`; that's the EXPECTED scratch path,
  // and the post-Phase-2 cleanup at the end of this function will remove
  // it. Any other engine mirror (`.claude/skills/`, `.claude/agents/`)
  // present BEFORE Phase 2 is stale and must be pruned now.
  if (!dry) {
    const prePruned = pruneUnselectedEngineFolders(cwd(), initEngine);
    if (prePruned.length > 0) {
      out(
        "vf",
        c.dim(`pruned ${prePruned.length} stale engine folder(s): ${prePruned.join(", ")}`),
      );
    }
  }

  // Phase 1.55: claude-mem opt-in. Prompt (TTY) or honour --memory/--no-memory,
  // persist the answer to settings.memory, and on yes wire claude-mem for the
  // workflow's chosen engines (one shared store, one IDE hook per engine) +
  // append the usage guide to WORKFLOW_POLICY.md (written in Phase 1 above).
  // Best-effort: never blocks init. Skipped on dry runs.
  if (!dry && !result.refused) {
    const memoryEngines = (answers.engines?.length ? answers.engines : ENGINES).filter(
      (e): e is Engine => (ENGINES as string[]).includes(e),
    );
    await runMemoryPhase(cwd(), flags, memoryEngines, inject.memoryInject);
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
    ctx7Auth = await ensureCtx7Auth(inject.ctx7Inject);
  }

  // Phase 1.8: find-skills fallback — when ctx7 not authenticated, search
  // Context7 HTTP API for matching skills (zero-install, no auth needed).
  if (ai && !dry && !result.refused && ctx7Auth.fallback) {
    out("vf");
    out("vf", c.bold("Find-Skills"));
    await runFindSkillsFallback(cwd());
  }

  // Phase 1.9: P1-10 — pre-resolve ctx7 candidate repos so the
  // engine's skill-curator unit does not have to try-fail 4-5 names
  // in sequence. Only runs when ctx7 is authenticated (we're going
  // to install from a repo) AND `gh` is available (the resolve
  // helper uses gh). The hint is a no-op when empty, so failure is
  // safe — the engine just falls back to the existing try-fail
  // behaviour with a notice in the spec.
  let ctx7ResolvedReposHint: string | undefined;
  if (ai && !dry && !result.refused && ctx7Auth.authenticated) {
    out("vf");
    out("vf", c.bold("ctx7 Resolve"));
    try {
      // Test seam: when inject.hasCommandFn is set (e.g. unit tests),
      // honor its "gh not on PATH" verdict instead of trying resolveCtx7Repos
      // — which would shell out to `gh` for every candidate repo. The
      // production path (no inject.hasCommandFn) falls through to the
      // real resolveCtx7Repos which uses `gh api ...` per candidate.
      const ghAvailable = (inject.hasCommandFn ?? hasCommand)("gh");
      if (!ghAvailable) {
        out("vf", c.dim("  gh unavailable: gh not on PATH — letting engine try"));
        ctx7ResolvedReposHint = undefined;
      } else {
        const { resolveCtx7Repos, formatResolvedReposHint } = await import(
          "../discovery/ctx7-resolve.js"
        );
        // Build the candidate list from the same whitelist the
        // deterministic curator would use + any repos the user has
        // explicitly mentioned in their intake answers.
        const { DEFAULT_WHITELIST } = await import("../skills/whitelist.js");
        const candidates = DEFAULT_WHITELIST.map((w) => w.repo);
        const r = resolveCtx7Repos(candidates, { timeoutMs: 4_000 });
        if (r.ghUnavailable) {
          out("vf", c.dim(`  gh unavailable: ${r.reason ?? "unknown"} — letting engine try`));
        } else {
          out(
            "vf",
            c.dim(
              `  resolved ${r.found.length}/${candidates.length} repos: ${r.found.length > 0 ? r.found.join(", ") : "(none)"}`,
            ),
          );
        }
        ctx7ResolvedReposHint = formatResolvedReposHint(r);
      }
    } catch (err) {
      // Resolve is best-effort. A failure here should not block
      // the workflow — the engine has its own try-fail fallback.
      out("vf", c.dim(`  resolve failed: ${(err as Error).message} — engine will try directly`));
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
      // runs 8 adapter units in parallel (analyzer, instruction-writer,
      // skill-curator, tool-configurator, workflow-policy-writer,
      // workflow-state-writer, context-updater, quickstart-writer) and a
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
          // P1-10: forward the CLI-resolved ctx7 repo hint so the
          // engine's skill-curator unit skips the try-fail loop.
          ...(ctx7ResolvedReposHint ? { ctx7ResolvedReposHint } : {}),
        },
        forceEngine: aiEngine,
        ctx7Auth: ctx7Auth.authenticated,
        preflight: inject.aiPreflight,
        dispatcher: inject.dispatcher,
        // P1-4: CLI init gets a generous retry budget because the
        // typical init is a 5-10 minute operation and one transient
        // 429 on wave 2 should not waste the work from wave 0/1.
        // 3 retries × exp backoff (cap 120s) can wait up to ~7 min
        // total before giving up. Set to undefined to use the strict
        // default (2 retries, 60s cap) for CI / orchestrate callers.
        dispatcherMaxRetries: 3,
        dispatcherBackoffBaseMs: 2_000,
        dispatcherBackoffCapMs: 120_000,
        // P0-2: serialize wave-0 by default. The CLI default for
        // `vf init` is sequentialWave0=true (set in the workflow
        // options), but we surface it here so test seams can flip it.
        sequentialWave0: true,
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
        // P0-4: surface quota-skipped finisher units so the user knows
        // what was held back and why. Without this, a low-quota init
        // would silently skip 4 units and the user would only notice
        // when their workflow docs were missing.
        const skipped = workflowResult.skippedUnits ?? [];
        if (skipped.length > 0) {
          out(
            "vf",
            c.yellow(
              `! ${skipped.length} optional finisher unit(s) skipped due to low quota: ${skipped.join(", ")}`,
            ),
          );
          out("vf", c.dim("  Re-run `vf init` after the quota window resets to fill them in."));
        }
      } else {
        // Branch the failure message by `blockKind` so the user can tell
        // the difference between "no engine installed" (recoverable by
        // installing one) and "engine ran but a unit failed" (recoverable
        // by re-running init — partial state is on disk). The previous
        // single-message "agent-team workflow skipped" + "Install an
        // engine" fallback conflated the two and pushed the user toward
        // a fix that would not help in the rate-limit case.
        const passed = workflowResult.passedUnits ?? [];
        const total = workflowResult.units.length;
        if (workflowResult.blockKind === "no-engine") {
          aiSpinner.fail("agent-team workflow skipped — no ready engine");
          out("vf", c.yellow(`! ${workflowResult.reason ?? "no engine ready"}`));
          out(
            "vf",
            c.dim("  Install an engine (e.g. `npm i -g @github/copilot`) and re-run `vf init`."),
          );
        } else if (workflowResult.blockKind === "wave-blocked") {
          aiSpinner.fail(`agent-team workflow blocked at ${passed.length}/${total} unit(s) passed`);
          out("vf", c.yellow(`! ${workflowResult.reason ?? "wave blocked"}`));
          if (passed.length > 0) {
            out(
              "vf",
              c.green(
                `  ✔ ${passed.length} unit(s) passed and were persisted to ` +
                  `${CTX_DIR}/WORKFLOW_STATE.json.`,
              ),
            );
            out(
              "vf",
              c.dim(
                `  Re-run \`vf init\` to retry only the remaining unit(s): ${passed.length}/${total} done.`,
              ),
            );
          } else {
            out("vf", c.dim("  Re-run `vf init` once the upstream issue clears."));
          }
        } else {
          aiSpinner.fail("agent-team workflow skipped");
          out("vf", c.yellow(`! agent-team workflow skipped: ${workflowResult.reason}`));
          out(
            "vf",
            c.dim(
              "  Deterministic context files are in place. Re-run `vf init` once the issue clears.",
            ),
          );
        }
      }
    } else {
      let lineBuf = "";
      let errLineBuf = "";
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
              return buildEnrichmentPrompt(phases, [aiEngine], profile, _base);
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
    const { scanRepo } = await import("../scanner.js");
    const base = cwd();
    const profile = scanRepo(base);
    const phases = answers.workflowPhases as WorkflowPhase[];
    const prompt = buildEnrichmentPrompt(
      phases,
      [initEngine],
      { name: profile.name, summary: profile.summary, languages: profile.languages },
      base,
    );
    out("vf", c.dim(`\n${prompt.slice(0, 1500)}…`));
  } else if (ai && dry) {
    // Dry-run --ai without phases: show the original AI init prompt
    out("vf", c.dim("\ndry-run: prompt would be sent to the best available engine"));
    const { buildAiInitPrompt } = await import("../ai-init.js");
    const { scanRepo } = await import("../scanner.js");
    const base = cwd();
    const profile = scanRepo(base);
    const prompt = buildAiInitPrompt(profile, base);
    out("vf", c.dim(`\n${prompt.slice(0, 1500)}…`));
  }

  // Post-Phase-2 safety net: prune stale engine-mirror folders the AI
  // engine may have written to. The skill-curator prompt instructs the
  // engine to use `npx ctx7 skills install --universal` (writes to
  // `.agents/skills/`) as a SCRATCH location, then `vf skills import` +
  // `vf skills sync --engine copilot` to canonicalize. This cleanup
  // removes the scratch directory and any other engine mirrors the AI
  // may have created via raw shell commands. Idempotent: if no stale
  // folders exist, returns an empty list and the log line is silent.
  // Skip in dry-run since Phase 2 didn't actually execute.
  if (!dry) {
    const postPruned = pruneUnselectedEngineFolders(cwd(), initEngine);
    if (postPruned.length > 0) {
      out("vf", c.dim(`pruned ${postPruned.length} engine folder(s): ${postPruned.join(", ")}`));
    }
  }

  return 0;
}
