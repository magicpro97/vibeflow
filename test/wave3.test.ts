import { describe, expect, test } from "bun:test";
import type { WorkUnit, WorkflowState } from "../src/core.js";
import { debate, investigate, thresholdFor } from "../src/orchestrator/investigate.js";
import { planWorkUnits, scheduleWaves } from "../src/orchestrator/plan.js";
import { goalEval, orchestrateUnits, runParallel } from "../src/orchestrator/run.js";

function unit(name: string, scope: string[]): WorkUnit {
  return {
    name,
    status: "pending",
    confidence: 0,
    scope,
    gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
    resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };
}

describe("investigate", () => {
  test("risk class selects the right confidence threshold", () => {
    expect(thresholdFor("docs")).toBe(0.7);
    expect(thresholdFor("security")).toBe(0.95);
  });

  test("stops when the threshold is met", () => {
    const r = investigate({
      question: "which auth lib?",
      riskClass: "feature",
      research: (round) => ({ findings: [`finding ${round}`], confidence: round * 0.45 }),
    });
    expect(r.met).toBe(true);
    expect(r.stoppedBy).toBe("threshold-met");
  });

  test("bounded: escalates when evidence stops improving", () => {
    const r = investigate({
      question: "ambiguous",
      riskClass: "security",
      research: () => ({ findings: ["same"], confidence: 0.5 }),
    });
    expect(r.met).toBe(false);
    expect(["no-progress", "max-rounds", "no-new-evidence"]).toContain(r.stoppedBy);
    expect(r.recommendation).toContain("escalate");
  });

  test("blocked research with above-threshold stale confidence stops with blocked-by-missing-input (B1+B2)", () => {
    const r = investigate({
      question: "blocked test",
      riskClass: "docs", // threshold 0.7
      startConfidence: 0.9, // above threshold — old code returned "threshold-met"
      research: () => ({ findings: ["stale data"], confidence: 0, blocked: true }),
    });
    // Old code: Math.max(0.9, 0) = 0.9, stopReason(0.9>=0.7) → "threshold-met"
    // Fix: blocked=true → "blocked-by-missing-input" BEFORE threshold check
    expect(r.stoppedBy).toBe("blocked-by-missing-input");
    expect(r.met).toBe(true); // confidence 0.9 >= 0.7 threshold — blocked status doesn't change math
    expect(r.finalConfidence).toBe(0.9); // blocked rounds keep previous confidence
  });
});

describe("debate", () => {
  test("the most-evidenced position wins; others are recorded as rejected", () => {
    const d = debate("approach?", [
      { agent: "a", claim: "use X", evidence: ["e1", "e2"] },
      { agent: "b", claim: "use Y", evidence: ["e3"] },
    ]);
    expect(d.resolution).toBe("use X");
    expect(d.rejected).toContain("b: use Y");
    expect(d.confidence).toBeGreaterThan(0);
  });

  test("single position: runnerUp is undefined → margin uses ?? 0 (line 192)", () => {
    // Only one position → ranked[1] is undefined → runnerUp?.evidence
    // .length ?? 0 fires.
    const d = debate("approach?", [{ agent: "solo", claim: "use X", evidence: ["e1"] }]);
    expect(d.resolution).toBe("use X");
    expect(d.confidence).toBeGreaterThan(0);
  });

  test("ties in evidence length: margin = 0", () => {
    const d = debate("approach?", [
      { agent: "a", claim: "use X", evidence: ["e1"] },
      { agent: "b", claim: "use Y", evidence: ["e2"] },
    ]);
    // Both have evidence length 1 → margin = 0
    expect(d.resolution).toBe("use X"); // first in sort order wins
  });

  test("empty positions: returns 'no positions offered' (line 192)", () => {
    const d = debate("approach?", []);
    expect(d.resolution).toBe("no positions offered");
    expect(d.confidence).toBe(0);
    expect(d.rejected).toEqual([]);
  });
});

