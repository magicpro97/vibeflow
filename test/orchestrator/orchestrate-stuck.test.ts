// test/orchestrator/orchestrate-stuck.test.ts
// #546 — integration: orchestrateUnits surfaces stuck signals via onProgress
// without aborting sibling lanes.

import { describe, expect, test } from "bun:test";
import type { WorkUnit } from "../../src/core.js";
import { type ProgressEvent, orchestrateUnits } from "../../src/orchestrator/run.js";

function unit(name: string): WorkUnit {
  return {
    name,
    status: "pending",
    confidence: 0,
    scope: [`src/${name}/`],
    gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
    resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };
}

const passReviewer = () => ({ pass: true, reason: "ok" });

describe("orchestrateUnits — stuck detection (#546)", () => {
  test("clean run emits no stuck signals", async () => {
    const events: ProgressEvent[] = [];
    await orchestrateUnits({
      units: [unit("a"), unit("b")],
      dispatcher: async () => ({ status: "done" as const, confidence: 0.9, evidence: ["e1"] }),
      reviewer: passReviewer,
      concurrency: 2,
      onProgress: (ev) => events.push(ev),
    });
    const done = events.filter((e) => e.phase === "done");
    expect(done).toHaveLength(2);
    expect(done.every((e) => e.stuck === undefined)).toBe(true);
  });

  test("evidence-stuck surfaces on the done event but does not block the unit", async () => {
    const events: ProgressEvent[] = [];
    // evidenceStallRounds:0 → count is checked immediately; a unit whose
    // evidence never changes from its starting count trips evidence-stuck.
    const { units, reviews } = await orchestrateUnits({
      units: [unit("stuck")],
      dispatcher: async () => ({ status: "done" as const, confidence: 0.9, evidence: [] }),
      reviewer: passReviewer,
      concurrency: 1,
      stuckOpts: { evidenceStallRounds: 0 },
      onProgress: (ev) => events.push(ev),
    });
    const done = events.find((e) => e.phase === "done");
    expect(done?.stuck).toBeDefined();
    expect(done?.stuck?.some((r) => r.startsWith("evidence-stuck"))).toBe(true);
    // Non-abortive: the unit still completes and is reviewed.
    const u0 = units[0];
    expect(u0?.status).toBe("done");
    expect(reviews[0]?.pass).toBe(true);
  });
});
