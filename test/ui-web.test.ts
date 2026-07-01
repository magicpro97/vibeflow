// Tests for src/ui/src/ — only pure-TS modules that run without DOM.
// Composables (useSSE, usePoller) require Vue lifecycle → not tested here.
// api.ts requires document.querySelector → not tested here.
// Types are compile-time only but we can import and do shape checks.
import { describe, expect, test } from "bun:test";

// Import the types module to verify it parses without errors.
// The import itself is the smoke test.
import type {
  GateState,
  LogEvent,
  VibeSettings,
  WorkUnit,
  WorkflowState,
} from "../src/ui/src/types.js";

describe("ui types: WorkUnit", () => {
  test("valid WorkUnit satisfies the shape", () => {
    const u: WorkUnit = {
      name: "test-unit",
      status: "pending",
      confidence: 0,
      gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    expect(u.name).toBe("test-unit");
    expect(u.status).toBe("pending");
  });

  test("all status values are valid string literals", () => {
    const statuses: WorkUnit["status"][] = ["pending", "running", "verifying", "done", "blocked"];
    expect(statuses).toHaveLength(5);
  });

  test("all gate states are valid", () => {
    const gates: GateState[] = ["pass", "fail", "running", "pending"];
    expect(gates).toHaveLength(4);
  });
});

describe("ui types: WorkflowState", () => {
  test("valid WorkflowState satisfies the shape", () => {
    const s: WorkflowState = {
      task_id: "abc",
      goal: "build something",
      success_criteria: ["tests pass"],
      work_units: [],
      totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    expect(s.task_id).toBe("abc");
    expect(s.work_units).toHaveLength(0);
  });
});

describe("ui types: LogEvent", () => {
  test("valid LogEvent satisfies the shape", () => {
    const ev: LogEvent = {
      seq: 1,
      ts: 1000,
      runId: "r1",
      channel: "vf",
      level: "info",
      text: "hello",
    };
    expect(ev.channel).toBe("vf");
    expect(ev.level).toBe("info");
  });
});

describe("ui types: VibeSettings", () => {
  test("valid VibeSettings satisfies the shape", () => {
    const s: VibeSettings = {
      tools: { codegraph: true, lsp: false },
      toolPriority: ["codegraph", "lsp", "native"],
      failureProtection: {
        timeoutSeconds: 300,
        autoWip: false,
        rollbackOnFail: false,
        requireGit: true,
      },
      memory: false,
      updatedAt: "2026-01-01",
    };
    expect(s.tools.codegraph).toBe(true);
    expect(s.failureProtection.requireGit).toBe(true);
  });
});

// stageReachable logic inlined (store.ts uses document.querySelector — DOM-only)
// Mirrors src/ui/src/store.ts stageReachable exactly.
function localStageReachable(n: 1 | 2 | 3 | 4, state: WorkflowState | null): boolean {
  if (n === 1) return true;
  if (n === 2) return state !== null;
  if (n === 3) return state !== null; // Stage 3 reachable when goal set — orchestrate creates units there
  if (n === 4) {
    const units = state?.work_units ?? [];
    return units.length > 0 && units.every((u) => u.status === "done" || u.status === "blocked");
  }
  return false;
}

describe("stageReachable: pure stage gate logic", () => {
  const noUnits: WorkflowState = {
    task_id: "T1",
    goal: "g",
    success_criteria: [],
    work_units: [],
    totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };
  const withPending: WorkflowState = {
    ...noUnits,
    work_units: [
      {
        name: "u1",
        status: "pending",
        confidence: 0,
        gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      },
    ],
  };
  const allDone: WorkflowState = {
    ...noUnits,
    work_units: [
      {
        name: "u1",
        status: "done",
        confidence: 0.9,
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        resources: { agents: 1, tokens: 100, cost_usd: 0.01, wall_seconds: 5 },
      },
    ],
  };
  const mixed: WorkflowState = {
    ...noUnits,
    work_units: [
      {
        name: "u1",
        status: "done",
        confidence: 0.9,
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        resources: { agents: 1, tokens: 100, cost_usd: 0.01, wall_seconds: 5 },
      },
      {
        name: "u2",
        status: "blocked",
        confidence: 0,
        gates: { build: "fail", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      },
    ],
  };

  test("stage 1 always reachable", () => {
    expect(localStageReachable(1, null)).toBe(true);
    expect(localStageReachable(1, noUnits)).toBe(true);
  });
  test("stage 2 requires non-null state", () => {
    expect(localStageReachable(2, null)).toBe(false);
    expect(localStageReachable(2, noUnits)).toBe(true);
  });
  test("stage 3 reachable when state exists (orchestrate creates units on stage 3)", () => {
    expect(localStageReachable(3, null)).toBe(false);
    expect(localStageReachable(3, noUnits)).toBe(true); // state exists, units created by orchestrate
    expect(localStageReachable(3, withPending)).toBe(true);
  });
  test("stage 4 requires all units done or blocked", () => {
    expect(localStageReachable(4, null)).toBe(false);
    expect(localStageReachable(4, noUnits)).toBe(false);
    expect(localStageReachable(4, withPending)).toBe(false);
    expect(localStageReachable(4, allDone)).toBe(true);
    expect(localStageReachable(4, mixed)).toBe(true);
  });
});

describe("setStage guard: no forward jump to unreachable stage", () => {
  // Mirrors store.ts setStage guard — tested without Pinia/DOM by inlining logic
  function localSetStage(
    current: 1 | 2 | 3 | 4,
    target: 1 | 2 | 3 | 4,
    state: WorkflowState | null,
  ): 1 | 2 | 3 | 4 {
    if (target > current && !localStageReachable(target, state)) return current;
    return target;
  }

  const withUnits: WorkflowState = {
    task_id: "T1",
    goal: "g",
    success_criteria: [],
    work_units: [
      {
        name: "u1",
        status: "pending",
        confidence: 0,
        gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      },
    ],
    totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };

  test("forward to stage 2 blocked if no state", () => {
    expect(localSetStage(1, 2, null)).toBe(1);
  });
  test("forward to stage 2 allowed when units exist", () => {
    expect(localSetStage(1, 2, withUnits)).toBe(2);
  });
  test("forward to stage 4 blocked when units not all done", () => {
    expect(localSetStage(1, 4, withUnits)).toBe(1);
  });
  test("backwards navigation always allowed regardless of state", () => {
    expect(localSetStage(4, 1, null)).toBe(1);
    expect(localSetStage(3, 2, null)).toBe(2);
  });
});
