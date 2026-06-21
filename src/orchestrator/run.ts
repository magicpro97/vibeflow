import { type WorkUnit, type WorkflowState, strArray } from "../core.js";
import { thresholdFor } from "./investigate.js";
import { cleanupMarker, createMarker, updateMarker } from "./marker.js";

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
 *
 * `interUnitDelayMs` (default 0) inserts a jittered pause BEFORE each
 * item starts. The actual delay is `interUnitDelayMs + jitter*U(0,1)`
 * where `jitter` defaults to `interUnitDelayMs` (so the effective
 * range is `[min, min+min]` with full jitter). This staggers engine
 * calls inside a wave so the upstream never sees a tight burst that
 * triggers a rate-limit. The delay is applied per-item, NOT per-lane,
 * so it does not multiply with `concurrency`. The first item in each
 * wave starts immediately (no leading delay) to keep wave 0 snappy.
 */
export async function runParallel<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = DEFAULT_CONCURRENCY,
  interUnitDelayMs = 0,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length || 1));
  const lane = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      // Per-item stagger: each item gets a fresh jittered delay
      // before it starts. Items already running in other lanes are
      // not affected (the delay is local to this item's start).
      if (interUnitDelayMs > 0 && i > 0) {
        const jittered = interUnitDelayMs + Math.floor(Math.random() * interUnitDelayMs);
        await sleep(jittered);
      }
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
  const evidence = [...new Set([...(unit.evidence ?? []), ...(outcome.evidence ?? [])])];
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

export interface OrchestrationResult<U extends WorkUnit = WorkUnit> {
  // MINOR-5: generic over the unit type so callers (e.g. runAiInitWorkflow
  // with AiInitUnit) don't lose type information preserved by
  // applyOutcome's `...unit` spread. Default to WorkUnit for back-compat.
  units: U[];
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
export async function orchestrateUnits<U extends WorkUnit = WorkUnit>(opts: {
  units: U[];
  dispatcher: UnitDispatcher;
  reviewer: Reviewer;
  concurrency?: number;
  /** Per-unit stagger delay (ms) — see {@link runParallel}. Default 0. */
  interUnitDelayMs?: number;
  /** Engine/agent identifier written into dispatch markers for observability. */
  agent?: string;
}): Promise<OrchestrationResult<U>> {
  const reviews = new Array<OrchestrationResult["reviews"][number]>(opts.units.length);
  // Log initial markers for visibility before the first unit dispatches.
  for (const u of opts.units) createMarker(u.name, opts.agent);
  const units = (await runParallel(
    opts.units,
    async (u, i) => {
      updateMarker(u.name, { status: "running" });
      // Defensive: a custom dispatcher may throw synchronously (e.g. test
      // seam) or the spawner it wraps may reject. We catch and turn the
      // throw into a per-unit "blocked" outcome so siblings still complete
      // and `reviews[]` is fully populated (no Promise.all rejection
      // cascades). This is the contract `UnitDispatcher` promises but
      // does not enforce, so we enforce it here.
      let outcome: UnitOutcome;
      try {
        outcome = await opts.dispatcher(u);
      } catch (err) {
        // The throw's reason is surfaced via stderr in the marker and
        // bubbles up in the dispatcher-throw diagnostic. Don't carry it
        // on the typed UnitOutcome (which has no `reason` field).
        const msg = (err as Error).message ?? String(err);
        process.stderr.write(`[orchestrator] dispatcher for ${u.name} threw: ${msg}\n`);
        outcome = {
          status: "blocked" as const,
          confidence: 0,
          evidence: [],
        };
      }
      const reviewed = applyOutcome(u, outcome);
      const review = opts.reviewer(reviewed, outcome);
      reviews[i] = { unit: u.name, pass: review.pass, reason: review.reason };
      if (!review.pass) {
        reviewed.status = "blocked";
        reviewed.gates = { ...reviewed.gates, review: "fail" };
        updateMarker(u.name, {
          status: "blocked",
          confidence: reviewed.confidence,
          evidence: reviewed.evidence,
        });
      } else {
        reviewed.status = "done";
        reviewed.gates = { ...reviewed.gates, review: "pass" };
        updateMarker(u.name, {
          status: "done",
          confidence: reviewed.confidence,
          evidence: reviewed.evidence,
        });
      }
      return reviewed;
    },
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    opts.interUnitDelayMs,
  )) as U[];
  return { units, reviews };
}

export type GoalVerdict = "met" | "partial" | "blocked";

/**
 * Orchestrator-only goal evaluation (never a sub-agent). The goal is met when every unit is
 * `done` with evidence at or above its **per-unit confidence threshold** (issue #90). The
 * threshold comes from the unit's `riskClass` (defaults to `"feature"`, threshold 0.85) and
 * matches the spec band documented in `AGENT_ORCHESTRATION_POLICY.md`:
 *
 *   docs=0.70, simple-code=0.80, feature=0.85, architecture=0.90, security/deploy=0.95
 *
 * We do not require `confidence === 1.0` — perfect certainty is rare and the spec explicitly
 * allows 0.7-0.95. Blocked when any unit is blocked; partial otherwise (return to Plan for
 * the gaps — never silently close).
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
  const incomplete = units.filter((u) => {
    if (u.status !== "done" || !u.evidence?.length) return true;
    const threshold = thresholdFor(u.riskClass ?? "feature");
    return u.confidence < threshold;
  });
  if (incomplete.length) {
    for (const u of incomplete) {
      const threshold = thresholdFor(u.riskClass ?? "feature");
      reasons.push(
        `incomplete: ${u.name} (status=${u.status}, conf=${u.confidence}, threshold=${threshold}, evidence=${u.evidence?.length ?? 0})`,
      );
    }
    return { verdict: "partial", reasons };
  }
  reasons.push(
    `all units done at per-unit confidence threshold (${units.map((u) => thresholdFor(u.riskClass ?? "feature")).join(", ")}) with evidence`,
  );
  return { verdict: "met", reasons };
}