describe("planner", () => {
  test("rejects overlapping scopes; accepts disjoint ones", () => {
    const bad = planWorkUnits([
      { name: "a", scope: ["src/auth/"] },
      { name: "b", scope: ["src/auth/login.ts"] },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.conflicts.length).toBe(1);

    const good = planWorkUnits([
      { name: "a", scope: ["src/auth/"] },
      { name: "b", scope: ["src/ui/"] },
    ]);
    expect(good.ok).toBe(true);
    expect(good.units.length).toBe(2);
  });

  test("scheduleWaves orders by dependency", () => {
    const waves = scheduleWaves([
      { name: "a", scope: ["x"] },
      { name: "b", scope: ["y"], depends_on: ["a"] },
      { name: "c", scope: ["z"] },
    ]);
    expect(waves[0]).toEqual(expect.arrayContaining(["a", "c"]));
    expect(waves[1]).toEqual(["b"]);
  });

  test("scheduleWaves: dependency cycle → emits final wave with remaining (line 55-56)", () => {
    // a depends on b, b depends on a → cycle. The cycle-break
    // path emits the remaining units in a final wave to avoid hang.
    const waves = scheduleWaves([
      { name: "a", scope: ["x"], depends_on: ["b"] },
      { name: "b", scope: ["y"], depends_on: ["a"] },
    ]);
    // All units emitted (cycle broken into a final wave)
    expect(waves.length).toBeGreaterThan(0);
    const allUnits = waves.flat();
    expect(allUnits).toEqual(expect.arrayContaining(["a", "b"]));
  });
});

describe("parallel runner + goal-eval", () => {
  test("runParallel preserves order and bounds concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await runParallel(
      [1, 2, 3, 4, 5],
      async (n) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return n * 2;
      },
      2,
    );
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  test("reviewer blocks a done unit lacking confidence/evidence", async () => {
    const { units, reviews } = await orchestrateUnits({
      units: [unit("a", ["src/a/"]), unit("b", ["src/b/"])],
      concurrency: 2,
      dispatcher: async (u) =>
        u.name === "a"
          ? { status: "done", confidence: 1, evidence: ["e.log"] }
          : { status: "done", confidence: 0.5, evidence: [] },
      reviewer: (_u, o) =>
        o.confidence >= 1 && o.evidence.length
          ? { pass: true, reason: "ok" }
          : { pass: false, reason: "low confidence" },
    });
    const a = units.find((u) => u.name === "a");
    const b = units.find((u) => u.name === "b");
    expect(a?.gates.review).toBe("pass");
    expect(b?.status).toBe("blocked");
    expect(reviews.length).toBe(2);
  });

  test("goalEval uses the per-unit risk-class threshold, not 1.0 (issue #90)", () => {
    // Spec band: docs=0.70, simple-code=0.80, feature=0.85, architecture=0.90, security/deploy=0.95
    // Default risk class when a unit doesn't declare one is "feature" (0.85).
    const stateFor = (u: WorkUnit): WorkflowState => ({
      task_id: "T",
      goal: "g",
      success_criteria: [],
      work_units: [u],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    });

    // 1) docs unit at confidence 0.70 (threshold met) → met
    const docsMet: WorkUnit = {
      ...unit("a", ["src/a/"]),
      status: "done",
      confidence: 0.7,
      riskClass: "docs",
      evidence: ["e.log"],
    };
    expect(goalEval(stateFor(docsMet)).verdict).toBe("met");

    // 2) docs unit at confidence 0.69 (below threshold) → partial
    const docsBelow: WorkUnit = { ...docsMet, confidence: 0.69 };
    expect(goalEval(stateFor(docsBelow)).verdict).toBe("partial");

    // 3) security unit at confidence 0.94 → partial (threshold 0.95)
    const secBelow: WorkUnit = {
      ...unit("a", ["src/a/"]),
      status: "done",
      confidence: 0.94,
      riskClass: "security",
      evidence: ["e.log"],
    };
    expect(goalEval(stateFor(secBelow)).verdict).toBe("partial");

    // 4) security unit at confidence 0.95 → met
    const secMet: WorkUnit = { ...secBelow, confidence: 0.95 };
    expect(goalEval(stateFor(secMet)).verdict).toBe("met");

    // 5) default risk class (no riskClass field) is "feature" (threshold 0.85)
    const defaultBelow: WorkUnit = {
      ...unit("a", ["src/a/"]),
      status: "done",
      confidence: 0.84,
      evidence: ["e.log"],
    };
    expect(goalEval(stateFor(defaultBelow)).verdict).toBe("partial");
    const defaultMet: WorkUnit = { ...defaultBelow, confidence: 0.85 };
    expect(goalEval(stateFor(defaultMet)).verdict).toBe("met");

    // 6) blocked unit always blocks regardless of confidence
    const blockedUnit: WorkUnit = { ...docsMet, status: "blocked" };
    expect(goalEval(stateFor(blockedUnit)).verdict).toBe("blocked");

    // 7) reason text cites the actual per-unit threshold, not 1.0
    const v = goalEval(stateFor(secBelow));
    expect(v.reasons.join(" ")).toContain("0.95");
    expect(v.reasons.join(" ")).not.toContain("1.0");
  });
});
