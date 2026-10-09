import { describe, expect, test } from "bun:test";
import type { WorkUnit, WorkflowState } from "../src/core.js";
import { RESOURCE_SNAPSHOT_SCHEMA_VERSION, buildResourceSnapshot } from "../src/resources.js";

const NOW = new Date("2026-10-09T05:00:00.000Z");

const unit = (over: Partial<WorkUnit> = {}): WorkUnit => ({
  name: "unit",
  status: "pending",
  confidence: 1,
  gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
  resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  ...over,
});

/** Brief fixture: one claude unit WITH resources, one codex unit WITHOUT (legacy state file). */
const twoUnitState = (): WorkflowState => ({
  task_id: "T1",
  goal: "g",
  success_criteria: [],
  totals: { units: 2, done: 1, tokens: 1200, cost_usd: 0.5, wall_seconds: 30 },
  work_units: [
    unit({
      name: "alpha",
      status: "done",
      engine: "claude",
      resources: { agents: 1, tokens: 1200, cost_usd: 0.5, wall_seconds: 30 },
    }),
    {
      ...unit({ name: "beta", status: "running", engine: "codex" }),
      resources: undefined,
    } as never,
  ],
});

describe("buildResourceSnapshot", () => {
  test("passes totals through, stamps sampledAt from the injected now, and rolls up per engine by cost", () => {
    const snap = buildResourceSnapshot(twoUnitState(), { now: NOW });
    expect(snap.schemaVersion).toBe(RESOURCE_SNAPSHOT_SCHEMA_VERSION);
    expect(snap.schemaVersion).toBe(1);
    expect(snap.source).toBe("workflow-state");
    expect(snap.sampledAt).toBe(NOW.toISOString());
    expect(snap.totals).toEqual({
      units: 2,
      done: 1,
      tokens: 1200,
      cost_usd: 0.5,
      wall_seconds: 30,
    });
    expect(snap.perEngine).toEqual([
      { engine: "claude", units: 1, done: 1, tokens: 1200, cost_usd: 0.5, wall_seconds: 30 },
      { engine: "codex", units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    ]);
  });

  test("lists units missing resources as zeros and still includes them", () => {
    const snap = buildResourceSnapshot(twoUnitState(), { now: NOW });
    expect(snap.units).toEqual([
      {
        name: "alpha",
        status: "done",
        engine: "claude",
        tokens: 1200,
        cost_usd: 0.5,
        wall_seconds: 30,
      },
      { name: "beta", status: "running", engine: "codex", tokens: 0, cost_usd: 0, wall_seconds: 0 },
    ]);
    expect(snap.warnings).toEqual(["1 units on codex have no recorded resources"]);
  });

  test("warns once per engine, counting every zero-resource unit", () => {
    const state: WorkflowState = {
      ...twoUnitState(),
      work_units: [unit({ name: "a", engine: "codex" }), unit({ name: "b", engine: "codex" })],
    };
    const snap = buildResourceSnapshot(state, { now: NOW });
    expect(snap.warnings).toEqual(["2 units on codex have no recorded resources"]);
  });

  test("buckets units without an engine under unknown", () => {
    const state: WorkflowState = {
      ...twoUnitState(),
      work_units: [
        unit({
          name: "solo",
          resources: { agents: 1, tokens: 5, cost_usd: 0.01, wall_seconds: 2 },
        }),
      ],
    };
    const snap = buildResourceSnapshot(state, { now: NOW });
    expect(snap.perEngine).toEqual([
      { engine: "unknown", units: 1, done: 0, tokens: 5, cost_usd: 0.01, wall_seconds: 2 },
    ]);
    expect(snap.units).toEqual([
      { name: "solo", status: "pending", engine: null, tokens: 5, cost_usd: 0.01, wall_seconds: 2 },
    ]);
    expect(snap.warnings).toEqual([]);
  });

  test("views quota statuses and warns on warning/exhausted/rate-limited levels", () => {
    const snap = buildResourceSnapshot(twoUnitState(), {
      now: NOW,
      quota: [
        {
          engine: "claude",
          status: { level: "warning", percentRemaining: 12.4, resetAt: "2026-10-09T06:00:00.000Z" },
        },
        { engine: "codex", status: { level: "ready" } },
        { engine: "opencode", status: { level: "exhausted" } },
        { engine: "copilot", status: { level: "rate-limited", percentRemaining: 0 } },
      ],
    });
    expect(snap.quota).toEqual([
      {
        engine: "claude",
        sampledAt: NOW.toISOString(),
        level: "warning",
        percentRemaining: 12.4,
        resetAt: "2026-10-09T06:00:00.000Z",
      },
      { engine: "codex", sampledAt: NOW.toISOString(), level: "ready" },
      { engine: "opencode", sampledAt: NOW.toISOString(), level: "exhausted" },
      {
        engine: "copilot",
        sampledAt: NOW.toISOString(),
        level: "rate-limited",
        percentRemaining: 0,
      },
    ]);
    expect(snap.warnings).toEqual([
      "1 units on codex have no recorded resources",
      "claude: warning (12% remaining), resets 2026-10-09T06:00:00.000Z",
      "opencode: exhausted",
      "copilot: rate-limited (0% remaining)",
    ]);
  });

  test("provenance lanes are disjoint; quota probe flips unavailable to empty", () => {
    const snap = buildResourceSnapshot(twoUnitState(), { now: NOW });
    expect(snap.provenance).toEqual({
      exact: ["units", "done", "wall_seconds"],
      estimated: ["tokens", "cost_usd"],
      unavailable: ["quota (no verified probe command)"],
    });
    const { exact, estimated, unavailable } = snap.provenance;
    const overlap = (a: string[], b: string[]) => a.filter((x) => b.includes(x));
    expect(overlap(exact, estimated)).toEqual([]);
    expect(overlap(exact, unavailable)).toEqual([]);
    expect(overlap(estimated, unavailable)).toEqual([]);
    expect(overlap(overlap(exact, estimated), unavailable)).toEqual([]);

    // An empty probe list never ran a probe — still unavailable.
    const emptyProbe = buildResourceSnapshot(twoUnitState(), { now: NOW, quota: [] });
    expect(emptyProbe.provenance.unavailable).toEqual(["quota (no verified probe command)"]);

    const probed = buildResourceSnapshot(twoUnitState(), {
      now: NOW,
      quota: [{ engine: "codex", status: { level: "ready" } }],
    });
    expect(probed.provenance.unavailable).toEqual([]);
  });

  test("legacy state without work_units decodes as an empty ledger — no throw, empty projections", () => {
    const legacy = {
      task_id: "T-legacy",
      goal: "g",
      success_criteria: [],
      totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    } as unknown as WorkflowState;
    expect(legacy.work_units).toBeUndefined();
    const snap = buildResourceSnapshot(legacy, { now: NOW });
    expect(snap.units).toEqual([]);
    expect(snap.perEngine).toEqual([]);
    expect(snap.warnings).toEqual([]);
    expect(snap.totals).toEqual({
      units: 0,
      done: 0,
      tokens: 0,
      cost_usd: 0,
      wall_seconds: 0,
    });
  });

  test("legacy state missing both work_units and totals projects as an empty ledger", () => {
    const legacy = {
      task_id: "T-legacy",
      goal: "g",
      success_criteria: [],
    } as unknown as WorkflowState;
    const snap = buildResourceSnapshot(legacy, { now: NOW });
    expect(snap.units).toEqual([]);
    expect(snap.perEngine).toEqual([]);
    expect(snap.totals).toEqual({
      units: 0,
      done: 0,
      tokens: 0,
      cost_usd: 0,
      wall_seconds: 0,
    });
  });

  test("sampledAt falls back to the current time when no now is injected", () => {
    const before = Date.now();
    const snap = buildResourceSnapshot(twoUnitState());
    const after = Date.now();
    const at = Date.parse(snap.sampledAt);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });
});
