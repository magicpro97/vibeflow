import {
  type Engine,
  type RiskLevel,
  type WorkUnit,
  type WorkflowState,
  cwd,
  strArray,
} from "../core.js";
import { computeConfidence } from "../gates.js";
import { type OrchestratorApplyGate, applyGateBlock } from "../hooks/apply-gate.js";
import type { Logbus } from "../logbus.js";
import { thresholdFor } from "./investigate.js";
import { cleanupMarker, createMarker, readMarker, updateMarker } from "./marker.js";
import { type SecurityCheckpointResult, runSecurityCheckpoint } from "./security-checkpoint.js";
import { applyStuckDetection } from "./stuck-wire.js";

/** Default bounded concurrency for parallel dispatch (avoids exhausting quota / the machine). */
export const DEFAULT_CONCURRENCY = 3;

/**
 * Per-unit progress signal emitted by {@link orchestrateUnits} so a CLI front-end
 * can show live progress during an otherwise-silent headless run. `phase:"start"`
 * fires when a unit begins dispatching; `phase:"done"` fires after its review
 * verdict (with `pass`). `index` is the unit's position in the input list (NOT
 * start order — with concurrency > 1 units interleave); `total` is the unit count.
 * Purely observational: a consumer that does nothing changes no behavior.
 */
