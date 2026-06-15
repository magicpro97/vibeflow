import { describe, expect, test } from "bun:test";
import type { UnitProposal } from "../src/orchestrator/plan.js";
import { planWorkUnits, scheduleWaves } from "../src/orchestrator/plan.js";

describe("planWorkUnits", () => {
  test("returns ok=true when all scopes are disjoint", () => {
    const proposals: UnitProposal[] = [
      { name: "a", scope: ["src/a/"] },
      { name: "b", scope: ["src/b/"] },
      { name: "c", scope: ["src/c/"] },
    ];
    const result = planWorkUnits(proposals);
    expect(result.ok).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.units).toHaveLength(3);
    // Each unit gets the default gates + resources scaffolding
    expect(result.units[0]?.gates).toEqual({
      build: "pending",
      lint: "pending",
      test: "pending",
      review: "pending",
    });
    expect(result.units[0]?.resources).toEqual({
      agents: 0,
      tokens: 0,
      cost_usd: 0,
      wall_seconds: 0,
    });
    expect(result.units[0]?.status).toBe("pending");
    expect(result.units[0]?.confidence).toBe(0);
  });

  test("returns ok=false and lists conflicts when scopes overlap", () => {
    const proposals: UnitProposal[] = [
      { name: "a", scope: ["src/shared/"] },
      { name: "b", scope: ["src/shared/other.ts"] },
    ];
    const result = planWorkUnits(proposals);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual([["a", "b"]]);
    expect(result.units).toHaveLength(2);
  });

  test("preserves proposal fields and defaults confidence to 0", () => {
    const proposals: UnitProposal[] = [
      {
        name: "x",
        scope: ["src/x/"],
        owner_agent: "claude",
        confidence: 0.75,
        acceptance_signal: "tests pass",
        depends_on: ["y"],
      },
    ];
    const result = planWorkUnits(proposals);
    const u = result.units[0];
    expect(u?.name).toBe("x");
    expect(u?.owner_agent).toBe("claude");
    expect(u?.confidence).toBe(0.75);
    expect(u?.scope).toEqual(["src/x/"]);
  });

  test("returns ok=true with empty units for an empty proposal list", () => {
    const result = planWorkUnits([]);
    expect(result.ok).toBe(true);
    expect(result.units).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });
});

describe("scheduleWaves", () => {
  test("returns no waves for an empty proposal list", () => {
    expect(scheduleWaves([])).toEqual([]);
  });

  test("groups independent units into a single wave", () => {
    const proposals: UnitProposal[] = [
      { name: "a", scope: ["src/a/"] },
      { name: "b", scope: ["src/b/"] },
    ];
    const waves = scheduleWaves(proposals);
    // First (and only) wave contains both names, in proposals order.
    expect(waves).toEqual([["a", "b"]]);
  });

  test("orders units into sequential waves by dependency", () => {
    const proposals: UnitProposal[] = [
      { name: "a", scope: ["src/a/"], depends_on: ["b"] },
      { name: "b", scope: ["src/b/"], depends_on: ["c"] },
      { name: "c", scope: ["src/c/"] },
    ];
    const waves = scheduleWaves(proposals);
    expect(waves).toEqual([["c"], ["b"], ["a"]]);
  });

  test("treats missing depends_on as no dependencies", () => {
    const proposals: UnitProposal[] = [
      { name: "a", scope: ["src/a/"] },
      { name: "b", scope: ["src/b/"] },
    ];
    // No depends_on field at all — both should land in the first wave.
    const waves = scheduleWaves(proposals);
    expect(waves).toEqual([["a", "b"]]);
  });

  test("treats empty depends_on array as no dependencies", () => {
    const proposals: UnitProposal[] = [
      { name: "a", scope: ["src/a/"], depends_on: [] },
      { name: "b", scope: ["src/b/"], depends_on: [] },
    ];
    const waves = scheduleWaves(proposals);
    expect(waves).toEqual([["a", "b"]]);
  });

  test("flattens cycles / missing deps into a residual wave (no hang)", () => {
    // A depends on B, B depends on A — pure cycle. The function must
    // emit a residual wave rather than loop forever.
    const proposals: UnitProposal[] = [
      { name: "a", scope: ["src/a/"], depends_on: ["b"] },
      { name: "b", scope: ["src/b/"], depends_on: ["a"] },
    ];
    const waves = scheduleWaves(proposals);
    // On the first iteration, no unit's deps are satisfied (the cycle
    // has not been broken), so the function emits the remaining names
    // as a single residual wave and breaks.
    expect(waves).toHaveLength(1);
    expect(waves[0]?.slice().sort()).toEqual(["a", "b"]);
  });

  test("emits residual wave when a dep name is missing from the proposals", () => {
    // "a" depends on "ghost" which is never declared. After "ghost"
    // can't be satisfied, both names should still come out — one as
    // a residual wave after the first empty wave.
    const proposals: UnitProposal[] = [
      { name: "a", scope: ["src/a/"], depends_on: ["ghost"] },
      { name: "b", scope: ["src/b/"] },
    ];
    const waves = scheduleWaves(proposals);
    // "b" is independent and lands in the first wave; "a" is stuck
    // (its dep "ghost" never appears) and lands in the residual wave.
    expect(waves[0]).toEqual(["b"]);
    expect(waves[1]).toEqual(["a"]);
  });

  test("handles a mix of independent, chained, and cyclic units", () => {
    const proposals: UnitProposal[] = [
      { name: "ind1", scope: ["src/ind1/"] },
      { name: "ind2", scope: ["src/ind2/"] },
      { name: "top", scope: ["src/top/"], depends_on: ["mid"] },
      { name: "mid", scope: ["src/mid/"], depends_on: ["bot"] },
      { name: "bot", scope: ["src/bot/"] },
      { name: "loopA", scope: ["src/loopA/"], depends_on: ["loopB"] },
      { name: "loopB", scope: ["src/loopB/"], depends_on: ["loopA"] },
    ];
    const waves = scheduleWaves(proposals);
    // First wave: the three truly-ready units (ind1, ind2, bot).
    expect(waves[0]?.slice().sort()).toEqual(["bot", "ind1", "ind2"]);
    // Second wave: mid (now that bot is done).
    expect(waves[1]).toEqual(["mid"]);
    // Third wave: top (now that mid is done).
    expect(waves[2]).toEqual(["top"]);
    // Fourth wave: the cycle residual (loopA, loopB) — every name must
    // appear exactly once across the whole schedule.
    const flattened = waves.flat();
    expect(flattened.slice().sort()).toEqual([
      "bot",
      "ind1",
      "ind2",
      "loopA",
      "loopB",
      "mid",
      "top",
    ]);
    // No duplicates.
    expect(new Set(flattened).size).toBe(flattened.length);
  });
});
