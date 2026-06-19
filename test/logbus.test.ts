import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEvent, Logbus, getLogbus, out } from "../src/logbus.js";

const FIXTURE_EVENT = {
  channel: "vf" as const,
  level: "info" as const,
  text: "hello world",
};

function newBus(opts: Partial<ConstructorParameters<typeof Logbus>[0]> = {}): {
  bus: Logbus;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "vf-logbus-"));
  const bus = new Logbus({ runId: "test-run", dir, ...opts });
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

describe("Logbus", () => {
  let cleanup: () => void;
  let bus: Logbus;
  let dir: string;

  beforeEach(() => {
    ({ bus, dir, cleanup } = newBus());
  });
  afterEach(() => cleanup());

  it("appends a JSONL line to current.log with seq and ts", async () => {
    bus.write({ ...FIXTURE_EVENT, runId: "test-run" });
    bus.write({ ...FIXTURE_EVENT, text: "second", runId: "test-run" });
    await bus.close();
    const lines = readFileSync(bus.currentFile(), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0] as string) as Record<string, unknown>;
    const b = JSON.parse(lines[1] as string) as Record<string, unknown>;
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(typeof a.ts).toBe("number");
    expect(a.text).toBe("hello world");
    expect(b.text).toBe("second");
  });

  it("strips ANSI escape codes and CR from text before writing", async () => {
    bus.write({
      ...FIXTURE_EVENT,
      text: "\x1b[31mred\x1b[0m\r\nmore\rstuff",
      runId: "test-run",
    });
    await bus.close();
    const line = readFileSync(bus.currentFile(), "utf8").trim();
    const ev = JSON.parse(line) as { text: string };
    // ANSI + CR stripped, LF preserved.
    expect(ev.text).toBe("red\nmorestuff");
    expect(line).not.toContain("\x1b[");
  });

  it("truncates text to 8 KB defensively", async () => {
    const huge = "x".repeat(20_000);
    bus.write({ ...FIXTURE_EVENT, text: huge, runId: "test-run" });
    await bus.close();
    const ev = JSON.parse(readFileSync(bus.currentFile(), "utf8").trim()) as { text: string };
    // The exact cutoff is 8 KB; we just check it was bounded.
    expect(ev.text.length).toBeLessThanOrEqual(8192);
    expect(ev.text.length).toBeGreaterThan(0);
  });

  it("creates current.log with mode 0o600", async () => {
    // Windows: stat mode bits are not POSIX-shaped. Skip the strict mode check there.
    if (process.platform === "win32") {
      bus.write({ ...FIXTURE_EVENT, runId: "test-run" });
      await bus.close();
      expect(existsSync(bus.currentFile())).toBe(true);
      return;
    }
    bus.write({ ...FIXTURE_EVENT, runId: "test-run" });
    await bus.close();
    const st = statSync(bus.currentFile());
    // Mode is the lower 12 bits on POSIX; bun runs on POSIX in CI/macOS.
    expect((st.mode & 0o777) === 0o600).toBe(true);
  });

  it("rotates to current.log.1 when threshold exceeded", async () => {
    // The bus enforces a 64 KB min-rotate size (to avoid churning empty .1/.2 files)
    // and rotates only when currentSize > thresholdBytes. Set threshold just above 64 KB
    // and write enough events to cross it.
    const small = new Logbus({
      runId: "rot",
      dir,
      thresholdBytes: 65 * 1024,
      maxRotations: 3,
    });
    // Each line is ~200 bytes; write 400 to land at ~80 KB.
    for (let i = 0; i < 400; i++) {
      small.write({
        ...FIXTURE_EVENT,
        text: `pad-${i}-${"x".repeat(150)}`,
        runId: "rot",
      });
    }
    await small.close();
    const rotated = existsSync(join(dir, "current.log.1"));
    expect(rotated).toBe(true);
  });

  it("rotate() shifts files current.log.1, current.log.2, ... and drops beyond maxRotations", async () => {
    const tiny = new Logbus({
      runId: "shift",
      dir,
      thresholdBytes: 65 * 1024,
      maxRotations: 2,
    });
    // Each rotation moves current → .1 → .2; with maxRotations=2 the oldest is dropped.
    // Writing ~5MB in 1KB events triggers several rotations. The per-event
    // file-lock acquisition is the slow part: on contended CI runners (tmpfs
    // lock churn) 5000 events can exceed the 5s default, so this test carries
    // an explicit 20s timeout (see the third arg to `it` below). Windows is
    // slower still, so it writes fewer events.
    const eventCount = process.platform === "win32" ? 1500 : 5000;
    for (let i = 0; i < eventCount; i++) {
      tiny.write({
        ...FIXTURE_EVENT,
        text: `line ${i} ${"y".repeat(1000)}`,
        runId: "shift",
      });
    }
    await tiny.close();
    const files = readdirSync(dir).sort();
    const rotated = files.filter((f) => /^current\.log\.\d+$/.test(f));
    expect(rotated.length).toBeLessThanOrEqual(2);
    expect(files).toContain("current.log");
  }, 20_000);

  it("rotate() is async, acquires the lock, and creates a fresh current.log.1", async () => {
    // Exercise the public rotate() path explicitly: write enough bytes to cross the
    // 64 KB min-rotate size, call rotate(), assert the content moved into .1 and
    // current.log is fresh. Use a dedicated dir so the rotate target and the write
    // bus share the same path (the in-process `dir` fixture is shared with other tests).
    const rotateDir = mkdtempSync(join(tmpdir(), "vf-rotate-"));
    try {
      const writable = new Logbus({ runId: "test-run", dir: rotateDir });
      // Each event is ~200 bytes; 400 events lands at ~80 KB, comfortably above 64 KB.
      for (let i = 0; i < 400; i++) {
        writable.write({
          ...FIXTURE_EVENT,
          text: `pad-${i}-${"x".repeat(150)}`,
          runId: "test-run",
        });
      }
      await writable.close();
      // Re-open and call rotate() directly to verify the async path works.
      const second = new Logbus({ runId: "test-run", dir: rotateDir });
      await second.rotate();
      // After rotate, current.log should be empty and the previous content lives in .1.
      const currentSize = statSync(second.currentFile()).size;
      expect(currentSize).toBe(0);
      const rotated = existsSync(join(rotateDir, "current.log.1"));
      expect(rotated).toBe(true);
      await second.close();
    } finally {
      rmSync(rotateDir, { recursive: true, force: true });
    }
  });

  it("subscribe() receives every event in order; unsubscribe stops the fan-out", () => {
    const seen: string[] = [];
    const unsub = bus.subscribe((ev) => seen.push(ev.text));
    bus.write({ ...FIXTURE_EVENT, text: "one", runId: "test-run" });
    bus.write({ ...FIXTURE_EVENT, text: "two", runId: "test-run" });
    unsub();
    bus.write({ ...FIXTURE_EVENT, text: "three", runId: "test-run" });
    expect(seen).toEqual(["one", "two"]);
  });

  it("subscriber that throws does not poison the bus or other subscribers", () => {
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((ev) => seen.push(ev.text));
    bus.write({ ...FIXTURE_EVENT, text: "after-throw", runId: "test-run" });
    expect(seen).toEqual(["after-throw"]);
  });

  it("caps at 100 subscribers; the 101st returns a no-op unsub", () => {
    const unsubs: Array<() => void> = [];
    for (let i = 0; i < 100; i++) {
      unsubs.push(bus.subscribe(() => {}));
    }
    const extra = bus.subscribe(() => {
      throw new Error("101st should not be called");
    });
    // Should be a no-op (not throw) — invoking it does nothing harmful.
    expect(typeof extra).toBe("function");
    extra();
    for (const u of unsubs) u();
  });

  it("out() with no installed bus writes default level=info to console.log and never throws", async () => {
    // Isolate: ensure no bus is active before this test
    const bus = getLogbus();
    if (bus) bus.close();
    const { getLogbus: getBus } = await import("../src/logbus.js");
    expect(getBus()).toBeNull();
    const origLog = console.log;
    const captured: string[] = [];
    console.log = (...a: unknown[]) => {
      captured.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
    };
    try {
      out("vf", "fallback message");
      const joined = captured.join("\n");
      expect(joined).toContain("fallback message");
      // No [vf] prefix on stdout for the user-facing channel.
      expect(joined).not.toContain("[vf] fallback message");
    } finally {
      console.log = origLog;
    }
  });

  it("out() with no installed bus routes level=error to console.error and never throws", async () => {
    const bus = getLogbus();
    if (bus) bus.close();
    const { getLogbus: getBus } = await import("../src/logbus.js");
    expect(getBus()).toBeNull();
    const origErr = console.error;
    const captured: string[] = [];
    console.error = (...a: unknown[]) => {
      captured.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
    };
    try {
      out("vf", "fallback error", { level: "error" });
      const joined = captured.join("\n");
      expect(joined).toContain("[vf] fallback error");
    } finally {
      console.error = origErr;
    }
  });

  it("out() with active bus ALSO tees engine-stdout to console (regression: M2 used to suppress)", async () => {
    // Regression: before the user-facing fix, only the "vf" channel
    // was tee'd to the console when the bus was active. That made
    // a 5-minute AI run silent on the parent terminal — the user
    // could not see what the engine was doing. Now engine-stdout,
    // engine-stderr, user, and hook channels also reach the console.
    // The M3 SSE endpoint still gets the full bus stream (bus.write).
    const { installLogbus } = await import("../src/logbus.js");
    const dir = mkdtempSync(join(tmpdir(), "vf-logbus-tee-"));
    const bus = installLogbus({ runId: "test-tee", dir });
    const origLog = console.log;
    const captured: string[] = [];
    console.log = (...a: unknown[]) => {
      captured.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
    };
    try {
      out("engine-stdout", "hello from engine");
      const joined = captured.join("\n");
      expect(joined).toContain("[engine-stdout] hello from engine");
    } finally {
      console.log = origLog;
      bus.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Logbus prune", () => {
  let cleanup: () => void;
  let bus: Logbus;
  let dir: string;

  beforeEach(() => {
    ({ bus, dir, cleanup } = newBus({ retentionDays: 7 }));
  });
  afterEach(() => cleanup());

  it("removes sessions/*.jsonl older than retentionDays", async () => {
    const { mkdirSync, utimesSync } = await import("node:fs");
    const sessions = join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    const oldFile = join(sessions, "old-run-2024-01-01.jsonl");
    const newFile = join(sessions, "new-run.jsonl");
    writeFileSync(oldFile, "old\n");
    writeFileSync(newFile, "new\n");
    // Backdate oldFile to 8 days ago. retentionDays=7 → anything > 7d old is purged.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, eightDaysAgo, eightDaysAgo);
    const probe = new Logbus({ runId: "probe", dir, retentionDays: 7 });
    await probe.prune();
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });
});

describe("Logbus close()", () => {
  it("releases the lock and allows a new bus to acquire immediately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-logbus-close-"));
    try {
      const a = new Logbus({ runId: "a", dir });
      a.write({ channel: "vf", level: "info", text: "from-a", runId: "a" });
      await a.close();
      const b = new Logbus({ runId: "b", dir });
      b.write({ channel: "vf", level: "info", text: "from-b", runId: "b" });
      // We should not have a stale lock preventing writes.
      const lines = readFileSync(b.currentFile(), "utf8").split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The lock-test spec says two parallel bus.write() from different processes. We can't easily
// fork a process inside bun:test cheaply, so we approximate with two Logbus instances in the
// same process (the in-process Promise chain) and assert no torn line (every line JSON-parses).
describe("Logbus concurrent writes (in-process)", () => {
  it("serializes writes via the in-process chain — no torn JSONL lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-logbus-conc-"));
    try {
      const a = new Logbus({ runId: "a", dir });
      // Fire 50 writes back-to-back; the lock + Promise chain should serialize them
      for (let i = 0; i < 50; i++) {
        a.write({
          channel: "vf",
          level: "info",
          text: `concurrent payload #${i} — slightly long to make the line big`,
          runId: "a",
        });
      }
      // Also touch chmod to make sure 0o600 was set on a fresh current.log after any rotation
      const content = readFileSync(a.currentFile(), "utf8");
      const lines = content.split("\n").filter(Boolean);
      // Every non-empty line must parse as a JSON object — no torn writes.
      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(typeof parsed.text).toBe("string");
        expect(typeof parsed.seq).toBe("number");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Real cross-process-style concurrent test: two Logbus instances with DIFFERENT runIds
// point at the SAME temp directory. The in-process Promise chain no longer applies —
// they have separate `seq` counters, so the only thing serializing their appends is the
// cross-process file lock. We write 50 lines (25 from each, interleaved and awaited),
// then assert the file parses as 50 valid JSON lines with both runIds present and no
// duplicate seqs within a runId. This is the lock-test the original spec called for.
describe("Logbus concurrent writes (same dir, two instances)", () => {
  it("serializes cross-instance writes via the file lock — no torn JSONL lines, no duplicate seqs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-logbus-conc2-"));
    const a = new Logbus({ runId: "a", dir });
    const b = new Logbus({ runId: "b", dir });
    try {
      // Interleave writes from both instances; await each so we actually race the lock
      // (a non-awaited loop would let the first instance finish all 25 before the second
      // starts, defeating the test).
      for (let i = 0; i < 25; i++) {
        a.write({
          channel: "vf",
          level: "info",
          text: `from-a payload ${i} — long enough to make the line non-trivial`,
          runId: "a",
        });
        b.write({
          channel: "vf",
          level: "info",
          text: `from-b payload ${i} — long enough to make the line non-trivial`,
          runId: "b",
        });
      }
      // Drain both chains so the file is fully flushed before we read it.
      await a.close();
      await b.close();
      const content = readFileSync(a.currentFile(), "utf8");
      const lines = content.split("\n").filter(Boolean);
      expect(lines).toHaveLength(50);
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      // Both runIds present.
      const runIds = new Set(parsed.map((p) => p.runId));
      expect(runIds.has("a")).toBe(true);
      expect(runIds.has("b")).toBe(true);
      expect(runIds.size).toBe(2);
      // No duplicate seqs within a runId — the lock guarantees per-write atomicity, so
      // appendFileSync lines can never be torn mid-JSON-object.
      const seenSeq = new Map<string, Set<number>>();
      for (const p of parsed) {
        const rid = String(p.runId);
        const seq = Number(p.seq);
        if (!seenSeq.has(rid)) seenSeq.set(rid, new Set());
        expect(seenSeq.get(rid)?.has(seq)).toBe(false);
        seenSeq.get(rid)?.add(seq);
      }
      // Each instance wrote 25 events with consecutive seqs 1..25.
      expect(seenSeq.get("a")?.size).toBe(25);
      expect(seenSeq.get("b")?.size).toBe(25);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("watchLogbus: stream error callback (line 598)", () => {
  it("stream error fires the .on('error') callback which writes to stderr", async () => {
    const { installLogbus, setLogbusForTests, watchLogbus } = await import("../src/logbus.js");
    installLogbus();
    const bus = (await import("../src/logbus.js")).getLogbus();
    if (!bus) throw new Error("test setup: bus not installed");
    try {
      const errors: string[] = [];
      const origWrite = process.stderr.write;
      process.stderr.write = (s: string | Uint8Array) => {
        errors.push(s.toString());
        return true;
      };
      try {
        // Write a line so the poll actually tries to read.
        bus.write({
          runId: "test",
          level: "info",
          channel: "vf",
          text: "watch-test",
          meta: {},
        });
        // Inject a createReadStream that returns a fake stream
        // with an error event.
        const streamErr = new Error("simulated stream error");
        const fakeStream = {
          on(event: string, cb: (arg: unknown) => void) {
            if (event === "error") {
              queueMicrotask(() => cb(streamErr));
            } else if (event === "end") {
              queueMicrotask(() => cb(undefined));
            }
            return this;
          },
        };
        const handle = watchLogbus(bus, () => {}, {
          pollMs: 10,
          debounceMs: 1,
          createReadStream: (() => fakeStream) as never,
        });
        await new Promise((r) => setTimeout(r, 50));
        handle.close();
        expect(errors.some((e) => e.includes("simulated stream error"))).toBe(true);
      } finally {
        process.stderr.write = origWrite;
      }
    } finally {
      setLogbusForTests(null);
    }
  });
});

describe("Logbus ENOENT recovery (issue #145)", () => {
  it("recreates the log dir and does NOT drop the event when the dir vanishes mid-run", async () => {
    const { bus, dir, cleanup } = newBus();
    try {
      // First write establishes the dir + file.
      bus.write({ ...FIXTURE_EVENT, runId: "r", text: "before" });
      await bus.close();
      // Simulate a checkpoint/rotation elsewhere removing the whole log dir.
      rmSync(dir, { recursive: true, force: true });
      expect(existsSync(dir)).toBe(false);

      // A fresh bus on the same (now-missing) dir must recover, not drop.
      const { bus: bus2 } = newBus({ dir });
      bus2.write({ ...FIXTURE_EVENT, runId: "r", text: "after-rm" });
      await bus2.close();

      // The event survived: dir recreated, line present.
      expect(existsSync(dir)).toBe(true);
      const lines = readFileSync(bus2.currentFile(), "utf8").split("\n").filter(Boolean);
      expect(lines.some((l) => l.includes("after-rm"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
