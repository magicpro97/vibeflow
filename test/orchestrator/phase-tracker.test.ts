import { describe, expect, test } from "bun:test";
import { makePhaseTracker, makeProgressReporter } from "../../src/orchestrator/phase-tracker.js";
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

  describe("render footer (#523)", () => {
    test("cost_usd, tokens, elapsed all render when passed", () => {
      const t = makePhaseTracker(1);
      const r = t.render({ cost_usd: 1.5, tokens: 2500, elapsed: 42 });
      expect(r).toContain("$1.50");
      expect(r).toContain("2500 tok");
      expect(r).toContain("42s");
    });

    test("cost_usd only renders alone", () => {
      const t = makePhaseTracker(1);
      const r = t.render({ cost_usd: 0.99 });
      expect(r).toContain("$0.99");
      expect(r).not.toContain("tok");
      expect(r).not.toContain("s)");
    });

    test("tokens only renders alone", () => {
      const t = makePhaseTracker(1);
      const r = t.render({ tokens: 500 });
      expect(r).toContain("500 tok");
      expect(r).not.toContain("$");
    });

    test("elapsed only renders alone", () => {
      const t = makePhaseTracker(1);
      const r = t.render({ elapsed: 7 });
      expect(r).toContain("7s");
      expect(r).not.toContain("$");
      expect(r).not.toContain("tok");
    });

    test("all omitted when no-arg render", () => {
      const t = makePhaseTracker(1);
      const r = t.render();
      expect(r).not.toContain("$");
      expect(r).not.toContain("tok");
      expect(r).not.toContain("s)");
    });
  });

  describe("makeProgressReporter", () => {
    test("start event delegates to onStart, not the render path", () => {
      const t = makePhaseTracker(2);
      let started: ProgressEvent | undefined;
      const report = makeProgressReporter(t, Date.now(), (e) => {
        started = e;
      });
      report(ev({ phase: "start", unit: "a" }));
      expect(started?.unit).toBe("a");
    });

    test("non-TTY done event accumulates cost/tokens and emits via out()", () => {
      const t = makePhaseTracker(2);
      const orig = process.stdout.isTTY;
      // Force the non-TTY branch (out path).
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      try {
        const report = makeProgressReporter(t, Date.now(), () => {});
        report(ev({ phase: "done", unit: "a", pass: true, cost_usd: 0.5, tokens: 100 }));
        report(ev({ phase: "done", unit: "b", pass: true, cost_usd: 0.25, tokens: 50 }));
        // Accumulated footer visible on the tracker render.
        const line = t.render({ cost_usd: 0.75, tokens: 150, elapsed: 0 });
        expect(line).toContain("$0.75");
        expect(line).toContain("150 tok");
      } finally {
        Object.defineProperty(process.stdout, "isTTY", { value: orig, configurable: true });
      }
    });

    test("TTY done event self-redraws via stdout.write", () => {
      const t = makePhaseTracker(1);
      const orig = process.stdout.isTTY;
      const origWrite = process.stdout.write.bind(process.stdout);
      let captured = "";
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      // biome-ignore lint/suspicious/noExplicitAny: test stub for stdout.write
      process.stdout.write = ((s: string) => {
        captured += s;
        return true;
      }) as any;
      try {
        const report = makeProgressReporter(t, Date.now(), () => {});
        report(ev({ phase: "done", unit: "a", pass: true }));
        expect(captured).toContain("\x1b[2K\r");
      } finally {
        process.stdout.write = origWrite;
        Object.defineProperty(process.stdout, "isTTY", { value: orig, configurable: true });
      }
    });

    test("done event without cost/tokens leaves accumulators at zero", () => {
      const t = makePhaseTracker(1);
      const orig = process.stdout.isTTY;
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      try {
        const report = makeProgressReporter(t, Date.now(), () => {});
        report(ev({ phase: "done", unit: "a", pass: true }));
        // no throw; footer with zero accumulators still renders
        expect(t.render({ cost_usd: 0, tokens: 0, elapsed: 0 })).toContain("$0.00");
      } finally {
        Object.defineProperty(process.stdout, "isTTY", { value: orig, configurable: true });
      }
    });
  });
});
