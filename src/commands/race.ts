// src/commands/race.ts
//
// `vf race "<task>" [--engines <a,b>] [--yes]` (issue #555).
//
// Head-to-head multi-engine dispatch: the SAME task prompt goes to every named
// engine in parallel (`runParallel` + `runDispatchAsync`), each in its own git
// worktree/branch (`worktreeCreate`, A6) so their edits never mix, and the
// results are ranked by the confidence gate every dispatch already emits
// (`EngineSummary.confidence`, ties broken by tests_run then files_changed).
// There is NO auto-merge: the winner's branch is named and left in place for
// the user to review and merge — vf is local-first and the user decides.
//
// Dry by default (like `vf run` / `vf orchestrate`); `--yes` launches engines.
// Unknown `--engines` names are a usage error; installed-but-missing engines are
// skipped with a notice and the survivors still rank.
//
// Exit codes: 0 = a race was ranked · 1 = no engine finished / none available ·
//             2 = usage error.

import { resolve } from "node:path";
import { ENGINES, type Engine } from "../core/agent-contract.js";
import { DISPATCH_MODE, type DispatchMode } from "../dispatch/session-contract.js";
import { type RaceEntry, rankRace } from "../orchestrator/race.js";
import {
  buildEnginePrompt,
  c,
  checkEngine,
  cwd,
  defaultContext,
  defaultWorktreePath,
  makeAsyncSpawner,
  out,
  readSettings,
  readState,
  runDispatchAsync,
  runParallel,
  worktreeCreate,
} from "./_shared.js";
import type { AsyncSpawner, WorktreeInject } from "./_shared.js";

/** An engine dropped before dispatch (not installed / not ready). */
export interface RaceSkip {
  engine: Engine;
  reason: string;
}

export interface RaceRunResult {
  exitCode: number;
  /** Ranked rows; empty in dry mode and when no engine was available. */
  ranking: RaceEntry[];
  skipped: RaceSkip[];
}

/** Test seams. Production callers pass none of them. */
export interface RaceInject {
  base?: string;
  /** PATH-presence probe forwarded to `checkEngine` so tests never touch the real PATH. */
  has?: (cmd: string) => boolean;
  /** `worktreeCreate` seam (runCommandSync stub + repoDir). */
  worktree?: WorktreeInject;
  /** Spawner factory seam: `(engine, worktreePath) => spawner`; proves per-engine isolation. */
  makeSpawner?: (engine: Engine, wtPath: string) => AsyncSpawner;
  concurrency?: number;
}

export interface RaceOptions extends RaceInject {
  task: string;
  /** Validated engines; omitted or empty ⇒ every installed engine. */
  engines?: readonly Engine[];
  mode: DispatchMode;
}

/** The branch an engine races on. */
export function raceBranch(engine: Engine): string {
  return `vf-race-${engine}`;
}

/** Where an engine's worktree lives — a sibling of the repo, like the A6 default. */
export function raceWorktreePath(engine: Engine, base: string): string {
  return defaultWorktreePath(raceBranch(engine), resolve(base, ".."));
}

/** Parse `--engines a,b` (CLI string) or a JSON string array (UI payload).
 *  Unknown names fail loudly; the result is deduped in canonical ENGINES order. */
export function parseEngineList(
  raw: unknown,
): { ok: true; engines: Engine[] } | { ok: false; message: string } {
  const names =
    typeof raw === "string"
      ? raw.split(",").map((s) => s.trim())
      : Array.isArray(raw)
        ? raw.filter((value): value is string => typeof value === "string").map((s) => s.trim())
        : [];
  const chosen = names.filter(Boolean);
  const unknown = [...new Set(chosen.filter((n) => !(ENGINES as readonly string[]).includes(n)))];
  if (chosen.length === 0 || unknown.length > 0) {
    return {
      ok: false,
      message: `--engines needs a comma-separated list from ${ENGINES.join(" | ")}${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}`,
    };
  }
  return { ok: true, engines: ENGINES.filter((e) => chosen.includes(e)) };
}

