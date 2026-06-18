// src/commands/orchestrate.ts
//
// `vf orchestrate` subcommand + the flag-resolver / readiness
// helpers it owns. Issue #80, phase 6/14 (paired with units.ts).
//
// Contents:
// - resolveMode: --yes → "cli", --dry → "dry", else bridge or dry
//   based on VIBEFLOW_AI env. Test seam.
// - resolveEngine: --engine flag if valid, else DEFAULT_ENGINE.
//   Test seam. The DEFAULT_ENGINE constant lives in init.ts and is
//   re-exported by the facade.
// - resolveRisk: --risk flag if valid, else "feature". Internal
//   helper; only used by orchestrate.
// - announceLaunch: pre-launch engine warning / availability
//   check. Returns skip:true when the engine CLI is unavailable.
//   Test seam (exported) because tests need to exercise the
//   unavailable + warning branches without launching a real engine.
// - readyStub: synthetic "ready" readiness used when a caller
//   injects its own dispatch spawner.
// - engineReady: the stronger pre-dispatch gate. A live preflight
//   probe of the single chosen engine.
// - orchestrate: the multi-unit dispatch loop. Plans concurrency,
//   builds the spawner, runs orchestrateUnits, merges results back
//   into the workflow ledger, and reports the goal verdict.

// Protection cluster lives in src/commands/protection.ts and is
// re-exported through the sibling barrel (_shared.js). The facade
// round-trip we tried earlier in this phase tripped a
// verbatimModuleSyntax cycle (TS2449 / TS2724) — the
// sibling-to-sibling re-export dodges that cycle and is the same
// pattern seams.ts / doctor.ts / dispatch.ts use.
import {
  MS_PER_SECOND,
  makeDispatcher,
  makeReviewer,
  planProtection,
  repoGit,
  resolveProtection,
} from "./_shared.js";
import type { ProtectionRuntime } from "./_shared.js";
import type {
  AsyncSpawner,
  Engine,
  EngineReadiness,
  GitRunner,
  ProjectContext,
  RiskClass,
  WorkUnit,
} from "./_shared.js";
import {
  CTX_DIR,
  DEFAULT_CONCURRENCY,
  DEFAULT_ENGINE,
  ENGINES,
  Spinner,
  appendJournal,
  c,
  cwd,
  defaultContext,
  downgradeBannerText,
  engineCommand,
  findScopeConflicts,
  goalEval,
  installLogbus,
  isUnavailable,
  join,
  makeAsyncSpawner,
  normalizeUnit,
  orchestrateUnits,
  out,
  preflightAll,
  readFileSync,
  readSettings,
  readState,
  recomputeTotals,
  thresholdFor,
  tipState,
  writeState,
} from "./_shared.js";
import type { PreflightFn } from "./_shared.js";

export function resolveMode(flags: Record<string, string | boolean>): "cli" | "bridge" | "dry" {
  if (flags.yes) return "cli";
  if (flags.dry) return "dry";
  return process.env.VIBEFLOW_AI ? "bridge" : "dry";
}

export function resolveEngine(flags: Record<string, string | boolean>): Engine {
  return typeof flags.engine === "string" && (ENGINES as string[]).includes(flags.engine)
    ? (flags.engine as Engine)
    : DEFAULT_ENGINE;
}

function resolveRisk(flags: Record<string, string | boolean>): RiskClass {
  const valid: RiskClass[] = [
    "docs",
    "simple-code",
    "feature",
    "architecture",
    "security",
    "deploy",
  ];
  return typeof flags.risk === "string" && (valid as string[]).includes(flags.risk)
    ? (flags.risk as RiskClass)
    : "feature";
}

/**
 * Before launching a non-native engine, warn the user their guardrails are detection-only and
 * resolve the engine command. Returns `skip:true` when the engine CLI is genuinely unavailable
 * (so we never spawn a bogus command). Pure-stdout for "dry"/"bridge" (nothing to launch).
 */
