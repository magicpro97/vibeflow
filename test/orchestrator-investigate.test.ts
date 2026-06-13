// Branch coverage tests for src/orchestrator/investigate.ts
// Target: 100% branch coverage on the 3 uncovered branches in debate():
//   1. debate("q", [])                              — empty positions early return (L191-193)
//   2. debate with a single position                — runnerUp undefined, ?? 0 path (L197)
//   3. debate with positions that have zero evidence — totalEvidence === 0 ternary (L201)
import { describe, expect, test } from "bun:test";
import type { WorkUnit } from "../src/core.js";
import { debate, investigateUnit } from "../src/orchestrator/investigate.js";

function unit(name: string, conf: number | undefined): Pick<WorkUnit, "name" | "confidence" | "owner_agent"> {
  return { name, confidence: conf as number, owner_agent: undefined };
}

describe("debate — branch coverage", () => {
  test("empty positions returns neutral resolution with zero confidence", () => {
    const d = debate("no opinions?", []);
    expect(d.positions).toEqual([]);
    expect(d.resolution).toBe("no positions offered");
    expect(d.confidence).toBe(0);
    expect(d.rejected).toEqual([]);
  });

  test("single position (no runner-up) still resolves to that claim", () => {
    const d = debate("approach?", [
      { agent: "solo", claim: "use Z", evidence: ["e1"] },
    ]);
    expect(d.resolution).toBe("use Z");
    // Confidence formula: (winner.evidence + margin) / (totalEvidence + 1)
    // margin = 1 - 0 = 1, totalEvidence = 1 → (1 + 1) / 2 = 1.00
    expect(d.confidence).toBe(1);
    expect(d.rejected).toEqual([]);
  });

  test("all positions with zero evidence → confidence 0 via the totalEvidence===0 ternary", () => {
    const d = debate("empty evidence?", [
      { agent: "a", claim: "claim A", evidence: [] },
      { agent: "b", claim: "claim B", evidence: [] },
    ]);
    // totalEvidence === 0 branch hit → confidence hard-coded to 0
    expect(d.confidence).toBe(0);
    // Winner is the first sorted (ties broken by stable sort — both have 0 evidence).
    expect(["claim A", "claim B"]).toContain(d.resolution);
    // Runner-up exists, so it shows up in rejected (evidence of 0 vs 0, margin = 0).
    expect(d.rejected.length).toBe(1);
  });
});

describe("investigateUnit — default-option branches", () => {
  test("omits riskClass → uses the ?? \"feature\" default threshold (0.85)", async () => {
    // Threshold 0.85; research immediately returns 1.0 → stops on threshold-met.
    const r = await investigateUnit(unit("u", 0), {
      research: async () => ({ findings: ["f"], confidence: 1 }),
    });
    expect(r.threshold).toBe(0.85);
    expect(r.stoppedBy).toBe("threshold-met");
  });

  test("unit with undefined confidence → ?? 0 seeds the loop from zero", async () => {
    const r = await investigateUnit(unit("u", undefined), {
      riskClass: "docs", // threshold 0.7
      research: async (round) => ({ findings: [`f${round}`], confidence: 0.4 * round }),
    });
    // Started from 0, hit threshold-met at round 2 (0.8 >= 0.7).
    expect(r.finalConfidence).toBeGreaterThanOrEqual(0.7);
    expect(r.rounds[0]?.round).toBe(1);
  });
});