/** The engines installed on this host, canonical order — the `--engines` default. */
export function installedEngines(has?: (cmd: string) => boolean): Engine[] {
  return ENGINES.filter((engine) => readinessOf(engine, has) === "ready");
}

/** Installed-or-not without a live round-trip: `checkEngine`'s probe-skipped arm. */
function readinessOf(engine: Engine, has?: (cmd: string) => boolean): string {
  return checkEngine(engine, { probe: false, skipCache: true, ...(has ? { has } : {}) }).level;
}

/** Announce each requested-but-unavailable engine and return the surviving lineup. */
function splitAvailable(
  requested: readonly Engine[],
  has?: (cmd: string) => boolean,
): { ready: Engine[]; skipped: RaceSkip[] } {
  const ready: Engine[] = [];
  const skipped: RaceSkip[] = [];
  for (const engine of requested) {
    const readiness = checkEngine(engine, {
      probe: false,
      skipCache: true,
      ...(has ? { has } : {}),
    });
    if (readiness.level === "ready") {
      ready.push(engine);
      continue;
    }
    skipped.push({ engine, reason: readiness.detail });
    out("vf", c.yellow(`  ${engine} skipped: ${readiness.detail}`));
  }
  return { ready, skipped };
}

/** Print what a dry run would do — no worktree, no dispatch, no spend. */
function printRacePlan(engines: readonly Engine[], base: string): void {
  out("vf", c.bold(`vf race — ${engines.length} engine(s) on the same task, one worktree each:`));
  for (const engine of engines) {
    out(
      "vf",
      `  ${engine} → branch ${raceBranch(engine)}  worktree ${raceWorktreePath(engine, base)}`,
    );
  }
}

/** Print the ranked table, then name the winner's branch and where to review it. */
function printRaceResults(ranking: readonly RaceEntry[]): void {
  out("vf", c.bold("Ranked by confidence (tests_run, then files_changed):"));
  ranking.forEach((row, i) => {
    out(
      "vf",
      `  ${i + 1}. ${row.engine}  confidence ${row.confidence}  tests ${row.tests_run}  files ${row.files_changed}  branch ${row.branch}`,
    );
    if (!row.ok) out("vf", c.dim(`     failed: ${row.reason ?? "dispatch failed"}`));
  });
  const winner = ranking.find((row) => row.ok);
  if (!winner) {
    out("vf", c.red("No engine completed — nothing to merge."));
    return;
  }
  out(
    "vf",
    c.green(
      `Winner: ${winner.engine} — branch ${winner.branch} (no auto-merge; review, then merge it yourself)`,
    ),
  );
  out("vf", `  cd ${winner.worktree}`);
}

/** The default per-engine spawner: that engine's CLI rooted in its own worktree.
 *  `spawn` is a test seam forwarded to `makeAsyncSpawner` (a fake `Bun.spawn`). */
export function raceSpawner(
  base: string,
  spawn?: typeof Bun.spawn,
): (engine: Engine, wtPath: string) => AsyncSpawner {
  const envPolicy = readSettings(base).envPolicy;
  return (_engine: Engine, wtPath: string): AsyncSpawner =>
    makeAsyncSpawner({
      cwd: wtPath,
      envPolicy,
      ...(spawn ? { spawn } : {}),
      // Engine stderr is routed to the logbus channel (never the raw TTY — M2).
      onStderrChunk: (text) => out("engine-stderr", text, { level: "warn" }),
    });
}

/**
 * Run a race and return its ranking. `engines` defaults to the installed engines;
 * unavailable engines are skipped with a notice and the survivors still rank.
 */
