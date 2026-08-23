import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIntake, doctor, orchestrate } from "../src/commands.js";
import { type WorkflowState, readState, writeState } from "../src/core.js";
import type { EngineProcessSpawner } from "../src/dispatch/session-types.js";
import type { GitRunner } from "../src/safety/checkpoint.js";

function writeFixture(base: string, overrides: Partial<WorkflowState> = {}): void {
  const ctx = join(base, ".vibeflow");
  mkdirSync(ctx, { recursive: true });
  const state: WorkflowState = {
    task_id: "TASK-1",
    goal: "test goal",
    success_criteria: [],
    work_units: [
      {
        name: "unit-a",
        status: "pending",
        confidence: 0,
        scope: ["src/a/"],
        gates: {
          build: "pending",
          lint: "pending",
          test: "pending",
          review: "pending",
        },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      },
      {
        name: "unit-b",
        status: "pending",
        confidence: 0,
        scope: ["src/b/"],
        gates: {
          build: "pending",
          lint: "pending",
          test: "pending",
          review: "pending",
        },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      },
    ],
    totals: { units: 2, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    ...overrides,
  };
  writeFileSync(join(ctx, "WORKFLOW_STATE.json"), JSON.stringify(state, null, 2));
}

function completedEngineProcess(stdout: string) {
  return {
    stdin: { write: () => {}, end: () => {} },
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    exited: Promise.resolve(0),
    kill: () => {},
  };
}

function claudeProcessSpawner(confidence: number): EngineProcessSpawner {
  return () =>
    completedEngineProcess(
      JSON.stringify({
        type: "result",
        session_id: "50c1c208-9518-44e7-9fc5-d63b0bfcbec2",
        result: `\`\`\`json\n{"confidence": ${confidence}}\n\`\`\``,
      }),
    );
}

// ---------------------------------------------------------------------------
// 1. orchestrate dry-run lists units
// ---------------------------------------------------------------------------
describe("orchestrate dry-run", () => {
  test("lists units without crashing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "test-orch-dry-"));
    writeFixture(dir);
    // Dry mode: review always passes, goal eval yields "partial" (conf=0).
    const code = await orchestrate({ dry: true, engine: "claude" }, dir);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. doctor reports engine status
// ---------------------------------------------------------------------------
describe("doctor", () => {
  test("reports engine status", async () => {
    const readiness = [
      { engine: "claude" as const, level: "ready" as const, detail: "ready", checkedAt: "" },
      { engine: "codex" as const, level: "ready" as const, detail: "ready", checkedAt: "" },
      { engine: "copilot" as const, level: "ready" as const, detail: "ready", checkedAt: "" },
    ];
    const code = await doctor({}, { readiness, hasCommand: () => true });
    expect(typeof code).toBe("number");
    // node + git are required and should be present
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. applyIntake generates state
// ---------------------------------------------------------------------------
describe("applyIntake", () => {
  test("generates state from minimal answers", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-intake-"));
    const result = applyIntake(
      { goal: "test", engines: ["claude"] },
      { base: dir, dry: true, skipPreflight: true },
    );
    expect(result).toBeDefined();
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.state).toBeDefined();
    expect(result.state.goal).toBe("test");
    expect(Array.isArray(result.state.work_units)).toBe(true);
    expect(result.state.task_id).toBe("TASK-1");
  });
});

// ---------------------------------------------------------------------------
// 4. writeState preserves existing
// ---------------------------------------------------------------------------
describe("writeState", () => {
  test("preserves existing fields on re-write", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-wstate-"));
    const initial: WorkflowState = {
      task_id: "TASK-1",
      goal: "original",
      success_criteria: [],
      work_units: [
        {
          name: "unit-a",
          status: "pending",
          confidence: 0,
          gates: {
            build: "pending",
            lint: "pending",
            test: "pending",
            review: "pending",
          },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    writeState(dir, initial);

    const read = readState(dir);
    if (!read) throw new Error("expected state");
    read.goal = "updated";
    writeState(dir, read);

    const updated = readState(dir);
    expect(updated).not.toBeNull();
    expect(updated?.goal).toBe("updated");
    expect(updated?.work_units).toHaveLength(1);
    expect(updated?.work_units[0]?.name).toBe("unit-a");
    // Unchanged fields survive
    expect(updated?.task_id).toBe("TASK-1");
    expect(updated?.success_criteria).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5 & 6 — review gate tested through orchestrate with real CLI mode
// ---------------------------------------------------------------------------
describe("orchestrate review gate", () => {
  const mockGit: GitRunner = () => ({
    status: 128,
    stdout: "",
    stderr: "not a git repository",
  });

  test("low confidence blocked (0.4 < 0.85 threshold)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "test-orch-low-"));
    writeFixture(dir);

    const code = await orchestrate({ yes: true, risk: "feature", engine: "claude" }, dir, {
      sessionRuntime: { processSpawner: claudeProcessSpawner(0.4) },
      git: mockGit,
      // Inject a passing gate so this test isolates the CONFIDENCE path — the
      // real scopedGate (wired in #267) would otherwise fail in the empty
      // tmpdir (no tsconfig/files) and block via the W-C fail-closed reviewer.
      gate: () => ({ pass: true }),
    });
    // Blocked → goal "blocked" → exit 1
    expect(code).toBe(1);
  });

  test("high confidence passes (0.9 >= 0.85 threshold)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "test-orch-high-"));
    writeFixture(dir);

    const code = await orchestrate({ yes: true, risk: "feature", engine: "claude" }, dir, {
      sessionRuntime: { processSpawner: claudeProcessSpawner(0.9) },
      git: mockGit,
      // Passing gate → isolates the confidence path (see note above).
      gate: () => ({ pass: true }),
    });
    // Not blocked → goal "partial" (conf 0.9 < 1) → exit 0
    expect(code).toBe(0);
  });
});
