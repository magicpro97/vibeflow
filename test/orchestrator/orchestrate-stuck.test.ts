// test/orchestrator/orchestrate-stuck.test.ts
// #546 — integration: StuckDetector wired into orchestrateUnits worker

import { describe, expect, test } from "bun:test";
import type { WorkUnit } from "../../src/core.js";
import { orchestrateUnits } from "../../src/orchestrator/run.js";

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

describe("orchestrateUnits — stuck detection (issue #546)", () => {
  test("detector does not crash on normal outcome (no false positive)", async () => {
    const { units, reviews } = await orchestrateUnits({
      units: [unit("healthy")],
      dispatcher: async () => ({
        status: "done" as const,
        confidence: 0.9,
        evidence: ["src/foo.ts", "src/bar.ts"],
      }),
      reviewer: passReviewer,
      concurrency: 1,
    });
    expect(units).toHaveLength(1);
    expect(units[0].status).toBe("done");
    expect(reviews[0].pass).toBe(true);
  });

  test("zero-evidence outcome passes through normally (no false stuck)", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("no-evidence")],
      dispatcher: async () => ({
        status: "verifying" as const,
        confidence: 0,
        evidence: [],
      }),
      reviewer: passReviewer,
      concurrency: 1,
    });
    expect(units[0].status).toBe("done");
  });

  test("dispatcher throw does not crash stuck detection path", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("thrower")],
      dispatcher: async () => {
        throw new Error("boom");
      },
      reviewer: passReviewer,
      concurrency: 1,
    });
    expect(units).toHaveLength(1);
    expect(units[0].status).toBe("done");
    expect(units[0].confidence).toBe(0);
  });
});
