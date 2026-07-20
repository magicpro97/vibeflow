import { describe, expect, test } from "bun:test";
import type { WorkUnit } from "../src/core/types.js";
import type { LogEvent } from "../src/logbus/types.js";
import {
  buildDashboardItems,
  dashboardKey,
  matchesDashboardEvent,
  resolveDashboardSelection,
  workflowStatus,
} from "../src/server/dashboard.js";
import type { WorkflowDashboardItem } from "../src/server/dashboard.js";

describe("workflowStatus", () => {
  test("running wins over blocked/done", () => {
    expect(
      workflowStatus([
        { name: "a", status: "running" },
        { name: "b", status: "done" },
        { name: "c", status: "blocked" },
      ] as WorkUnit[]),
    ).toBe("running");
  });

  test("blocked wins over pending/done", () => {
    expect(
      workflowStatus([
        { name: "a", status: "blocked" },
        { name: "b", status: "pending" },
        { name: "c", status: "done" },
      ] as WorkUnit[]),
    ).toBe("blocked");
  });

  test("all done returns done", () => {
    expect(
      workflowStatus([
        { name: "a", status: "done" },
        { name: "b", status: "done" },
      ] as WorkUnit[]),
    ).toBe("done");
  });

  test("empty units returns pending", () => {
    expect(workflowStatus([])).toBe("pending");
  });
});

describe("dashboardKey", () => {
  test("joins repoPath and taskId with null byte", () => {
    expect(dashboardKey("/repo/a", "TASK-1")).toBe("/repo/a\u0000TASK-1");
  });
});

describe("buildDashboardItems", () => {
  test("returns empty array for empty registry", () => {
    const items = buildDashboardItems([]);
    expect(items).toEqual([]);
  });

  test("omits entries without valid state", () => {
    const items = buildDashboardItems([
      {
        path: "/nonexistent",
        name: "missing",
        lastUsed: 0,
        goal: "",
        totals: { units: 0, done: 0, tokens: 0, cost_usd: 0 },
      },
    ]);
    expect(items).toEqual([]);
  });
});

describe("resolveDashboardSelection", () => {
  const items: WorkflowDashboardItem[] = [
    {
      key: "/repo/a\u0000TASK-A",
      repoPath: "/repo/a",
      repoName: "a",
      taskId: "TASK-A",
      goal: "test",
      updatedAt: 100,
      workUnits: [
        {
          name: "u1",
          status: "pending",
          confidence: 0,
          gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      status: "pending",
      waves: [["u1"]],
    },
  ];

  test("exact registry path and task ID succeeds", () => {
    const sel = resolveDashboardSelection("/repo/a", "TASK-A", undefined, items);
    expect("error" in sel).toBe(false);
    if (!("error" in sel)) {
      expect(sel.repoPath).toBe("/repo/a");
      expect(sel.workflowId).toBe("TASK-A");
    }
  });

  test("unregistered repoPath returns 400", () => {
    const sel = resolveDashboardSelection("/repo/b", "TASK-B", undefined, items);
    expect("error" in sel && (sel as { status: number }).status === 400).toBe(true);
  });

  test("task ID mismatch returns 404", () => {
    const sel = resolveDashboardSelection("/repo/a", "TASK-WRONG", undefined, items);
    expect("error" in sel && (sel as { status: number }).status === 404).toBe(true);
  });

  test("unknown unit returns 404", () => {
    const sel = resolveDashboardSelection("/repo/a", "TASK-A", "nonexistent", items);
    expect("error" in sel && (sel as { status: number }).status === 404).toBe(true);
  });
});

describe("event sort with runId+seq tiebreaking", () => {
  test("sorts by seq then runId for cross-run stability", () => {
    // Simulate the sort used in WorkflowDashboard.vue
    const events = [
      { seq: 2, runId: "r2" },
      { seq: 1, runId: "r2" },
      { seq: 2, runId: "r1" },
      { seq: 1, runId: "r1" },
    ] as const;
    // Sort must be stable across runs: seq first, then runId
    const sorted = [...events].sort(
      (a, b) =>
        (a.seq as number) - (b.seq as number) ||
        (a.runId as string).localeCompare(b.runId as string),
    );
    expect(sorted.map((e) => `${e.runId}:${e.seq}`)).toEqual(["r1:1", "r2:1", "r1:2", "r2:2"]);
  });
});

describe("matchesDashboardEvent", () => {
  const sel = { repoPath: "/repo/a", workflowId: "TASK-A" };

  test("matching workflowId passes", () => {
    expect(
      matchesDashboardEvent(
        {
          seq: 1,
          ts: 0,
          runId: "r",
          workflowId: "TASK-A",
          repoPath: "/repo/a",
          channel: "vf" as const,
          level: "info" as const,
          text: "hi",
        },
        sel,
        true,
      ),
    ).toBe(true);
  });

  test("non-matching repoPath filtered out", () => {
    expect(
      matchesDashboardEvent(
        {
          seq: 1,
          ts: 0,
          runId: "r",
          workflowId: "TASK-A",
          repoPath: "/repo/b",
          channel: "vf" as const,
          level: "info" as const,
          text: "hi",
        },
        sel,
        true,
      ),
    ).toBe(false);
  });

  test("legacy event without workflowId/repoPath excluded", () => {
    expect(
      matchesDashboardEvent(
        {
          seq: 1,
          ts: 0,
          runId: "r",
          channel: "vf" as const,
          level: "info" as const,
          text: "legacy",
        },
        sel,
        true,
      ),
    ).toBe(false);
  });

  test("event with mismatched repoPath filtered out", () => {
    expect(
      matchesDashboardEvent(
        {
          seq: 2,
          ts: 0,
          runId: "r",
          workflowId: "TASK-A",
          repoPath: "/repo/b",
          channel: "vf" as const,
          level: "info" as const,
          text: "wrong repo",
        },
        sel,
        true,
      ),
    ).toBe(false);
  });

  test("legacy event with only workflowId still excluded", () => {
    expect(
      matchesDashboardEvent(
        {
          seq: 3,
          ts: 0,
          runId: "r",
          workflowId: "TASK-A",
          channel: "vf" as const,
          level: "info" as const,
          text: "no repoPath",
        },
        sel,
        true,
      ),
    ).toBe(false);
  });

  test("unit filter includes workflow events when includeWorkflowEvents=true", () => {
    const unitSel = { ...sel, unit: "u1" };
    expect(
      matchesDashboardEvent(
        {
          seq: 1,
          ts: 0,
          runId: "r",
          workflowId: "TASK-A",
          repoPath: "/repo/a",
          channel: "vf" as const,
          level: "info" as const,
          text: "wf",
        },
        unitSel,
        true,
      ),
    ).toBe(true);
    expect(
      matchesDashboardEvent(
        {
          seq: 2,
          ts: 0,
          runId: "r",
          workflowId: "TASK-A",
          repoPath: "/repo/a",
          unit: "u1",
          channel: "vf" as const,
          level: "info" as const,
          text: "unit",
        },
        unitSel,
        true,
      ),
    ).toBe(true);
    expect(
      matchesDashboardEvent(
        {
          seq: 3,
          ts: 0,
          runId: "r",
          workflowId: "TASK-A",
          repoPath: "/repo/a",
          unit: "u2",
          channel: "vf" as const,
          level: "info" as const,
          text: "other",
        },
        unitSel,
        true,
      ),
    ).toBe(false);
  });
});
