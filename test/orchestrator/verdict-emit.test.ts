import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkUnit } from "../../src/core.js";
import { Logbus, setLogbusForTests } from "../../src/logbus.js";
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

const passDispatcher = async () => ({
  status: "done" as const,
  confidence: 0.9,
  evidence: ["e.log"],
});

/** Read every JSONL event the bus persisted to current.log. */
function readEvents(bus: Logbus): Array<Record<string, unknown>> {
  return readFileSync(bus.currentFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("orchestrateUnits — emits reviewer verdict + gate result to logbus (#542)", () => {
  test("a settled unit emits one channel:vf verdict event carrying unit, review, gates, goal_score", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-verdict-"));
    const bus = new Logbus({ runId: "test", dir });
    setLogbusForTests(bus);
    try {
      await orchestrateUnits({
        units: [unit("alpha")],
        dispatcher: passDispatcher,
        reviewer: () => ({ pass: true, reason: "ok", score: 0.87 }),
      });
      await bus.close();
      const verdicts = readEvents(bus).filter(
        (e) => e.channel === "vf" && (e.meta as Record<string, unknown>)?.kind === "verdict",
      );
      expect(verdicts).toHaveLength(1);
      const v = verdicts[0] as Record<string, unknown>;
      expect(v.unit).toBe("alpha");
      const meta = v.meta as Record<string, unknown>;
      expect(meta.review).toBe("pass");
      expect(meta.goal_score).toBe(0.87);
      expect((meta.gates as Record<string, unknown>).review).toBe("pass");
      // #549: the verdict now carries the unit's cost/token resources so `vf eval`
      // can report spend without re-reading WORKFLOW_STATE.
      const resources = meta.resources as Record<string, unknown>;
      expect(resources.cost_usd).toBe(0);
      expect(resources.tokens).toBe(0);
    } finally {
      setLogbusForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed review emits review:fail and omits goal_score when the reviewer gives none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-verdict-fail-"));
    const bus = new Logbus({ runId: "test", dir });
    setLogbusForTests(bus);
    try {
      await orchestrateUnits({
        units: [unit("beta")],
        dispatcher: passDispatcher,
        reviewer: () => ({ pass: false, reason: "nope" }),
      });
      await bus.close();
      const v = readEvents(bus).find(
        (e) => e.channel === "vf" && (e.meta as Record<string, unknown>)?.kind === "verdict",
      ) as Record<string, unknown>;
      expect(v.unit).toBe("beta");
      const meta = v.meta as Record<string, unknown>;
      expect(meta.review).toBe("fail");
      expect("goal_score" in meta).toBe(false);
      expect((meta.gates as Record<string, unknown>).review).toBe("fail");
    } finally {
      setLogbusForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