// Test seam: exported so unit tests can exercise the no-skip,
// unavailable, and warning branches without invoking a real engine.
// The 4th param `engineCommandFn` lets tests inject a fake engineCommand
// to deterministically hit the unavailable and warning branches.
export function announceLaunch(
  engine: Engine,
  mode: "cli" | "bridge" | "dry",
  engineCommandFn: (e: Engine) => ReturnType<typeof engineCommand> = engineCommand,
): { skip: boolean } {
  if (mode !== "cli") return { skip: false };
  const banner = downgradeBannerText(engine);
  if (banner) out("vf", c.yellow(banner));
  const invocation = engineCommandFn(engine);
  if (isUnavailable(invocation)) {
    out("vf", c.yellow(`\n${engine} unavailable: ${invocation.unavailable}`));
    return { skip: true };
  }
  if (invocation.warning) out("vf", c.yellow(`! ${engine}: ${invocation.warning}`));
  return { skip: false };
}

/** A synthetic "ready" readiness used when a caller injects its own dispatch spawner. */
// Exported (not just internal) so the `run` subcommand
// (src/commands/run.ts, phase 6.5/14) can call it via the barrel
// (_shared.js) to mark an injected-spawner run as ready. Without
// this export, the run path would have to call `engineReady` with
// a hand-rolled stub; the export preserves the original wiring 1:1.
export function readyStub(engine: Engine): EngineReadiness {
  return { engine, level: "ready", detail: "ready (injected)", checkedAt: "" };
}

/**
 * The stronger pre-dispatch gate: a live preflight probe of the single chosen engine. Returns
 * true only when the engine is fully ready; otherwise prints the actionable detail and returns
 * false so the caller can refuse to dispatch. Dry/bridge modes skip the probe (nothing launches).
 * Injectable via `preflight` so tests never spawn a real engine.
 */
// Exported (not just internal) so the `run` subcommand
// (src/commands/run.ts, phase 6.5/14) can call it via the barrel.
// Without the export, the run path would re-implement the same gate.
export function engineReady(
  engine: Engine,
  mode: "cli" | "bridge" | "dry",
  preflight?: PreflightFn,
): boolean {
  if (mode !== "cli") return true;
  const probe = preflight ?? ((e: Engine[]) => preflightAll(e, { probe: true }));
  const [readiness] = probe([engine]);
  if (readiness?.level === "ready") return true;
  const detail = readiness?.detail ?? "engine not ready";
  out("vf", c.red(`\n${engine} not ready: ${detail}`));
  return false;
}

