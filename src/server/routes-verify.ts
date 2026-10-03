// src/server/routes-verify.ts — `POST /api/verify`, lifted out of src/server/routes.ts
// so that file stays under the 400-line cap while gaining the System One routes.
//
// Async on purpose: the server keeps serving state/SSE while the gates run.
import { collectVerifyReportAsync, defaultGoalEvalFn } from "../commands/tools-detect.js";
import { readState } from "../core.js";
import { readSettings } from "../settings.js";
import { TYPESAFE_BUDGET_BUCKET, resetCallBudget } from "../typesafe-health.js";
import { DEFAULT_TYPESAFE_SETTINGS, type TypesafeSettings } from "../typesafe-settings.js";

/**
 * The goal-coverage seam for `?goal-eval=1`.
 *
 * Task 4: `defaultGoalEvalFn` reads the judge config out of its SECOND argument, so without this
 * inject the `callSites.goalCoverage` toggle silently does nothing. Mirror
 * `src/commands/dispatch-reviewer.ts:134` — forward the repo's block and let the callee re-check
 * `enabled` and the call-site flag before it resolves anything.
 *
 * Extracted and exported so a test can assert the wiring without running the whole gate chain,
 * which spawns typecheck and lint.
 *
 * This is also the request's RUN BOUNDARY for the call budget: the counter is per process
 * (`src/typesafe-health.ts`), and `vf serve` is not a run - without a reset, after `maxCalls`
 * judged requests EVER the seam fell through for the server's whole lifetime. It restarts the
 * GOAL_COVERAGE bucket, NOT the enforcement one: the two seams share the enforcement counter, so
 * zeroing that here would refund budget this request never spent - a mounted route could re-arm
 * calls a drained run must refuse (see `resetCallBudget`'s note).
 */
export function goalEvalOptions(
  goal: string | undefined,
  typesafe: TypesafeSettings | undefined,
): {
  goal: string;
  goalEvalFn: typeof defaultGoalEvalFn;
  goalEvalInject: { typesafe: { settings: TypesafeSettings; env: NodeJS.ProcessEnv } };
} | null {
  if (!goal) return null;
  resetCallBudget(TYPESAFE_BUDGET_BUCKET.GOAL_COVERAGE);
  return {
    goal,
    goalEvalFn: defaultGoalEvalFn,
    goalEvalInject: {
      typesafe: { settings: typesafe ?? DEFAULT_TYPESAFE_SETTINGS, env: process.env },
    },
  };
}

export async function handleVerifyRoute(repo: string, url: URL): Promise<Response> {
  const goalEval = url.searchParams.get("goal-eval") === "1";
  const currentState = readState(repo);
  const settings = readSettings(repo);
  const options = goalEval ? goalEvalOptions(currentState?.goal, settings.typesafe) : null;
  const report = await collectVerifyReportAsync(repo, { coverage: true, ...(options ?? {}) });
  const gates = report.toolchain.map((g) => ({ label: g.label, pass: g.pass }));
  return Response.json({ ok: report.ok, gates, policy: report.policy });
}
