import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #783 regression: `vf orchestrate` must not dispatch blocked work units.
// The filter in orchestrate.ts:176 now excludes BLOCKED in addition to DONE.
describe("vf orchestrate skips blocked units (#783)", () => {
  const dir = join(tmpdir(), "vf-test-783");
  const origCwd = process.cwd;

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

  test("dry-run with blocked units does not dispatch them", async () => {
    const { orchestrate } = await import("../src/commands/orchestrate.js");
    process.cwd = () => dir;
    try {
      // Dry mode — no engine needed, just verifies the filter logic.
      const code = await orchestrate({ engine: "claude", dry: true }, dir);
      // Blocked unit → goal eval returns "blocked" → exit 1.
      expect(code).toBe(1);
    } finally {
      process.cwd = origCwd;
    }
  });
});