export async function orchestrate(
  flags: Record<string, string | boolean>,
  base: string = cwd(),
  inject: { spawner?: AsyncSpawner; preflight?: PreflightFn; git?: GitRunner } = {},
): Promise<number> {
  // M2: install the logbus before any `out("engine-stderr", …)` can fire. The bus is the
  // SOLE destination for engine stderr bytes (stdio is now piped in dispatch.ts), so an
  // uninstalled bus at this point would silently drop them. installLogbus is idempotent —
  // a second call replaces the active bus with a fresh one (the previous one is closed).
  installLogbus();

  // M5: show the "watch live" tip once, if the UI server is running.
  if (!tipState.shown) {
    tipState.shown = true;
    try {
      const portFile = join(cwd(), CTX_DIR, ".ui-port");
      const data = readFileSync(portFile, "utf8");
      const { port } = JSON.parse(data) as { port: number };
      if (typeof port === "number" && Number.isFinite(port)) {
        out("vf", c.dim(`Tip: watch live at http://127.0.0.1:${port}`));
      }
    } catch {
      /* UI server not running — that's ok */
    }
  }

  const state = readState(base);
  if (!state) {
    out("vf", c.yellow("No workflow. Run `vf init` first."), {
      level: "error",
    });
    return 1;
  }
  const engine = resolveEngine(flags);
  const mode = resolveMode(flags);
  const riskClass = resolveRisk(flags);
  // Carry tool settings into the dispatch context so the prompt can tell the engine which
  // code-navigation tools (codegraph > lsp > native) are configured — otherwise dispatches run
  // tool-blind even when .mcp.json wired the servers.
  const ctx: ProjectContext = {
    // Runtime guard (issue #92): pass `base` so defaultContext throws a clear
    // "run vf init" message instead of silently seeding a placeholder goal.
    ...defaultContext({ base }),
    goal: state.goal,
    settings: readSettings(base),
  };

  // Run the whole task as one unit when none were planned (minimal-footprint principle).
  const allUnits: WorkUnit[] =
    state.work_units.length > 0
      ? state.work_units
      : [normalizeUnit({ name: "task", status: "pending", confidence: 0 })];

  // Only dispatch units that aren't already complete — a unit that is done at confidence 1.0
  // WITH evidence is finished; re-launching the engine against it wastes a round-trip and risks
  // clobbering accepted work. Completed units are still carried into the ledger + goal eval.
  const isComplete = (u: WorkUnit) =>
    u.status === "done" && u.confidence >= 1 && (u.evidence?.length ?? 0) > 0;
  const done = allUnits.filter(isComplete);
  const units: WorkUnit[] = allUnits.filter((u) => !isComplete(u));
  if (done.length) {
    out(
      "vf",
      c.dim(
        `Skipping ${done.length} already-complete unit(s): ${done.map((u) => u.name).join(", ")}`,
      ),
    );
  }

  // Nothing left to dispatch — every unit is already complete. Report the goal verdict and exit
  // without launching the engine (a no-op dispatch would only re-review finished work).
  if (units.length === 0) {
    out("vf", c.green("\nAll work units already complete — nothing to dispatch."));
    // issue #90: apply the spec band threshold (per-unit riskClass) to the verdict, not 1.0.
    for (const u of state.work_units) {
      if (!u.riskClass) u.riskClass = riskClass;
    }
    const verdict = goalEval(state);
    const color = verdict.verdict === "met" ? c.green : c.yellow;
    out("vf", color(`goal: ${verdict.verdict}`));
    for (const reason of verdict.reasons) out("vf", c.dim(`  - ${reason}`));
    return verdict.verdict === "met" ? 0 : 1;
  }

  const launch = announceLaunch(engine, mode);
  if (launch.skip) return 1;
  // Stronger gate: a real (cli) dispatch requires a live-ready engine. When the caller injects
  // its own dispatch spawner (tests/headless), that spawner IS the engine round-trip, so we
  // trust it rather than probing the real binary — unless an explicit preflight is supplied.
  const preflight = inject.preflight ?? (inject.spawner ? () => [readyStub(engine)] : undefined);
  if (!engineReady(engine, mode, preflight)) return 1;

  // Source-protection: only on a REAL (cli) dispatch — never dry/bridge (nothing irreversible).
  const settings = readSettings(base);
  const fp = resolveProtection(flags, settings.failureProtection);
  const git = inject.git ?? repoGit(base);
  let prot: ProtectionRuntime | undefined;
  if (mode === "cli") {
    const plan = planProtection(base, state.task_id, fp, git);
    if (plan.refused) {
      out("vf", c.red(`\n${plan.reason}`), {
        level: "error",
      });
      return 1;
    }
    prot = { checkpoint: plan.checkpoint, fp, git, quota: { limited: false }, rolledBack: false };
  }

  // Build the dispatch spawner honoring the configured per-unit timeout (0 disables it). An
  // injected spawner (tests/headless) always wins so suites never launch a real engine.
  // Bridge mode runs $VIBEFLOW_AI (a shell command string, possibly with args) — spawn via
  // shell so it parses, consistent with aiGenerate.
  const timeoutMs = fp.timeoutSeconds > 0 ? fp.timeoutSeconds * MS_PER_SECOND : undefined;
  const spawner =
    inject.spawner ??
    makeAsyncSpawner({
      timeoutMs,
      shell: mode === "bridge",
      // M2: route any stderr noise the engine emits to the bus. Each per-unit
      // dispatcher has its own streamSpawner that adds { unit, engine } meta;
      // the orchestrator-level spawner is the SAFETY NET for engines that bypass
      // the per-unit path (e.g. the bridge mode shell call). Level=warn is the
      // documented default for engine-stderr.
      onStderrChunk: (text) => {
        out("engine-stderr", text, {
          level: "warn",
          meta: { engine },
        });
      },
    });

  // Scope-conflict gate: refuse to dispatch overlapping scopes in parallel — serialize them.
  const conflicts = findScopeConflicts(units);
  const requested =
    typeof flags.concurrency === "string" ? Number(flags.concurrency) : DEFAULT_CONCURRENCY;
  let concurrency = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_CONCURRENCY;
  if (conflicts.length) {
    concurrency = 1;
    out(
      "vf",
      c.yellow(
        `! ${conflicts.length} overlapping scope(s) — serializing dispatch (parallel refused):`,
      ),
    );
    for (const [a, b] of conflicts) out("vf", c.dim(`  - ${a} ⨯ ${b}`));
  }

  const spinner = new Spinner();
  spinner.start(
    `Orchestrating ${units.length} unit(s) → ${engine} (${mode}, concurrency ${concurrency})`,
  );

  const { units: ran, reviews } = await orchestrateUnits({
    units,
    concurrency,
    dispatcher: makeDispatcher(engine, ctx, base, mode, riskClass, spawner, prot),
    reviewer: makeReviewer(mode, thresholdFor(riskClass)),
  });

  spinner.succeed(`Dispatched ${ran.length} unit(s)`);
  // Merge dispatched results back with the skipped (already-complete) units so the ledger and
  // goal eval see the full set — not just the ones we re-ran this pass.
  state.work_units = done.length ? [...done, ...ran] : ran;
  // issue #90: stamp the resolved risk class onto every unit that didn't declare one, so
  // goalEval applies the spec band (0.7-0.95) instead of the legacy hardcoded 1.0.
  for (const u of state.work_units) {
    if (!u.riskClass) u.riskClass = riskClass;
  }
  recomputeTotals(state);
  // Dry is read-only: keep the persisted ledger byte-identical (only the CONTEXT.md prompt
  // previews under workunits/* are written). Real runs (cli/bridge) persist the outcome.
  if (mode !== "dry") writeState(base, state);

  for (const r of reviews) {
    out("vf", `${r.pass ? c.green("✓") : c.yellow("•")} review ${r.unit}: ${r.reason}`);
  }
  const verdict = goalEval(state);
  const color =
    verdict.verdict === "met" ? c.green : verdict.verdict === "blocked" ? c.red : c.yellow;
  out("vf", color(`\ngoal: ${verdict.verdict}`));
  for (const reason of verdict.reasons) out("vf", c.dim(`  - ${reason}`));
  // Append a machine event to the work journal — real runs only (dry is read-only).
  if (mode !== "dry") {
    appendJournal(base, "dispatch", `${engine} → goal ${verdict.verdict}`, [
      `${ran.length} unit(s) dispatched (${mode}, concurrency ${concurrency})`,
      ...ran.map((u) => `- ${u.name}: ${u.status} @ ${u.confidence}`),
      ...reviews.map((r) => `- review ${r.unit}: ${r.pass ? "pass" : "fail"} — ${r.reason}`),
    ]);
  }
  if (mode === "dry") {
    out(
      "vf",
      c.dim(
        `\nDry run: prompts written under ${CTX_DIR}/workunits/*. Re-run with --yes to launch the engine.`,
      ),
    );
  }
  return verdict.verdict === "blocked" ? 1 : 0;
}
