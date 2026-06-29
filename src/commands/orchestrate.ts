// src/commands/orchestrate.ts
//
// `vf orchestrate` subcommand — the multi-unit dispatch loop (issue #80, phase 6/14).
// The 6 pure resolver helpers live in src/commands/orchestrate/resolve.ts (#186 PR7).
//
// Contents:
// - orchestrate: plans concurrency, builds the spawner, runs orchestrateUnits,
//   merges results back into the workflow ledger, and reports the goal verdict.

import { resolve } from "node:path";
// Protection cluster lives in src/commands/protection.ts and is
// re-exported through the sibling barrel (_shared.js). Both this
// file and protection.ts import from _shared.js (sibling-via-barrel),
// so there is no direct cross-import cycle. This is the same
// barrel re-export pattern used by seams.ts, doctor.ts, and
// dispatch.ts.
import {
  MS_PER_SECOND,
  defaultRun,
  makeDispatcher,
  makeReviewer,
  makeSharedTypecheckGate,
  planProtection,
  repoGit,
  resolveProtection,
} from "./_shared.js";
import type { ProtectionRuntime, ScopedGateFn, WorktreeOps } from "./_shared.js";
import type {
  AsyncSpawner,
  GitRunner,
  ProjectContext,
  PublishRunner,
  WorkUnit,
} from "./_shared.js";
import {
  CTX_DIR,
  DEFAULT_CONCURRENCY,
  Spinner,
  appendJournal,
  autoCrystallizeRun,
  c,
  cwd,
  defaultContext,
  defaultWorktreePath,
  findScopeConflicts,
  goalEval,
  installLogbus,
  join,
  makeAsyncSpawner,
  maybePublishPrs,
  normalizeUnit,
  orchestrateUnits,
  out,
  publishSpawn,
  readFileSync,
  readSettings,
  readState,
  recomputeTotals,
  thresholdFor,
  tipState,
  writeState,
} from "./_shared.js";
import type { PreflightFn } from "./_shared.js";

// ponytail: inlined from ui-focus.ts (#390)
import { spawnSync as _spawnSync } from "node:child_process";
export function focusTerminal(
  inject: {
    platform?: string;
    run?: (cmd: string, args: string[]) => void;
    termProgram?: string;
  } = {},
): void {
  if ((inject.platform ?? process.platform) !== "darwin") return;
  const run =
    inject.run ??
    ((c, a) => {
      _spawnSync(c, a, { stdio: "ignore" });
    });
  const app =
    (inject.termProgram ?? process.env.TERM_PROGRAM) === "iTerm.app" ? "iTerm" : "Terminal";
  run("osascript", ["-e", `tell application "${app}" to activate`]);
}
export function maybeFocus(
  flags: { focus?: boolean; isTTY?: boolean },
  inject?: Parameters<typeof focusTerminal>[0],
): void {
  if (flags.focus !== true || flags.isTTY !== true) return;
  focusTerminal(inject);
}

// Resolver helpers extracted into orchestrate/resolve.ts (#186 PR7).
import { makePhaseTracker } from "../orchestrator/phase-tracker.js";
// The facade imports them for internal use AND re-exports the 5 public
// test seams (resolveRisk is internal to this file, called by orchestrate()).
import {
  announceLaunch,
  engineReady,
  readyStub,
  resolveEngine,
  resolveMode,
  resolveRisk,
} from "./orchestrate/resolve.js";