export async function runRace(opts: RaceOptions): Promise<RaceRunResult> {
  const base = opts.base ?? cwd();
  // The dispatch prompt is context-driven (context files, policies, settings), so a
  // race needs an initialized repo — same precondition as `vf run` / `vf orchestrate`.
  if (!readState(base)) {
    out("vf", c.red(`vf race: no workflow state at ${base} — run \`vf init\` first.`), {
      level: "error",
    });
    return { exitCode: 1, ranking: [], skipped: [] };
  }
  const requested =
    opts.engines && opts.engines.length > 0 ? [...opts.engines] : installedEngines(opts.has);
  const { ready, skipped } = splitAvailable(requested, opts.has);
  if (ready.length === 0) {
    out("vf", c.red("vf race: no engine available — nothing to race."), { level: "error" });
    return { exitCode: 1, ranking: [], skipped };
  }
  if (opts.mode === DISPATCH_MODE.DRY) {
    printRacePlan(ready, base);
    return { exitCode: 0, ranking: [], skipped };
  }

  const ctx = { ...defaultContext({ base }), goal: opts.task };
  // Each lane spawns its engine rooted in that engine's own worktree — the isolation seam.
  const makeSpawner = opts.makeSpawner ?? raceSpawner(base);

  const entries = await runParallel<Engine, RaceEntry>(
    ready,
    async (engine) => {
      const branch = raceBranch(engine);
      const worktree = raceWorktreePath(engine, base);
      // One engine faulting (worktree or runtime) must not sink the race — record it
      // and let the survivors rank.
      const failed = (reason: string): RaceEntry => ({
        engine,
        ok: false,
        confidence: 0,
        tests_run: 0,
        files_changed: 0,
        branch,
        worktree,
        reason,
      });
      try {
        const created = worktreeCreate(
          [branch],
          { path: worktree },
          {
            ...opts.worktree,
            repoDir: base,
          },
        );
        if (created !== 0) return failed(`worktree create failed (exit ${created})`);
        // Same task prompt per engine (engine-labelled header only) — the whole point.
        const prompt = buildEnginePrompt(engine, ctx, []);
        const result = await runDispatchAsync({
          engine,
          prompt,
          mode: opts.mode,
          spawner: makeSpawner(engine, worktree),
          unit: `race-${engine}`,
          base,
        });
        const summary = result.summary;
        return {
          engine,
          ok: result.ok,
          confidence: summary?.confidence ?? 0,
          tests_run: summary?.tests_run?.length ?? 0,
          files_changed: summary?.files_changed?.length ?? 0,
          branch,
          worktree,
          ...(result.ok ? {} : { reason: result.reason ?? `${engine} dispatch failed` }),
        };
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
    },
    opts.concurrency ?? ready.length,
  );

  const ranking = rankRace(entries);
  printRaceResults(ranking);
  return { exitCode: ranking.some((row) => row.ok) ? 0 : 1, ranking, skipped };
}

/** `vf race "<task>" [--engines <a,b>] [--yes]` — the CLI entry point. */
export async function race(
  positionals: string[],
  flags: Record<string, string | boolean>,
  inject: RaceInject = {},
): Promise<number> {
  const task = positionals.join(" ").trim();
  if (!task) {
    out("vf", c.red('Usage: vf race "<task>" [--engines claude,codex] [--yes]'), {
      level: "error",
    });
    return 2;
  }
  const parsed = flags.engines === undefined ? undefined : parseEngineList(flags.engines);
  if (parsed && !parsed.ok) {
    out("vf", c.red(`vf race: ${parsed.message}`), { level: "error" });
    return 2;
  }
  const result = await runRace({
    ...inject,
    task,
    mode: flags.yes === true ? DISPATCH_MODE.CLI : DISPATCH_MODE.DRY,
    ...(parsed ? { engines: parsed.engines } : {}),
  });
  if (result.exitCode === 0 && flags.yes !== true) {
    out("vf", c.dim("Dry run — re-run with --yes to launch the engines."));
  }
  return result.exitCode;
}
