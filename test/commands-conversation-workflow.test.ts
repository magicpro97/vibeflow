import { describe, expect, test } from "bun:test";
import { executeConversationWorkflow } from "../src/commands/conversation-workflow.js";
import type { WorkUnit, WorkflowState } from "../src/core.js";

const unit = (name: string, status: WorkUnit["status"] = "pending"): WorkUnit => ({
  name,
  status,
  confidence: status === "done" ? 1 : 0,
  riskClass: "feature",
  scope: [`src/${name}.ts`],
  gates:
    status === "done"
      ? { build: "pass", lint: "pass", test: "pass", review: "pass" }
      : { build: "pending", lint: "pending", test: "pending", review: "pending" },
  resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  evidence: status === "done" ? [`src/${name}.ts:1`] : [],
});

const state = (workUnits: WorkUnit[]): WorkflowState => ({
  task_id: "workflow-task",
  goal: "ship it",
  success_criteria: [],
  work_units: workUnits,
  totals: {
    units: workUnits.length,
    done: workUnits.filter((candidate) => candidate.status === "done").length,
    tokens: 0,
    cost_usd: 0,
    wall_seconds: 0,
  },
});

const context = (signal: AbortSignal) =>
  ({
    bindings: [{ engine: "codex" }],
    signal,
  }) as never;

const expectWritten = (state: WorkflowState | null): WorkflowState => {
  if (state === null) {
    throw new Error("expected workflow state to be written");
  }
  return state;
};