export interface ProgressEvent {
  phase: "start" | "done";
  unit: string;
  index: number;
  total: number;
  /** Only on `phase:"done"`: whether the unit's review passed. */
  pass?: boolean;
  /** #546: non-abortive stuck signals (stalled/looping/evidence-stuck) surfaced to the consumer. */
  stuck?: string[];
  /** #523: accumulated cost/tokens from completed units. */
  cost_usd?: number;
  tokens?: number;
}

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
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length || 1));
  const lane = async () => {
    while (true) {
      if (signal?.aborted) return;
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
  /**
   * Security checkpoint verdict, populated when `orchestrateUnits` is
   * invoked with a `securityCheckpoint` config. The reviewer reads this
   * field to know whether to block on a `fail` verdict.
   */
  security?: SecurityCheckpointResult;
}

export type UnitDispatcher = (unit: WorkUnit) => Promise<UnitOutcome>;
export type Reviewer = (
  unit: WorkUnit,
  outcome: UnitOutcome,
) =>
  | { pass: boolean; reason: string; score?: number }
  | Promise<{ pass: boolean; reason: string; score?: number }>;

/** Maximum confidence an engine's self-report can contribute.
 *  Must be below the lowest close threshold so a measured gate is always required. */
const SELF_REPORT_CAP = 0.5;

/** A reviewer separate from the implementer (WORK_UNIT_ORCHESTRATION review gate). */
function applyOutcome(
  unit: WorkUnit,
  outcome: UnitOutcome,
  now: () => string = () => new Date().toISOString(),
): WorkUnit {
  // Dedupe evidence: a re-dispatched unit must not accumulate the same path (e.g.
  // `claude.result.json`) twice across runs — keep first-seen order, drop repeats.
  const fresh = outcome.evidence ?? [];
  const evidence = [...new Set([...(unit.evidence ?? []), ...fresh])];
  // #517: stamp each evidence string's capture time, keyed by the string so it
  // survives the Set-dedup. Stamp-once — a re-dispatch never rewrites an existing
  // key, so the recorded time stays that of the FIRST capture (fail-open: units
  // with no evidence get an empty map, which the freshness gate skips).
  // #534: stamp ONLY evidence the current `outcome` produced (`fresh`), NOT the
  // union with pre-existing `unit.evidence`. Legacy evidence (predates the
  // evidence_at field) has an unknown true capture time; stamping it `now()` on
  // re-dispatch would make newest > codeTime and mask staleness.
  const evidence_at = { ...(unit.evidence_at ?? {}) };
  for (const e of fresh) if (!(e in evidence_at)) evidence_at[e] = now();
  return {
    ...unit,
    status: outcome.status,
    // Engine self-grade is an untrusted hint. Confidence can only reach
    // the close threshold when corroborated by a measured gate.
    confidence: Math.min(outcome.confidence, SELF_REPORT_CAP),
    evidence,
    evidence_at,
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
    security: outcome.security !== undefined ? outcome.security : unit.security,
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
 * reviewer over each result. A failed review sets status=blocked, gates.review=fail.
 * Security checkpoint runs between dispatcher and reviewer — fail verdict is a hard gate.
 */
export async function orchestrateUnits<U extends WorkUnit = WorkUnit>(opts: {
  units: U[];
  dispatcher: UnitDispatcher;
  reviewer: Reviewer;
  concurrency?: number;
  /** Per-unit stagger delay (ms) — see {@link runParallel}. Default 0. */
  interUnitDelayMs?: number;
  /** #546: per-unit StuckDetector thresholds. Defaults when omitted. */
  stuckOpts?: import("./stuck-detector.js").StuckDetectorOpts;
  /** #546 per-unit progress callback. start/dispatch, done/review. No-op when omitted. */
  onProgress?: (ev: ProgressEvent) => void;
  /** Engine/agent identifier written into dispatch markers. */
  agent?: string;
  /** #519: optional post-coding security checkpoint between dispatcher and reviewer. */
  security?: {
    base: string;
    askFn?: () => (q: string) => Promise<import("./security-checkpoint.js").SecurityConsent>;
    runSkillFn?: (unit: WorkUnit, base: string) => Promise<string>;
  };
  /** #517: injectable clock for evidence timestamps. Default Date.now. */
  now?: () => string;
  /** #547: optional apply-time guardrail gate. Absent ⇒ no gate. */
  applyGate?: OrchestratorApplyGate;
  /** #547: dispatching engine, passed to applyGate. */
  applyGateEngine?: Engine;
  /** #547: repo root for diff resolution. Defaults to cwd(). */
  cwd?: string;
  /** #547 test seam: inject diff getter. */
  applyGateDiff?: (cwd: string, scope: string[]) => { diff: string; ok: boolean };
  /** #546: active logbus for engine-stdout wire. Absent ⇒ no-op. */
  logbus?: Logbus;
}): Promise<OrchestrationResult<U>> {
  const reviews = new Array<OrchestrationResult["reviews"][number]>(opts.units.length);
  const resumeBindings = new Map(opts.units.map((unit) => [unit.name, readMarker(unit.name)]));
  // Log initial markers for visibility before the first unit dispatches.
  for (const u of opts.units) {
    const previous = resumeBindings.get(u.name);
    createMarker(
      u.name,
      opts.agent,
      previous?.engineSessionId
        ? {
            engineSessionId: previous.engineSessionId,
            engineSessionEngine: previous.engineSessionEngine,
            status: previous.status,
          }
        : undefined,
    );
  }
  const security = opts.security;
  const controller = new AbortController();
  const units = (await runParallel(
    opts.units,
    async (u, i) => {
      const { finish, unsub } = applyStuckDetection(u, opts.stuckOpts, opts.logbus);
      try {
        updateMarker(u.name, { status: "running" });
        opts.onProgress?.({ phase: "start", unit: u.name, index: i, total: opts.units.length });
        // Catch dispatcher throw → per-unit blocked so siblings complete.
        let outcome: UnitOutcome;
        try {
          outcome = await opts.dispatcher(u);
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          try {
            const out = (await import("../logbus.js")).out;
            out("engine-stderr", `[orchestrator] dispatcher for ${u.name} threw: ${msg}`, {
              level: "error",
              unit: u.name,
            });
          } catch {
            // logbus not available — stderr is the fallback
          }
          process.stderr.write(`[orchestrator] dispatcher for ${u.name} threw: ${msg}\n`);
          outcome = {
            status: "blocked" as const,
            confidence: 0,
            evidence: [],
          };
        }
        // Quota-skip: abort remaining lanes.
        if (outcome.evidence?.some((e) => e.startsWith("skipped: upstream rate limit"))) {
          controller.abort();
        }
        // #519: security checkpoint between dispatcher and reviewer. Skip when
        // already doomed (blocked or a cheap gate failed).
        const cheapFailed =
          outcome.status === "blocked" ||
          (["build", "lint", "test"] as const).some((k) => outcome.gates?.[k] === "fail");
        if (security && !cheapFailed) {
          const sec = await runSecurityCheckpoint(u, security.base, {
            askFn: security.askFn,
            runSkillFn: security.runSkillFn,
          });
          outcome.security = sec;
          if (sec.verdict === "fail") {
            outcome.status = "blocked";
            outcome.gates = { ...(outcome.gates ?? {}), security: "fail" };
          } else if (sec.verdict === "pass" || sec.verdict === "needs-review") {
            outcome.gates = { ...(outcome.gates ?? {}), security: "pass" };
          }
        }
        const reviewed = applyOutcome(u, outcome, opts.now);
        const review = await opts.reviewer(reviewed, outcome);
        reviews[i] = { unit: u.name, pass: review.pass, reason: review.reason };
        // #545: persist the calibrated judge score onto the unit so computeConfidence
        // reads it as a graded signal (the producer→unit wire; absent ⇒ untouched).
        if (review.score !== undefined) reviewed.goal_score = review.score;
        const stuck = finish(reviewed.evidence?.length ?? 0);
        opts.onProgress?.({
          phase: "done",
          unit: u.name,
          index: i,
          total: opts.units.length,
          pass: review.pass,
          cost_usd: reviewed.resources?.cost_usd,
          tokens: reviewed.resources?.tokens,
          ...(stuck.length ? { stuck } : {}),
        });
        reviewed.status = review.pass ? "done" : "blocked";
        reviewed.gates = { ...reviewed.gates, review: review.pass ? "pass" : "fail" };
        // #542: record the verdict + gate outcome on the durable stream (append-only),
        // so `vf logs` / SSE / export see the decision at the moment it happened —
        // WORKFLOW_STATE.gates only keeps the LAST state (overwritten each update).
        try {
          const out = (await import("../logbus.js")).out;
          out("vf", `verdict ${u.name}: ${review.pass ? "pass" : "fail"}`, {
            level: "info",
            unit: u.name,
            meta: {
              kind: "verdict",
              review: review.pass ? "pass" : "fail",
              gates: reviewed.gates,
              ...(review.score !== undefined ? { goal_score: review.score } : {}),
              ...(reviewed.resources ? { resources: reviewed.resources } : {}),
            },
          });
        } catch {
          /* logbus unavailable — verdict still lives in WORKFLOW_STATE */
        }
        // #547 apply-time gate: a passed detection-only unit's diff is classified; `!allowed` re-blocks.
        const blocked = await applyGateBlock(opts, reviewed, review.pass);
        if (blocked) reviews[i] = { unit: u.name, pass: false, reason: blocked.reason };
        updateMarker(u.name, {
          status: reviewed.status,
          confidence: reviewed.confidence,
          evidence: reviewed.evidence,
        });
        return reviewed;
      } finally {
        unsub();
      }
    },
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    opts.interUnitDelayMs,
    undefined,
    controller.signal,
  )) as U[];
  // When the abort signal fires (an upstream rate limit), lanes stop pulling
  // not-yet-started items, leaving sparse holes in `units`/`reviews`. Drop the
  // holes so downstream consumers (e.g. reviews.map in orchestrate) never read
  // `undefined.unit`. The skipped units simply don't appear in the result.
  const denseUnits = units.filter((u): u is U => u !== undefined);
  const denseReviews = reviews.filter(
    (r): r is OrchestrationResult["reviews"][number] => r !== undefined,
  );
  return { units: denseUnits, reviews: denseReviews };
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
    // Use computed confidence (gate-derived), NOT the agent's raw self-report,
    // or the self-certification loop stays open here (ADR: computed confidence).
    return computeConfidence(u) < threshold;
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
