import { type WorkUnit, type WorkflowState, strArray } from "../core.js";

/** Default bounded concurrency for parallel dispatch (avoids exhausting quota / the machine). */
export const DEFAULT_CONCURRENCY = 3;

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once. Results are
 * returned in input order. This is the parallel-dispatch primitive: independent work units
 * (disjoint scopes) run concurrently, bounded so we never exhaust quota or the machine.
 *
 * NOTE: overlap is only real when `worker` is genuinely async (a non-blocking spawn). A
 * synchronous `spawnSync` inside `worker` blocks the event loop and serializes the lanes —
 * the dispatcher passed in must use `runDispatchAsync` for the engine path to overlap.
 */
export async function runParallel<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length || 1));
  const lane = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

/** Outcome an injected dispatcher reports back for a single work unit. */
export interface UnitOutcome {
  status: WorkUnit["status"];
  confidence: number;
  evidence: string[];
  gates?: Partial<WorkUnit["gates"]>;
  resources?: Partial<WorkUnit["resources"]>;
  knowledge_heavy?: boolean;
  knowledge_heavy_source?: WorkUnit["knowledge_heavy_source"];
  skills_injected?: string[];
  skills_required?: string[];
  skills_used?: string[];
}

export type UnitDispatcher = (unit: WorkUnit) => Promise<UnitOutcome>;
export type Reviewer = (unit: WorkUnit, outcome: UnitOutcome) => { pass: boolean; reason: string };

/** A reviewer separate from the implementer (WORK_UNIT_ORCHESTRATION review gate). */
function applyOutcome(unit: WorkUnit, outcome: UnitOutcome): WorkUnit {
  // Dedupe evidence: a re-dispatched unit must not accumulate the same path (e.g.
  // `claude.result.json`) twice across runs — keep first-seen order, drop repeats.
  const evidence = [...new Set([...(unit.evidence ?? []), ...outcome.evidence])];
  return {
    ...unit,
    status: outcome.status,
    confidence: outcome.confidence,
    evidence,
    gates: { ...unit.gates, ...(outcome.gates ?? {}) },
    resources: { ...unit.resources, ...(outcome.resources ?? {}) },
    // Skills-first fields: only override when the outcome carries them, so a dispatcher that
    // doesn't report them never clobbers values already on the unit with undefined.
    knowledge_heavy:
      outcome.knowledge_heavy !== undefined ? outcome.knowledge_heavy : unit.knowledge_heavy,
    knowledge_heavy_source:
      outcome.knowledge_heavy_source !== undefined
        ? outcome.knowledge_heavy_source
        : unit.knowledge_heavy_source,
    skills_injected:
      outcome.skills_injected !== undefined
        ? strArray(outcome.skills_injected)
        : unit.skills_injected,
    skills_required:
      outcome.skills_required !== undefined
        ? strArray(outcome.skills_required)
        : unit.skills_required,
    skills_used:
      outcome.skills_used !== undefined ? strArray(outcome.skills_used) : unit.skills_used,
  };
}

export interface OrchestrationResult {
  units: WorkUnit[];
  reviews: Array<{ unit: string; pass: boolean; reason: string }>;
}

/**
 * Dispatch all units in parallel through the injected dispatcher, then run an independent
 * reviewer over each result. Implementer and reviewer are different roles — a unit only
 * reaches `done` when both the dispatcher and the reviewer agree.
 *
 * Contract: a FAILED review blocks the unit regardless of the dispatcher's reported status.
 * Production dispatchers return "verifying" (never "done"), so blocking only on
 * `status === "done"` would let a confidence<1 unit slip through. A failed review always
 * sets `status = "blocked"` and `gates.review = "fail"`; a passed review sets
 * `gates.review = "pass"`. Reviews are written by index for deterministic ordering.
 */
export async function orchestrateUnits(opts: {
  units: WorkUnit[];
  dispatcher: UnitDispatcher;
  reviewer: Reviewer;
  concurrency?: number;
}): Promise<OrchestrationResult> {
  const reviews = new Array<OrchestrationResult["reviews"][number]>(opts.units.length);
  const units = await runParallel(
    opts.units,
    async (u, i) => {
      const outcome = await opts.dispatcher(u);
      const reviewed = applyOutcome(u, outcome);
      const review = opts.reviewer(reviewed, outcome);
      reviews[i] = { unit: u.name, pass: review.pass, reason: review.reason };
      if (!review.pass) {
        reviewed.status = "blocked";
        reviewed.gates = { ...reviewed.gates, review: "fail" };
      } else {
        reviewed.gates = { ...reviewed.gates, review: "pass" };
      }
      return reviewed;
    },
    opts.concurrency ?? DEFAULT_CONCURRENCY,
  );
  return { units, reviews };
}

export type GoalVerdict = "met" | "partial" | "blocked";

/**
 * Orchestrator-only goal evaluation (never a sub-agent). The goal is met when every unit is
 * `done` at confidence 1.0 with recorded evidence; blocked when any unit is blocked; partial
 * otherwise (return to Plan for the gaps — never silently close).
 */
export function goalEval(state: WorkflowState): { verdict: GoalVerdict; reasons: string[] } {
  const units = state.work_units ?? [];
  const reasons: string[] = [];
  if (!units.length) return { verdict: "partial", reasons: ["no work units to evaluate"] };

  const blocked = units.filter((u) => u.status === "blocked");
  if (blocked.length) {
    for (const u of blocked) reasons.push(`blocked: ${u.name}`);
    return { verdict: "blocked", reasons };
  }
  const incomplete = units.filter(
    (u) => u.status !== "done" || u.confidence < 1 || !u.evidence?.length,
  );
  if (incomplete.length) {
    for (const u of incomplete) {
      reasons.push(
        `incomplete: ${u.name} (status=${u.status}, conf=${u.confidence}, evidence=${u.evidence?.length ?? 0})`,
      );
    }
    return { verdict: "partial", reasons };
  }
  reasons.push("all units done at confidence 1.0 with evidence");
  return { verdict: "met", reasons };
}