describe("executeConversationWorkflow", () => {
  test("runs the real pending slice only and preserves exact review outcomes", async () => {
    const workflow = state([unit("done-unit", "done"), unit("unit-a"), unit("unit-b")]);
    let written: WorkflowState | null = null;
    let dispatcherArgs: Record<string, unknown> | null = null;
    let reviewerArgs: Record<string, unknown> | null = null;
    let seenSignal: AbortSignal | null = null;

    const result = await executeConversationWorkflow(
      "/tmp/task5-workflow",
      context(new AbortController().signal),
      {
        readState: () => structuredClone(workflow),
        writeState: (_base, next) => {
          written = structuredClone(next);
        },
        recomputeTotals: (next) => {
          next.totals = {
            units: next.work_units.length,
            done: next.work_units.filter((candidate) => candidate.status === "done").length,
            tokens: 0,
            cost_usd: 0,
            wall_seconds: 0,
          };
          return next;
        },
        defaultContext: () => ({ repoRoot: "/tmp/task5-workflow" }) as never,
        readSettings: () => ({}) as never,
        thresholdFor: (risk) => {
          expect(risk).toBe("feature");
          return 0.85;
        },
        makeDispatcher: (engine, project, base, actor, riskClass) => {
          dispatcherArgs = { engine, project, base, actor, riskClass };
          return async () => {
            throw new Error("injected dispatch handles this test");
          };
        },
        makeReviewer: (actor, threshold, meta) => {
          reviewerArgs = { actor, threshold, meta };
          return async () => ({ pass: true, reason: "review" }) as never;
        },
        dispatch: async ({ units, signal }) => {
          seenSignal = signal;
          expect(units.map((candidate) => candidate.name)).toEqual(["unit-a", "unit-b"]);
          return {
            ran: [
              {
                ...units[0],
                status: "done",
                confidence: 1,
                evidence: ["src/unit-a.ts:1"],
              } as WorkUnit,
              {
                ...units[1],
                status: "blocked",
                confidence: 0.2,
                evidence: ["needs follow-up"],
              } as WorkUnit,
            ],
            reviews: [
              { unit: "unit-a", pass: true, reason: "looks good" },
              { unit: "unit-b", pass: false, reason: "changes requested" },
            ],
          };
        },
      },
    );

    expect(seenSignal).toBeTruthy();
    expect(dispatcherArgs).toMatchObject({
      engine: "codex",
      base: "/tmp/task5-workflow",
      actor: "bridge",
      riskClass: "feature",
    });
    expect(reviewerArgs).toMatchObject({
      actor: "bridge",
      threshold: 0.85,
      meta: { cwd: "/tmp/task5-workflow", implementer: "codex", goal: "ship it" },
    });
    expect(result).toEqual({
      units: [
        { ...unit("unit-a"), status: "done", confidence: 1, evidence: ["src/unit-a.ts:1"] },
        {
          ...unit("unit-b"),
          status: "blocked",
          confidence: 0.2,
          evidence: ["needs follow-up"],
        },
      ],
      reviews: [
        { unit: "unit-a", pass: true, reason: "looks good" },
        { unit: "unit-b", pass: false, reason: "changes requested" },
      ],
    });
    const persisted = expectWritten(written);
    expect(persisted.work_units.map((candidate) => candidate.name)).toEqual([
      "done-unit",
      "unit-a",
      "unit-b",
    ]);
    expect(persisted.totals).toMatchObject({ units: 3, done: 2 });
  });

  test("treats an empty pending set as a valid no-op", async () => {
    const workflow = state([unit("done-unit", "done")]);
    let writes = 0;
    const result = await executeConversationWorkflow(
      "/tmp/task5-noop",
      context(new AbortController().signal),
      {
        readState: () => structuredClone(workflow),
        writeState: () => {
          writes += 1;
        },
        defaultContext: () => ({ repoRoot: "/tmp/task5-noop" }) as never,
        readSettings: () => ({}) as never,
        dispatch: async () => {
          throw new Error("dispatch should not run");
        },
      },
    );

    expect(result).toEqual({ units: [], reviews: [] });
    expect(writes).toBe(0);
  });

  test("fails closed when dispatch throws and never leaks the thrown detail", async () => {
    const workflow = state([unit("unit-a"), unit("unit-b")]);
    let written: WorkflowState | null = null;

    const result = await executeConversationWorkflow(
      "/tmp/task5-dispatch-fail",
      context(new AbortController().signal),
      {
        readState: () => structuredClone(workflow),
        writeState: (_base, next) => {
          written = structuredClone(next);
        },
        recomputeTotals: (next) => {
          next.totals = {
            units: next.work_units.length,
            done: next.work_units.filter((candidate) => candidate.status === "done").length,
            tokens: 0,
            cost_usd: 0,
            wall_seconds: 0,
          };
          return next;
        },
        defaultContext: () => ({ repoRoot: "/tmp/task5-dispatch-fail" }) as never,
        readSettings: () => ({}) as never,
        makeDispatcher: () =>
          (async () => ({ status: "done", confidence: 1, evidence: [] })) as never,
        makeReviewer: () => (async () => ({ pass: true, reason: "unexpected" })) as never,
        dispatch: async () => {
          throw new Error("/private/path/token should never escape");
        },
      },
    );

    expect(result.reviews).toEqual([
      { unit: "unit-a", pass: false, reason: "workflow dispatch failed" },
      { unit: "unit-b", pass: false, reason: "workflow dispatch failed" },
    ]);
    expect(result.units.every((candidate) => candidate.status === "blocked")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("/private/path/token");
    const persisted = expectWritten(written);
    expect(persisted.work_units.every((candidate) => candidate.status === "blocked")).toBe(true);
  });

  test("passes the context cancellation signal into dispatch and blocks illegal success after abort", async () => {
    const controller = new AbortController();
    const workflow = state([unit("unit-a")]);
    let written: WorkflowState | null = null;
    let seenSignal: AbortSignal | null = null;

    const result = await executeConversationWorkflow(
      "/tmp/task5-cancel",
      context(controller.signal),
      {
        readState: () => structuredClone(workflow),
        writeState: (_base, next) => {
          written = structuredClone(next);
        },
        recomputeTotals: (next) => {
          next.totals = {
            units: next.work_units.length,
            done: next.work_units.filter((candidate) => candidate.status === "done").length,
            tokens: 0,
            cost_usd: 0,
            wall_seconds: 0,
          };
          return next;
        },
        defaultContext: () => ({ repoRoot: "/tmp/task5-cancel" }) as never,
        readSettings: () => ({}) as never,
        makeDispatcher: () =>
          (async () => ({ status: "done", confidence: 1, evidence: [] })) as never,
        makeReviewer: () => (async () => ({ pass: true, reason: "unexpected" })) as never,
        dispatch: async ({ units, signal }) => {
          seenSignal = signal;
          controller.abort();
          return {
            ran: [
              {
                ...units[0],
                status: "done",
                confidence: 1,
                evidence: ["src/unit-a.ts:1"],
              } as WorkUnit,
            ],
            reviews: [{ unit: "unit-a", pass: true, reason: "should be suppressed" }],
          };
        },
      },
    );

    expect(seenSignal === controller.signal).toBe(true);
    expect(result).toEqual({
      units: [
        {
          ...unit("unit-a"),
          status: "blocked",
          confidence: 0,
          evidence: ["src/unit-a.ts:1"],
          gates: { build: "pending", lint: "pending", test: "pending", review: "fail" },
        },
      ],
      reviews: [{ unit: "unit-a", pass: false, reason: "workflow cancelled" }],
    });
    const persisted = expectWritten(written);
    expect(persisted.work_units[0]).toMatchObject({
      name: "unit-a",
      status: "blocked",
      gates: { review: "fail" },
    });
  });
});
