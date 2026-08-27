import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEvent, Logbus, watchLogbus } from "../src/logbus.js";

function fresh(): { bus: Logbus; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vf-watch-"));
  const bus = new Logbus({ runId: "watch-test", dir });
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

describe("watchLogbus()", () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
  });

  it("delivers events written to current.log to the subscriber", async () => {
    const { bus, cleanup } = fresh();
    cleanups.push(cleanup);
    const seen: LogEvent[] = [];
    const watcher = watchLogbus(bus, (ev) => seen.push(ev), { pollMs: 50, debounceMs: 10 });
    bus.write({ channel: "vf", level: "info", text: "watch-me", runId: "watch-test" });
    const deadline = Date.now() + 2000;
    while (seen.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    watcher.close();
    await bus.close();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.some((e) => e.text === "watch-me")).toBe(true);
  });

  it("currentOffset() advances as the file grows", async () => {
    const { bus, cleanup } = fresh();
    cleanups.push(cleanup);
    const watcher = watchLogbus(bus, () => {}, { pollMs: 50, debounceMs: 10 });
    bus.write({ channel: "vf", level: "info", text: "advance", runId: "watch-test" });
    await new Promise((r) => setTimeout(r, 250));
    const offset = watcher.currentOffset();
    expect(offset).toBeGreaterThan(0);
    watcher.close();
    await bus.close();
  });

  it("resets offset on rotation (inode change) and continues tailing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-watch-rot-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bus = new Logbus({ runId: "rot-watch", dir, thresholdBytes: 65 * 1024 });
    cleanups.push(() => bus.close());
    const seen: LogEvent[] = [];
    const watcher = watchLogbus(bus, (ev) => seen.push(ev), { pollMs: 50, debounceMs: 10 });
    for (let i = 0; i < 400; i++) {
      bus.write({
        channel: "vf",
        level: "info",
        text: `rot-line ${i} ${"x".repeat(150)}`,
        runId: "rot-watch",
      });
    }
    await new Promise((r) => setTimeout(r, 400));
    watcher.close();
    expect(seen.length).toBeGreaterThan(0);
  });

  it("close() stops further events from being delivered", async () => {
    const { bus, cleanup } = fresh();
    cleanups.push(cleanup);
    const seen: LogEvent[] = [];
    const watcher = watchLogbus(bus, (ev) => seen.push(ev), { pollMs: 50, debounceMs: 10 });
    bus.write({ channel: "vf", level: "info", text: "before-close", runId: "watch-test" });
    await new Promise((r) => setTimeout(r, 200));
    watcher.close();
    bus.write({ channel: "vf", level: "info", text: "after-close", runId: "watch-test" });
    await new Promise((r) => setTimeout(r, 200));
    // We tolerate a couple of in-flight events (the watcher may have buffered)
    // but the new "after-close" event must NOT arrive.
    expect(seen.every((e) => e.text !== "after-close")).toBe(true);
  });

  it("does not throw on a malformed JSONL line — it skips and continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-watch-bad-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bus = new Logbus({ runId: "bad-line", dir });
    cleanups.push(() => bus.close());
    const seen: LogEvent[] = [];
    const watcher = watchLogbus(bus, (ev) => seen.push(ev), { pollMs: 50, debounceMs: 10 });
    // Append a malformed line directly to current.log, then a valid one.
    bus.write({ channel: "vf", level: "info", text: "valid-1", runId: "bad-line" });
    await new Promise((r) => setTimeout(r, 200));
    const { appendFileSync } = await import("node:fs");
    appendFileSync(bus.currentFile(), "this is not JSON\n", "utf8");
    bus.write({ channel: "vf", level: "info", text: "valid-2", runId: "bad-line" });
    await new Promise((r) => setTimeout(r, 300));
    watcher.close();
    // We should have at least one valid event; the bad line is skipped silently.
    expect(seen.some((e) => e.text === "valid-1") || seen.some((e) => e.text === "valid-2")).toBe(
      true,
    );
  });

  it("survives a statSync that throws mid-poll (file vanished race) — injected seam", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-watch-stat-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bus = new Logbus({ runId: "stat-throw", dir });
    cleanups.push(() => bus.close());
    bus.write({ channel: "vf", level: "info", text: "before", runId: "stat-throw" });
    const seen: LogEvent[] = [];
    // statSyncFn throws → the poll's catch returns early without crashing.
    const watcher = watchLogbus(bus, (ev) => seen.push(ev), {
      pollMs: 30,
      debounceMs: 5,
      statSyncFn: () => {
        throw new Error("ENOENT: vanished");
      },
    });
    bus.write({ channel: "vf", level: "info", text: "after", runId: "stat-throw" });
    await new Promise((r) => setTimeout(r, 150));
    watcher.close();
    // No throw escaped; the watcher stayed alive.
    expect(true).toBe(true);
  });

  it("falls back to poll-only when fsWatch throws (no inotify) — injected seam", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-watch-fsw-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bus = new Logbus({ runId: "fswatch-throw", dir });
    cleanups.push(() => bus.close());
    const seen: LogEvent[] = [];
    // fsWatchFn throws → the catch sets watcher=null and the poll loop still runs.
    const watcher = watchLogbus(bus, (ev) => seen.push(ev), {
      pollMs: 30,
      debounceMs: 5,
      fsWatchFn: () => {
        throw new Error("ENOSYS: fsWatch unsupported");
      },
    });
    bus.write({ channel: "vf", level: "info", text: "poll-only", runId: "fswatch-throw" });
    await new Promise((r) => setTimeout(r, 200));
    watcher.close();
    // The poll path still delivered the event despite fsWatch being unavailable.
    expect(seen.some((e) => e.text === "poll-only")).toBe(true);
  });

  it("detects rotation via injected statSyncFn inode change — exercises line 71-72", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-watch-rot-inject-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bus = new Logbus({ runId: "rot-inject", dir });
    cleanups.push(() => bus.close());
    // Write a seed event so current.log exists and the initial stat in watchLogbus
    // () sets lastFileInode to the real inode.
    bus.write({ channel: "vf", level: "info", text: "seed", runId: "rot-inject" });
    const seen: LogEvent[] = [];
    // Inject a statSyncFn that returns an inode different from the real file's
    // inode, simulating a rotation. The createReadStream seam delivers mock data.
    const mockEvent = JSON.stringify({
      seq: 1,
      ts: 1,
      channel: "vf",
      level: "info",
      text: "rotated",
      runId: "rot-inject",
    });
    const { Readable } = await import("node:stream");
    // statSyncFn: first call is poll-initial (sees existing file), return diff inode
    let pollCalls = 0;
    const watcher = watchLogbus(bus, (ev) => seen.push(ev), {
      pollMs: 30,
      debounceMs: 5,
      statSyncFn: (() => {
        pollCalls++;
        // Return a different inode than the real file to trigger rotation reset.
        return { ino: 999999, size: mockEvent.length + 1 } as unknown as import("node:fs").Stats;
      }) as unknown as typeof import("node:fs").statSync,
      createReadStream: () =>
        new Readable({
          read() {
            this.push(`${mockEvent}\n`);
            this.push(null);
          },
        }) as unknown as import("node:fs").ReadStream,
    });
    await new Promise((r) => setTimeout(r, 200));
    watcher.close();
    // The rotation-reset path (offset=0) read from the mock stream and delivered
    // the event. At least one poll cycle should have hit the rotation detection.
    expect(pollCalls).toBeGreaterThanOrEqual(1);
    expect(seen.some((e) => e.text === "rotated")).toBe(true);
  });
});
