import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAsyncSpawner } from "../src/dispatch.js";
import { type LogEvent, getLogbus, installLogbus, out } from "../src/logbus.js";

interface CapturedEvent {
  channel: string;
  level: string;
  text: string;
  unit?: string;
  meta?: Record<string, unknown>;
}

describe("dispatch.ts stderr pipe (M2)", () => {
  let dir: string;
  let cleanup: () => void;
  let captured: CapturedEvent[];
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-stderr-"));
    cleanup = () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };
    captured = [];
    installLogbus({ dir });
    const bus = getLogbus();
    if (bus) {
      unsubscribe = bus.subscribe((ev: LogEvent) => {
        captured.push({
          channel: ev.channel,
          level: ev.level,
          text: ev.text,
          unit: ev.unit,
          meta: ev.meta,
        });
      });
    }
  });

  afterEach(async () => {
    if (unsubscribe) unsubscribe();
    const bus = getLogbus();
    if (bus) await bus.close();
    cleanup();
  });

  test("captures child stdout via onChunk", async () => {
    let chunkText: string | undefined;
    const spawner = makeAsyncSpawner({
      onChunk: (text) => {
        chunkText = text;
      },
    });
    // Use `sh -c` so the spawn exercises the same node child_process path the orchestrator
    // would. The spawner handles `needsShellForCommand`, so this is portable across macOS/Linux.
    const result = await spawner("sh", ["-c", "printf 'out-stdout'"], "");
    expect(result.status).toBe(0);
    expect(chunkText).toBe("out-stdout");
  });

  test("captures child stderr via onStderrChunk (M2 new opt)", async () => {
    let stderrText: string | undefined;
    const spawner = makeAsyncSpawner({
      onStderrChunk: (text) => {
        stderrText = text;
      },
    });
    // Write to fd 2 from the child so the parent's stderr pipe receives it.
    const result = await spawner("sh", ["-c", "printf 'out-stderr' 1>&2"], "");
    expect(result.status).toBe(0);
    expect(stderrText).toBe("out-stderr");
  });

  test("reports failure when the command cannot be spawned", async () => {
    let stderrText: string | undefined;
    const spawner = makeAsyncSpawner({
      onStderrChunk: (text) => {
        stderrText = text;
      },
    });
    let thrown: Error | undefined;
    let status: number | undefined;
    try {
      const result = await spawner("vf-definitely-missing-command", [], "");
      status = result.status;
    } catch (err) {
      thrown = err as Error;
    }
    expect(Boolean(thrown) || (status != null && status !== 0)).toBe(true);
    if (!thrown && stderrText != null) {
      expect(stderrText).toContain("vf-definitely-missing-command");
    }
  });

  test("routes engine-stderr to the bus as level=warn events", async () => {
    const spawner = makeAsyncSpawner({
      onStderrChunk: (text) => {
        out("engine-stderr", text, {
          level: "warn",
          unit: "u-stderr",
          meta: { engine: "claude", unit: "u-stderr" },
        });
      },
    });
    await spawner("sh", ["-c", "printf 'noise-line' 1>&2"], "");
    // Allow the in-process fanout to fire (it is synchronous in write(), so this is instant).
    const stderrEvents = captured.filter((e) => e.channel === "engine-stderr");
    expect(stderrEvents).toHaveLength(1);
    const ev = stderrEvents[0] as CapturedEvent;
    expect(ev.level).toBe("warn");
    expect(ev.text).toBe("noise-line");
  });

  test("preserves order between stdout and stderr chunks via bus", async () => {
    const order: string[] = [];
    const spawner = makeAsyncSpawner({
      onChunk: (text) => {
        order.push(`stdout:${text}`);
        out("engine-stdout", text, {
          level: "info",
          unit: "u-order",
          meta: { engine: "codex", unit: "u-order" },
        });
      },
      onStderrChunk: (text) => {
        order.push(`stderr:${text}`);
        out("engine-stderr", text, {
          level: "warn",
          unit: "u-order",
          meta: { engine: "codex", unit: "u-order" },
        });
      },
    });
    // Force separate chunks via `sleep` so the kernel pipe flushes between writes.
    // Without the sleeps, `sh` would buffer all four printfs into one chunk per stream
    // and the test would no longer exercise the order-preservation path.
    await spawner(
      "sh",
      [
        "-c",
        "printf 'A'; sleep 0.05; printf 'B' 1>&2; sleep 0.05; printf 'C'; sleep 0.05; printf 'D' 1>&2",
      ],
      "",
    );
    // The bus fanout is synchronous in write(), so order[] (captured at the same
    // moment we called out()) and the bus subscriber see events in the same order.
    const busOrder = captured
      .filter((e) => e.channel === "engine-stdout" || e.channel === "engine-stderr")
      .map((e) => `${e.channel}:${e.text}`);
    expect(order).toEqual(["stdout:A", "stderr:B", "stdout:C", "stderr:D"]);
    expect(busOrder).toEqual([
      "engine-stdout:A",
      "engine-stderr:B",
      "engine-stdout:C",
      "engine-stderr:D",
    ]);
  });

  test("engine name and unit are in meta of the engine-stderr bus event", async () => {
    const spawner = makeAsyncSpawner({
      onStderrChunk: (text) => {
        out("engine-stderr", text, {
          level: "warn",
          unit: "unit-1",
          meta: { engine: "claude", unit: "unit-1" },
        });
      },
    });
    await spawner("sh", ["-c", "printf 'meta-noise' 1>&2"], "");
    const stderrEvents = captured.filter((e) => e.channel === "engine-stderr");
    expect(stderrEvents).toHaveLength(1);
    const ev = stderrEvents[0] as CapturedEvent;
    expect(ev.unit).toBe("unit-1");
    expect(ev.meta).toBeDefined();
    expect(ev.meta?.engine).toBe("claude");
    expect(ev.meta?.unit).toBe("unit-1");
  });

  test("engine-stderr events persist as JSONL on disk (file bus contract)", async () => {
    const spawner = makeAsyncSpawner({
      onStderrChunk: (text) => {
        out("engine-stderr", text, {
          level: "warn",
          unit: "u-disk",
          meta: { engine: "copilot", unit: "u-disk" },
        });
      },
    });
    await spawner("sh", ["-c", "printf 'persisted' 1>&2"], "");
    // The bus chain is in-process; await a microtask so writeLocked settles.
    await new Promise((r) => setTimeout(r, 50));
    const bus = getLogbus();
    expect(bus).not.toBeNull();
    if (!bus) throw new Error("bus must be installed for this test");
    const raw = readFileSync(bus.currentFile(), "utf8").trim();
    const lines = raw.split("\n").filter(Boolean);
    const stderrLine = lines
      .map((l) => JSON.parse(l) as { channel: string; text: string; level: string })
      .find((e) => e.channel === "engine-stderr");
    expect(stderrLine).toBeDefined();
    expect(stderrLine?.level).toBe("warn");
    expect(stderrLine?.text).toBe("persisted");
  });
});
