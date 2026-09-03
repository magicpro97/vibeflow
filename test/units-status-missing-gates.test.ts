import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #782 regression: `vf units status` must not crash when a work unit
// lacks the optional `gates` field (ai-init-workflow writes partial
// state). The `g = u.gates ?? {}` guard in units.ts:53 handles this.
describe("vf units status — missing optional gates field (#782)", () => {
  const tmp = join(tmpdir(), "vf-test-782");
  const origCwd = process.cwd;

  beforeAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(tmp, ".vibeflow", "WORKFLOW_STATE.json"),
      JSON.stringify({
        goal: "test",
        work_units: [
          {
            name: "no-gates-unit",
            status: "pending",
            confidence: 0,
          },
        ],
        totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      }),
    );
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("status does not crash when gates is missing", async () => {
    const { units } = await import("../src/commands/units.js");
    process.cwd = () => tmp;
    try {
      const exit = await units("status", []);
      expect(exit).toBe(0);
    } finally {
      process.cwd = origCwd;
    }
  });
});
