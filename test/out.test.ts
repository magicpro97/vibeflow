import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEvent, Logbus, getLogbus, out, setLogbusForTests } from "../src/logbus.js";
import { resetActiveSpinner } from "../src/ui.js";

function newBus(): { bus: Logbus; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vf-out-"));
  const bus = new Logbus({ runId: "out-test", dir });
  return {
    bus,
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe("out()", () => {
  beforeEach(() => {
    resetActiveSpinner();
  });
  afterEach(() => setLogbusForTests(null));

  it("joins multiple parts with a single space (console.log semantics)", () => {
    const { bus, cleanup } = newBus();
    setLogbusForTests(bus);
    try {
      const seen: LogEvent[] = [];
      bus.subscribe((ev) => seen.push(ev));
      out("vf", "hello", "world", 42, { a: 1 });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.text).toBe('hello world 42 {"a":1}');
    } finally {
      cleanup();
    }
  });

  it("attaches the correct channel and default level=info", () => {
    const { bus, cleanup } = newBus();
    setLogbusForTests(bus);
    try {
      const seen: LogEvent[] = [];
      bus.subscribe((ev) => seen.push(ev));
      out("engine-stdout", "tick");
      expect(seen[0]?.channel).toBe("engine-stdout");
      expect(seen[0]?.level).toBe("info");
    } finally {
      cleanup();
    }
  });

  it("attaches the active bus's runId", () => {
    const { bus, cleanup } = newBus();
    setLogbusForTests(bus);
    try {
      const seen: LogEvent[] = [];
      bus.subscribe((ev) => seen.push(ev));
      out("vf", "tagged");
      expect(seen[0]?.runId).toBe("out-test");
    } finally {
      cleanup();
    }
  });

  it("falls back to console.log (no prefix) for default level=info when no bus is installed", () => {
    setLogbusForTests(null);
    expect(getLogbus()).toBeNull();
    const captured: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      captured.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
    };
    try {
      out("vf", "no-bus-fallback", "with", "parts");
      const joined = captured.join("\n");
      expect(joined).toContain("no-bus-fallback with parts");
      expect(joined).not.toContain("[vf]");
    } finally {
      console.log = orig;
    }
  });

  it("falls back to console.error (with [channel] prefix) for level=warn|error|debug when no bus is installed", () => {
    setLogbusForTests(null);
    expect(getLogbus()).toBeNull();
    const captured: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      captured.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
    };
    try {
      out("vf", "error-line", { level: "error" });
      out("vf", "warn-line", { level: "warn" });
      out("vf", "debug-line", { level: "debug" });
      const joined = captured.join("\n");
      expect(joined).toContain("[vf] error-line");
      expect(joined).toContain("[vf] warn-line");
      expect(joined).toContain("[vf] debug-line");
    } finally {
      console.error = orig;
    }
  });

  it("writes the event to the bus's JSONL file (integration with current.log)", async () => {
    const { bus, dir, cleanup } = newBus();
    setLogbusForTests(bus);
    try {
      out("vf", "persisted-line");
      await bus.close();
      const content = readFileSync(join(dir, "current.log"), "utf8");
      expect(content).toContain("persisted-line");
      const ev = JSON.parse(content.trim().split("\n").pop() as string) as LogEvent;
      expect(ev.text).toBe("persisted-line");
      expect(ev.channel).toBe("vf");
    } finally {
      cleanup();
    }
  });

  it("never throws on out() — even with a busted bus reference", () => {
    // A bus that throws on subscribe; out() should still not throw.
    const bus = {
      runId: "broken",
      write: () => {
        throw new Error("simulated bus failure");
      },
    } as unknown as Logbus;
    setLogbusForTests(bus);
    expect(() => out("vf", "should not throw")).not.toThrow();
    setLogbusForTests(null);
  });
});
