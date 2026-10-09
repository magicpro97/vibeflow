// test/commands-resources.test.ts
//
// `vf resources` CLI surface (Task 2 of the resource-management plan):
// text rendering, --json passthrough, and the exit-0 degradation when the
// workflow state file is missing. The aggregation itself (totals, rollups,
// warnings) is covered by test/resources.test.ts — these pins only assert
// that the command renders buildResourceSnapshot faithfully.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resources } from "../src/commands/resources.js";
import { type WorkflowState, writeState } from "../src/core.js";

const origCwd = process.cwd();
let dir: string;
let lines: string[];
let log: typeof console.log;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vf-resources-"));
  process.chdir(dir);
  lines = [];
  log = console.log;
  console.log = (...parts: unknown[]) => {
    lines.push(parts.join(" "));
  };
});

afterEach(() => {
  console.log = log;
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

/** alpha (claude, exact resources) + beta (codex, zero resources) + gamma
 *  (claude, zero resources) → totals 2/3, claude rollup 2 units, two warnings. */
function writeFixture(): void {
  const state: WorkflowState = {
    task_id: "T2",
    goal: "g",
    success_criteria: [],
    totals: { units: 3, done: 2, tokens: 1200, cost_usd: 0.42, wall_seconds: 380 },
    work_units: [
      {
        name: "alpha",
        status: "done",
        confidence: 1,
        engine: "claude",
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        resources: { agents: 1, tokens: 1200, cost_usd: 0.42, wall_seconds: 380 },
      },
      {
        name: "beta",
        status: "done",
        confidence: 1,
        engine: "codex",
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      },
      {
        name: "gamma",
        status: "pending",
        confidence: 0,
        engine: "claude",
        gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      },
    ],
  };
  writeState(dir, state);
}

describe("vf resources", () => {
  test("text mode: header, totals, per-engine rollups, warnings — in order", async () => {
    writeFixture();
    expect(await resources()).toBe(0);
    expect(lines).toHaveLength(6);
    const header = lines[0] ?? "";
    expect(header.startsWith("Resources · sampled ")).toBe(true);
    expect(Number.isNaN(Date.parse(header.slice("Resources · sampled ".length)))).toBe(false);
    expect(lines[1]).toBe("Totals: 2/3 done · 1200 tokens · $0.42 · 380s");
    // perEngine sorted by cost desc: claude (0.42) then codex (0).
    expect(lines[2]).toBe("  claude: 2 units · 1200 tokens · $0.42 · 380s");
    expect(lines[3]).toBe("  codex: 1 units · 0 tokens · $0 · 0s");
    expect(lines[4]).toBe("  ! 1 units on codex have no recorded resources");
    expect(lines[5]).toBe("  ! 1 units on claude have no recorded resources");
  });

  test("--json emits the parseable snapshot with schemaVersion and sampledAt", async () => {
    writeFixture();
    expect(await resources({ json: true })).toBe(0);
    expect(lines).toHaveLength(1);
    const snap = JSON.parse(lines[0] ?? "");
    expect(snap.schemaVersion).toBe(1);
    expect(typeof snap.sampledAt).toBe("string");
    expect(snap.totals).toEqual({
      units: 3,
      done: 2,
      tokens: 1200,
      cost_usd: 0.42,
      wall_seconds: 380,
    });
    expect(snap.perEngine).toHaveLength(2);
  });

  test("missing state: exit 0 and the vf status degradation line", async () => {
    expect(await resources()).toBe(0);
    expect(lines).toEqual(["No workflow state — run vf init"]);
  });

  test("--probe: renders the Quota section with unknown-level degradation", async () => {
    writeFixture();
    const inject = { probe: async () => ({ level: "unknown" as const, error: "probe failed" }) };
    expect(await resources({ probe: true }, inject)).toBe(0);
    expect(lines).toContain("Quota:");
    expect(lines).toContain("  copilot: unknown (probe failed)");
  });

  test("--probe: warning level renders the percent remaining", async () => {
    writeFixture();
    const inject = { probe: async () => ({ level: "warning" as const, percentRemaining: 12 }) };
    expect(await resources({ probe: true }, inject)).toBe(0);
    expect(lines).toContain("Quota:");
    expect(lines).toContain("  copilot: warning (12% remaining)");
  });
});
