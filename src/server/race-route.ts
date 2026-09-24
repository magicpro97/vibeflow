// #555: POST /api/race — the UI's entry into `vf race` (head-to-head dispatch,
// ranked by the confidence gate). Same shape as /api/orchestrate: the request
// waits for the real run and answers with the ranked rows. Validation lives here
// so the server's route layer stays thin (size cap) and the seam is injectable.

import { type RaceRunResult, parseEngineList, runRace } from "../commands.js";
import { readState } from "../core.js";
import { DISPATCH_MODE } from "../dispatch/session-contract.js";

/** Route deps + test seam: inject `raceFn` so tests never launch an engine. */
export interface RaceRouteDeps {
  getActiveRepo: () => string;
  raceFn?: typeof runRace;
}

type RaceResponse = RaceRunResult | { error: string; status: number };

/** The request body as a JSON object; `null` for a malformed body or one that is
 *  not a JSON object (`null`, an array, a bare scalar). The caller answers 400 —
 *  `req.json()` throwing out of the fetch handler was the #818 defect. */
export async function readRaceBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Validate state + payload, run the race, and return the ranked rows. */
export async function handleRaceRoute(
  deps: RaceRouteDeps,
  payload: Record<string, unknown>,
): Promise<Response> {
  const state = readState(deps.getActiveRepo());
  const task =
    (typeof payload.task === "string" ? payload.task.trim() : "") || (state?.goal ?? "").trim();
  const parsed = payload.engines === undefined ? undefined : parseEngineList(payload.engines);
  const problem: RaceResponse = !state
    ? { error: "no workflow state — run init first", status: 400 }
    : !task
      ? { error: "race needs a task", status: 400 }
      : parsed && !parsed.ok
        ? { error: parsed.message, status: 400 }
        : await (deps.raceFn ?? runRace)({
            task,
            base: deps.getActiveRepo(),
            mode: payload.dry === false ? DISPATCH_MODE.CLI : DISPATCH_MODE.DRY,
            ...(parsed ? { engines: parsed.engines } : {}),
          });
  if ("error" in problem)
    return Response.json({ error: problem.error }, { status: problem.status });
  return Response.json(
    { ok: problem.exitCode === 0, ranking: problem.ranking, skipped: problem.skipped },
    { headers: { "cache-control": "no-store" } },
  );
}