// Re-export the test seams so the 2 existing importers are unchanged.
export {
  announceLaunch,
  engineReady,
  readyStub,
  resolveEngine,
  resolveMode,
} from "./orchestrate/resolve.js";
export async function orchestrate(
  flags: Record<string, string | boolean>,
  base: string = cwd(),
  inject: {
    spawner?: AsyncSpawner;
    preflight?: PreflightFn;
    git?: GitRunner;
    wt?: WorktreeOps;
    publishGit?: PublishRunner;
    publishGh?: PublishRunner;
    gate?: ScopedGateFn;
  } = {},
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
  // PR3: raise the terminal so a screen recording captures the live phase timeline.
  maybeFocus({ focus: flags.focus === true, isTTY: process.stdout.isTTY });

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

  // W1: per-unit worktree isolation. STRICTLY opt-in via `--isolate` (cli mode
  // only). Each isolated unit dispatches in its own git worktree so concurrent
  // engines never share one working tree. Default OFF — isolation has a real
  // git-worktree cost and changes the on-disk layout, so it is never auto-on
  // (that would silently alter the default single-tree dispatch behavior).
  // NOTE: the isolate `base` is a git COMMIT-ISH (passed to `git worktree add
  // -b <branch> <path> <base>`), NOT a directory. Use HEAD so each unit's
  // worktree forks from the current commit; `base` (the run dir) is a path and
  // would make `git worktree add` fail with "invalid reference".
  const isolate =
    flags.isolate === true && mode === "cli" ? { base: "HEAD", wt: inject.wt } : undefined;
  if (isolate) {
    out("vf", c.dim("  worktree isolation ON — each unit dispatches in its own git worktree"));
  }

  // #275-C: the whole-project typecheck is identical for every unit on the same
  // codebase, so run it at most ONCE per orchestrate run and share the verdict.
  const gateFn = flags["no-unit-gate"]
    ? undefined
    : (inject.gate ?? makeSharedTypecheckGate(defaultRun));
  // Live per-unit progress so a headless `--yes` run is not a silent black box.
  // start → update the spinner text; done → a persistent one-line ✓/• tick (via
  // out("vf"), which always tees to the terminal even when the engine buffers
  // its own output). The done counter is monotonic; with concurrency > 1 it is
  // the honest progress signal (ev.index is list position, not start order).
  const tracker = makePhaseTracker(units.length);
  const onProgress = (ev: import("../orchestrator/run.js").ProgressEvent) => {
    tracker.onProgress(ev);
    if (ev.phase === "start") {
      spinner.text(`[${tracker.snapshot().done}/${ev.total}] dispatching ${ev.unit} → ${engine}…`);
    } else {
      out("vf", tracker.render());
    }
  };
  const { units: ran, reviews } = await orchestrateUnits({
    units,
    concurrency,
    onProgress,
    dispatcher: makeDispatcher(engine, ctx, base, mode, riskClass, spawner, prot, isolate, gateFn),
    reviewer: makeReviewer(mode, thresholdFor(riskClass), { cwd: base }),
    // Post-coding security checkpoint. Opt-in via `--security-check`. When
    // on, the user is prompted (y/n/skip) after each unit finishes coding,
    // BEFORE the independent reviewer is consulted. A `fail` verdict blocks
    // the unit on `gates.security = "fail"`. Default-skip in non-TTY (CI).
    security: flags["security-check"] ? { base } : undefined,
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

  // W3: optional per-unit PR (opt-in `--pr`, cli + isolate only; never merges).
  maybePublishPrs({
    prRequested: flags.pr === true && mode === "cli",
    isolated: Boolean(isolate),
    units: ran.map((u) => ({
      name: u.name,
      scope: u.scope,
      reviewPassed: reviews.some((r) => r.unit === u.name && r.pass),
    })),
    base,
    worktreePath: (n) => defaultWorktreePath(`vf-unit-${n}`, resolve(base, "..")),
    git: inject.publishGit ?? ((a, d) => publishSpawn("git", a, d)),
    gh: inject.publishGh ?? ((a, d) => publishSpawn("gh", a, d)),
    report: (l) => out("vf", l.startsWith("  ✓") ? c.green(l) : c.yellow(l)),
  });
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
    // Auto-crystallize: turn this run's repeated patterns into a DRAFT skill
    // (never installed — review-then-`git add`). The deterministic backstop of
    // the learning loop — fires regardless of which engine ran. issue #335.
    const runId = `orchestrate-${engine}-${new Date().toISOString().slice(0, 10)}`;
    const cz = autoCrystallizeRun(base, runId);
    if (cz.drafted) {
      out(
        "vf",
        c.green(
          `+ drafted skill ${c.bold(cz.draftName ?? "")} from ${cz.patternCount} recurring pattern(s) → ${cz.draftPath}`,
        ),
      );
      out("vf", c.dim("  DRAFT only — NOT installed. Review, then `git add` if useful."));
    }
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
