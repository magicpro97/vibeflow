// src/commands/run.ts
//
// The `vf run <engine>` subcommand + its single-unit `launchEngine` helper.
// Mirrors orchestrate()'s contract EXACTLY via the shared protection
// cluster: engineReady probe, planProtection gate (refuse dirty/non-git
// per settings/flags), checkpoint, then runDispatchAsync (the same unified
// dispatch path orchestrate uses) so the engine actually receives the
// prompt. On engine failure we surface the recovery hint and honor
// --rollback-on-fail just like orchestrate.
//
// Split from src/commands.ts as part of issue #80, phase 6.5/14
// (sibling extraction, no API change). The function is still
// re-exported from src/commands.ts so callers (cli.ts → main.ts)
// keep the same import path.
//
// Refs: issue #80 (split src/commands.ts).

import {
  CTX_DIR,
  ENGINES,
  MS_PER_SECOND,
  Spinner,
  c,
  cwd,
  defaultContext,
  dispatchPrompt,
  downgradeBannerText,
  engineCommand,
  engineReady,
  handleUnitFailure,
  installLogbus,
  isUnavailable,
  makeAsyncSpawner,
  out,
  planProtection,
  readSettings,
  readState,
  readyStub,
  repoGit,
  resolveProtection,
  runDispatchAsync,
  writeFileSafe,
} from "./_shared.js";
import { ctxPathIn } from "./_shared.js";
import type { ProtectionRuntime } from "./_shared.js";
import type {
  AsyncSpawner,
  Engine,
  EngineProbe,
  GitRunner,
  PreflightFn,
  ProjectContext,
} from "./_shared.js";

/**
 * The `vf run <engine>` entry point. Validates the engine name, ensures
 * workflow state has a goal, writes the dispatch prompt to `.vibeflow/dispatch/`,
 * and either prints a dry-run hint or hands off to {@link launchEngine} for
 * the real (cli) path.
 *
 * `vf run` is a SINGLE-UNIT workflow: the entire task goes to one engine
 * in one prompt. It does NOT split into work units like `vf orchestrate`.
 */
export async function run(
  engineArg: string | undefined,
  flags: Record<string, string | boolean>,
  inject: {
    preflight?: PreflightFn;
    base?: string;
    git?: GitRunner;
    spawner?: AsyncSpawner;
    // Test seam: probe passed to engineCommand() so unit tests can
    // exercise the unavailable + warning branches (line 1431-1437)
    // without depending on the real PATH (e.g. a missing copilot CLI).
    probe?: EngineProbe;
  } = {},
): Promise<number> {
  // M2: install the logbus for the same reason as orchestrate(). The CLI install point
  // (in main()) deliberately avoids this so commands like `vf --help` keep their
  // stdout-routed `out("vf", …)` rendering.
  installLogbus();
  if (!engineArg || !(ENGINES as string[]).includes(engineArg)) {
    out("vf", c.red(`Usage: vf run <${ENGINES.join("|")}>`), {
      level: "error",
    });
    return 2;
  }
  const engine = engineArg as Engine;
  const base = inject.base ?? cwd();
  // PR28 audit Task 6 (M2): the old `const ctx = defaultContext()` left the goal as
  // a literal placeholder string. The engine then receives a prompt that is just
  // "Describe the task in .vibeflow/TASK_CONTEXT.md before dispatching an engine."
  // Same trap as `applyDispatch`. Refuse to dispatch when no state exists, and
  // overlay state.goal onto the context when it does.
  const state = readState(base);
  if (!state) {
    out(
      "vf",
      c.red("no workflow state — run `vf init` to set the goal and work units before `vf run`."),
      { level: "error" },
    );
    return 1;
  }
  const goal = state.goal?.trim();
  if (!goal) {
    out("vf", c.red("workflow state has no goal — run `vf init` to set one before `vf run`."), {
      level: "error",
    });
    return 1;
  }
  // Runtime guard (issue #92): assert the base has been initialized. The
  // explicit `!state` / `!goal` checks above already cover the obvious cases;
  // the strict defaultContext is a defense-in-depth safety net that surfaces
  // a clear error if any of those checks is ever removed by refactor.
  const baseCtx = defaultContext({ base });
  const ctx: ProjectContext = { ...baseCtx, goal };
  const units = state.work_units.map((u) => u.name);
  const prompt = dispatchPrompt(engine, ctx, units);
  writeFileSafe(ctxPathIn(base, "dispatch", `${engine}.md`), prompt);
  out("vf", `${c.green("+")} ${CTX_DIR}/dispatch/${engine}.md`);

  const invocation = engineCommand(engine, inject.probe ?? {});
  if (isUnavailable(invocation)) {
    out("vf");
    out("vf", c.yellow(`${invocation.unavailable}. Dispatch prompt written; install then re-run.`));
    return 0;
  }
  if (invocation.warning) out("vf", c.yellow(`! ${engine}: ${invocation.warning}`));
  // The dry-run path never launches, so it stays cheap: no git gate, no checkpoint.
  if (!flags.yes) {
    out("vf");
    out("vf", c.dim(`Dry run. Re-run with --yes to launch ${engine}.`));
    return 0;
  }
  // runId derived from the saved task (never Date.now/random) so test-covered paths are stable.
  return launchEngine(engine, prompt, flags, base, inject, state?.task_id ?? engine);
}

