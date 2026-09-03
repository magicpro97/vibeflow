import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #783 regression: `vf orchestrate` must not dispatch blocked work units.
// The filter in orchestrate.ts:176 now excludes BLOCKED in addition to DONE.
describe("vf orchestrate skips blocked units (#783)", () => {
  const dir = join(tmpdir(), "vf-test-783");

  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, ".vibeflow"), { recursive: true });
    // State: 1 DONE, 1 BLOCKED, 1 PENDING — only PENDING should dispatch.
    writeFileSync(
      join(dir, ".vibeflow", "WORKFLOW_STATE.json"),
      JSON.stringify({
        task_id: "test-783",
        goal: "test skip blocked",
        risk: "feature",
        work_units: [
          {
            name: "u1-done",
            status: "done",
            confidence: 1,
            evidence: ["done"],
            gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
            resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          },
          {
            name: "u2-blocked",
            status: "blocked",
            confidence: 0,
            gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
            resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          },
          {
            name: "u3-pending",
            status: "pending",
            confidence: 0,
            gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
            resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          },
        ],
        totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry-run skips blocked units and prints skip message", async () => {
    const { orchestrate } = await import("../src/commands/orchestrate.js");
    // Capture console.log to verify the "Skipping blocked" message.
    const logs: string[] = [];
    const origLog = console.log.bind(console);
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const code = await orchestrate({ engine: "claude", dry: true }, dir);
      expect(code).toBe(1);
      const all = logs.join("\n");
      expect(all).toContain("Skipping 1 blocked unit(s)");
      expect(all).toContain("u2-blocked");
    } finally {
      console.log = origLog;
    }
  });
});
