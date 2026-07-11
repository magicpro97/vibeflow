import { describe, expect, test } from "bun:test";
import { makePhaseTracker } from "../../src/orchestrator/phase-tracker.js";
import type { ProgressEvent } from "../../src/orchestrator/run.js";

function ev(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    phase: "start",
    unit: "a",
    index: 0,
    total: 2,
    ...overrides,
  };
}

describe("makePhaseTracker", () => {
  test("snapshot reflects start and done events", () => {
    const t = makePhaseTracker(2);
    t.onProgress(ev({ phase: "start", unit: "a", index: 0, total: 2 }));
    t.onProgress(ev({ phase: "start", unit: "b", index: 1, total: 2 }));
    t.onProgress(ev({ phase: "done", unit: "a", index: 0, total: 2, pass: true }));
    t.onProgress(ev({ phase: "done", unit: "b", index: 1, total: 2, pass: false }));

    const snap = t.snapshot();
    expect(snap.total).toBe(2);
    expect(snap.done).toBe(2);
    expect(snap.units).toHaveLength(2);

    const a = snap.units.find((u) => u.unit === "a");
    const b = snap.units.find((u) => u.unit === "b");
    expect(a?.phase).toBe("done");
    expect(a?.pass).toBe(true);
    expect(b?.phase).toBe("done");
    expect(b?.pass).toBe(false);
  });

  test("render shows ✓ for done+pass, • for done+!pass", () => {
    const t = makePhaseTracker(2);
    t.onProgress(ev({ phase: "start", unit: "a", index: 0, total: 2 }));
    t.onProgress(ev({ phase: "start", unit: "b", index: 1, total: 2 }));
    t.onProgress(ev({ phase: "done", unit: "a", index: 0, total: 2, pass: true }));
    t.onProgress(ev({ phase: "done", unit: "b", index: 1, total: 2, pass: false }));

    const r = t.render();
    expect(r).toContain("[2/2]");
    expect(r).toContain("✓");
    expect(r).toContain("•");
  });

  test("unit with only start is running", () => {
    const t = makePhaseTracker(3);
    t.onProgress(ev({ phase: "start", unit: "a", index: 0, total: 3 }));
    t.onProgress(ev({ phase: "start", unit: "b", index: 1, total: 3 }));
    t.onProgress(ev({ phase: "done", unit: "a", index: 0, total: 3, pass: true }));

    const snap = t.snapshot();
    expect(snap.total).toBe(3);
    expect(snap.done).toBe(1);

    const b = snap.units.find((u) => u.unit === "b");
    expect(b?.phase).toBe("running");
    expect(b?.startedAt).toBeDefined();

    const c = snap.units.find((u) => u.unit === "c");
    expect(c).toBeUndefined();

    const r = t.render();
    expect(r).toContain("[1/3]");
    expect(r).toContain("▶");
  });

  test("render shows elapsed seconds for running units", () => {
    let clock = 1000;
    const now = () => clock;

    const t = makePhaseTracker(2, now);
    t.onProgress(ev({ phase: "start", unit: "a", index: 0, total: 2 }));

    clock = 4500; // 3.5s elapsed
    const r1 = t.render();
    expect(r1).toMatch(/\(3s\)/);

    clock = 6500; // 5.5s → floor 5s
    const r2 = t.render();
    expect(r2).toMatch(/\(5s\)/);
  });

  test("render for start-only units (no done yet) shows pending glyph for unseen", () => {
    const t = makePhaseTracker(4);
    t.onProgress(ev({ phase: "start", unit: "a", index: 0, total: 4 }));
    t.onProgress(ev({ phase: "done", unit: "a", index: 0, total: 4, pass: true }));

    // units b,c,d not seen → pending
    const r = t.render();
    expect(r).toContain("[1/4]");
    // render shows all 4 positions (total=4)
    expect(r).toContain("·");
  });

  test("snapshot after only done (no start) still records unit", () => {
    const t = makePhaseTracker(2);
    t.onProgress(ev({ phase: "done", unit: "a", index: 0, total: 2, pass: true }));
    const snap = t.snapshot();
    expect(snap.done).toBe(1);
    const a = snap.units.find((u) => u.unit === "a");
    expect(a?.phase).toBe("done");
    expect(a?.pass).toBe(true);
  });

  test("render() with cost/token/elapsed appends stats", () => {
    const t = makePhaseTracker(2);
    t.onProgress(ev({ phase: "start", unit: "a" }));
    t.onProgress(ev({ phase: "done", unit: "a", pass: true }));

    const r = t.render({ cost_usd: 0.04, tokens: 18300 }, "12s");
    expect(r).toContain("$0.04");
    expect(r).toContain("18k tok");
    expect(r).toContain("12s");
  });

  test("render() with no args unchanged (back-compat)", () => {
    const t = makePhaseTracker(2);
    t.onProgress(ev({ phase: "start", unit: "a" }));
    t.onProgress(ev({ phase: "done", unit: "a", pass: true }));

    const r = t.render();
    expect(r).not.toContain("$");
    expect(r).toContain("[1/2]");
  });
});