/**
 * Real (cli) launch for `vf run`. Mirrors orchestrate()'s contract EXACTLY via the shared
 * helpers — engineReady probe, planProtection gate (refuse dirty/non-git per settings/flags),
 * checkpoint, then BUG 2 fix: deliver the prompt over stdin through runDispatchAsync (the same
 * unified dispatch path orchestrate uses) so the engine actually receives it. On engine failure
 * we surface the recovery hint and honor --rollback-on-fail just like orchestrate.
 */
async function launchEngine(
  engine: Engine,
  prompt: string,
  flags: Record<string, string | boolean>,
  base: string,
  inject: { preflight?: PreflightFn; git?: GitRunner; spawner?: AsyncSpawner },
  runId: string,
): Promise<number> {
  // Stronger gate: confirm a live-ready engine. An injected spawner IS the round-trip, so trust it.
  const preflight = inject.preflight ?? (inject.spawner ? () => [readyStub(engine)] : undefined);
  if (!engineReady(engine, "cli", preflight)) return 1;

  // Source-protection — identical to orchestrate(): refuse a dirty/non-git tree unless opted in.
  const fp = resolveProtection(flags, readSettings(base).failureProtection);
  const git = inject.git ?? repoGit(base);
  const plan = planProtection(base, runId, fp, git);
  if (plan.refused) {
    out("vf");
    out("vf", c.red(`${plan.reason}`), {
      level: "error",
    });
    return 1;
  }
  const prot: ProtectionRuntime = {
    checkpoint: plan.checkpoint,
    fp,
    git,
    quota: { limited: false },
    rolledBack: false,
  };

  const banner = downgradeBannerText(engine);
  if (banner) out("vf", c.yellow(banner));
  const spinner = new Spinner();
  spinner.start(`Launching ${engine}…`);

  const timeoutMs = fp.timeoutSeconds > 0 ? fp.timeoutSeconds * MS_PER_SECOND : undefined;
  // M2: route any engine stderr to the bus. `vf run` is single-unit so we
  // don't have a unit name; the engine name still goes in meta.
  const spawner =
    inject.spawner ??
    makeAsyncSpawner({
      timeoutMs,
      onStderrChunk: (text) => {
        out("engine-stderr", text, {
          level: "warn",
          meta: { engine },
        });
      },
    });
  const result = await runDispatchAsync({ engine, prompt, mode: "cli", spawner });
  spinner.succeed(result.ok ? `${engine} finished` : `${engine} failed`);
  if (!result.ok) {
    handleUnitFailure(prot, base);
    return 1;
  }
  return 0;
}
