import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkUnit } from "../../src/core.js";
import { getLogbus, setLogbusForTests } from "../../src/logbus.js";
import { Logbus } from "../../src/logbus.js";
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

  test("evidence-stuck at default (rounds=1) surfaces on the done event when evidence unchanged", async () => {
    const events: ProgressEvent[] = [];
    const { units, reviews } = await orchestrateUnits({
      units: [unit("stuck")],
      dispatcher: async () => ({ status: "done" as const, confidence: 0.9, evidence: [] }),
      reviewer: passReviewer,
      concurrency: 1,
      onProgress: (ev) => events.push(ev),
    });
    const done = events.find((e) => e.phase === "done");
    expect(done?.stuck).toBeDefined();
    expect(done?.stuck?.some((r) => r.startsWith("evidence-stuck"))).toBe(true);
    const u0 = units[0];
    expect(u0?.status).toBe("done");
    expect(reviews[0]?.pass).toBe(true);
  });

  test("evidence-stuck: differing evidence does not trip", async () => {
    const events: ProgressEvent[] = [];
    const { units } = await orchestrateUnits({
      units: [unit("growing")],
      dispatcher: async () => ({
        status: "done" as const,
        confidence: 0.9,
        evidence: ["e1", "e2"],
      }),
      reviewer: passReviewer,
      concurrency: 1,
      onProgress: (ev) => events.push(ev),
    });
    const done = events.find((e) => e.phase === "done");
    expect(done?.stuck).toBeUndefined();
    expect(units[0]?.status).toBe("done");
  });

  test("looping: 3 identical engine-stdout chunks fires looping but unit still completes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stuck-loop-"));
    const bus = new Logbus({ runId: "test-loop", dir });
    setLogbusForTests(bus);
    try {
      const events: ProgressEvent[] = [];
      const { units, reviews } = await orchestrateUnits({
        units: [unit("loop")],
        dispatcher: async () => {
          // Simulate dispatch-runtime.ts: emit engine-stdout during dispatch
          for (let i = 0; i < 3; i++) {
            bus.write({
              runId: "test-loop",
              channel: "engine-stdout",
              level: "info",
              text: "identical chunk",
              unit: "loop",
            });
          }
          return { status: "done" as const, confidence: 0.9, evidence: ["e1"] };
        },
        reviewer: passReviewer,
        concurrency: 1,
        stuckOpts: { loopThreshold: 3 },
        onProgress: (ev) => events.push(ev),
        logbus: bus,
      });
      const done = events.find((e) => e.phase === "done");
      expect(done?.stuck).toBeDefined();
      expect(done?.stuck?.some((r) => r.startsWith("looping"))).toBe(true);
      expect(units[0]?.status).toBe("done");
      expect(reviews[0]?.pass).toBe(true);
    } finally {
      setLogbusForTests(null);
      await bus.close();
    }
  });

  test("looping: 3 distinct chunks does not trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stuck-noloop-"));
    const bus = new Logbus({ runId: "test-noloop", dir });
    setLogbusForTests(bus);
    try {
      const events: ProgressEvent[] = [];
      const { units } = await orchestrateUnits({
        units: [unit("noloop")],
        dispatcher: async () => {
          bus.write({
            runId: "test-noloop",
            channel: "engine-stdout",
            level: "info",
            text: "a",
            unit: "noloop",
          });
          bus.write({
            runId: "test-noloop",
            channel: "engine-stdout",
            level: "info",
            text: "b",
            unit: "noloop",
          });
          bus.write({
            runId: "test-noloop",
            channel: "engine-stdout",
            level: "info",
            text: "c",
            unit: "noloop",
          });
          return { status: "done" as const, confidence: 0.9, evidence: ["e1"] };
        },
        reviewer: passReviewer,
        concurrency: 1,
        stuckOpts: { loopThreshold: 3 },
        onProgress: (ev) => events.push(ev),
        logbus: bus,
      });
      const done = events.find((e) => e.phase === "done");
      expect(done?.stuck).toBeUndefined();
      expect(units[0]?.status).toBe("done");
    } finally {
      setLogbusForTests(null);
      await bus.close();
    }
  });
});
