import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logbus, setLogbusForTests } from "../../src/logbus";
import { applyStuckDetection } from "../../src/orchestrator/stuck-wire";

describe("applyStuckDetection", () => {
  test("no logbus => noop subscription, finish returns reasons", () => {
    const h = applyStuckDetection({ name: "u1", evidence: ["e1"] }, { stallSeconds: 1 });
    // Without logbus, the subscribe never fires
    const reasons = h.finish(1);
    expect(Array.isArray(reasons)).toBe(true);
    h.unsub(); // noop
    expect(h.detector).toBeDefined();
  });

  test("with logbus: writes matching unit name are recorded as outputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "st-wire-"));
    const bus = new Logbus({ runId: "test", dir });
    setLogbusForTests(bus);
    try {
      const h = applyStuckDetection({ name: "u1", evidence: ["e1"] }, { loopThreshold: 2 }, bus);
      // Emit 2 identical engine-stdout events for unit u1
      bus.write({
        runId: "test",
        channel: "engine-stdout",
        level: "info",
        text: "repeat",
        unit: "u1",
      });
      bus.write({
        runId: "test",
        channel: "engine-stdout",
        level: "info",
        text: "repeat",
        unit: "u1",
      });
      const reasons = h.finish(1);
      expect(reasons.some((r) => r.startsWith("looping"))).toBe(true);
      h.unsub();
    } finally {
      setLogbusForTests(null);
      bus.close();
    }
  });

  test("with logbus: events for OTHER units are ignored (filter)", () => {
    const dir = mkdtempSync(join(tmpdir(), "st-wire-filt-"));
    const bus = new Logbus({ runId: "test", dir });
    setLogbusForTests(bus);
    try {
      const h = applyStuckDetection({ name: "u1", evidence: ["e1"] }, { loopThreshold: 2 }, bus);
      // Emit matching events for u1 (should be recorded) and u2 (should be ignored)
      bus.write({
        runId: "test",
        channel: "engine-stdout",
        level: "info",
        text: "unique",
        unit: "u1",
      });
      bus.write({
        runId: "test",
        channel: "engine-stdout",
        level: "info",
        text: "unique",
        unit: "u2",
      });
      const reasons = h.finish(5);
      // Only 1 output for u1 means no looping; evidence changed (1→5) so not evidence-stuck
      expect(reasons.some((r) => r.startsWith("looping"))).toBe(false);
      h.unsub();
    } finally {
      setLogbusForTests(null);
      bus.close();
    }
  });

  test("finish returns evidence-stuck when evidence unchanged", () => {
    const h = applyStuckDetection({ name: "u1", evidence: ["e1"] }, { evidenceStallRounds: 0 });
    const reasons = h.finish(1);
    expect(reasons.some((r) => r.startsWith("evidence-stuck"))).toBe(true);
    h.unsub();
  });
});
