// src/server/routes-verify.ts — `POST /api/verify`, lifted out of src/server/routes.ts
// so that file stays under the 400-line cap while gaining the System One routes.
//
// Async on purpose: the server keeps serving state/SSE while the gates run.
import { collectVerifyReportAsync, defaultGoalEvalFn } from "../commands/tools-detect.js";
import { readState } from "../core.js";

export async function handleVerifyRoute(repo: string, url: URL): Promise<Response> {
  const goalEval = url.searchParams.get("goal-eval") === "1";
  const currentState = readState(repo);
  const report = await collectVerifyReportAsync(repo, {
    coverage: true,
    ...(goalEval && currentState?.goal
      ? { goal: currentState.goal, goalEvalFn: defaultGoalEvalFn }
      : {}),
  });
  const gates = report.toolchain.map((g) => ({ label: g.label, pass: g.pass }));
  return Response.json({ ok: report.ok, gates, policy: report.policy });
}
