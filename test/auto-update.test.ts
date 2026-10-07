import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_UPDATE,
  type AutoUpdateSeams,
  maybeAutoUpdate,
  readAutoUpdateMarker,
  startAutoUpdateWatcher,
  writeAutoUpdateMarker,
} from "../src/update/auto-update.js";

function autoHarness(over: Record<string, unknown> = {}) {
  const log: string[] = [];
  let marker: { version: string; attempted_at: number } | null = null;
  let clock = 1_000_000;
  const seams: AutoUpdateSeams = {
    mode: () => "auto",
    refresh: async () => {
      log.push("refresh");
    },
    readLatest: () => "0.21.0",
    currentVersion: "0.20.0",
    spawnUpdate: () => true,
    now: () => clock,
    readMarker: () => marker,
    writeMarker: (m) => {
      marker = m;
      log.push(`marker:${m.version}`);
    },
    outFn: (m) => {
      log.push(m);
    },
  };
  Object.assign(seams, over);
  return {
    seams,
    log,
    advance: (ms: number) => {
      clock += ms;
    },
    getMarker: () => marker,
    now: () => clock,
    setMarker: (m: typeof marker) => {
      marker = m;
    },
  };
}

describe("maybeAutoUpdate", () => {
  test("does nothing unless mode is auto", async () => {
    const h = autoHarness({ mode: () => "notify" });
    expect(await maybeAutoUpdate(h.seams)).toBe(false);
    expect(h.log).toEqual([]);
  });
  test("does nothing when latest is unknown or not newer", async () => {
    expect(await maybeAutoUpdate(autoHarness({ readLatest: () => null }).seams)).toBe(false);
    expect(await maybeAutoUpdate(autoHarness({ readLatest: () => "0.20.0" }).seams)).toBe(false);
  });
  test("spawns the update command and records a marker", async () => {
    const h = autoHarness();
    expect(await maybeAutoUpdate(h.seams)).toBe(true);
    expect(h.log).toContain("refresh");
    expect(h.getMarker()?.version).toBe("0.21.0");
    expect(h.log.some((l) => l.includes("installing v0.21.0"))).toBe(true);
  });
  test("does not retry the same version inside the retry window", async () => {
    const h = autoHarness();
    h.setMarker({ version: "0.21.0", attempted_at: h.now() - 60_000 });
    expect(await maybeAutoUpdate(h.seams)).toBe(false);
  });
  test("retries the same version after the retry window", async () => {
    const h = autoHarness();
    h.setMarker({ version: "0.21.0", attempted_at: h.now() - AUTO_UPDATE.RETRY_MS - 1 });
    expect(await maybeAutoUpdate(h.seams)).toBe(true);
  });
  test("reports a failed spawn", async () => {
    const h = autoHarness({ spawnUpdate: () => false });
    expect(await maybeAutoUpdate(h.seams)).toBe(false);
    expect(h.log.some((l) => l.includes("could not spawn"))).toBe(true);
  });
});

describe("startAutoUpdateWatcher", () => {
  test("ticks on the interval and is single-flight", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = autoHarness({
      refresh: async () => {
        calls += 1;
        await gate;
      },
    });
    const watcher = startAutoUpdateWatcher({ ...h.seams, intervalMs: 5 });
    await Bun.sleep(100);
    watcher.stop();
    release?.();
    await Bun.sleep(1);
    expect(calls).toBe(1); // overlapping ticks were skipped while one was in flight
  });

  test("single-flight re-arms: a later tick after a completed probe runs again", async () => {
    let latest = "0.21.0";
    let spawns = 0;
    const h = autoHarness({
      readLatest: () => latest,
      spawnUpdate: () => {
        spawns += 1;
        return true;
      },
    });
    const watcher = startAutoUpdateWatcher({ ...h.seams, intervalMs: 5 });
    try {
      for (let i = 0; i < 200 && spawns < 1; i += 1) await Bun.sleep(5);
      expect(spawns).toBe(1); // first completed cycle spawned the update
      latest = "0.22.0"; // differs from the recorded marker → the next tick must act
      for (let i = 0; i < 200 && spawns < 2; i += 1) await Bun.sleep(5);
      expect(spawns).toBe(2); // must not be blocked by the first tick's flag
    } finally {
      watcher.stop();
    }
  });

  test("a throwing probe never crashes the watcher", async () => {
    const h = autoHarness({
      refresh: async () => {
        throw new Error("network down");
      },
    });
    const watcher = startAutoUpdateWatcher({ ...h.seams, intervalMs: 5 });
    await Bun.sleep(30);
    watcher.stop();
    expect(h.log.some((l) => l.startsWith("marker:"))).toBe(false);
  });
});

describe("auto-update marker file", () => {
  test("write/read round-trip; missing or malformed files read null", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-auto-marker-"));
    try {
      const path = join(dir, "auto-update.json");
      expect(readAutoUpdateMarker(path)).toBeNull(); // missing
      writeAutoUpdateMarker({ version: "0.21.0", attempted_at: 123 }, path);
      expect(readAutoUpdateMarker(path)).toEqual({ version: "0.21.0", attempted_at: 123 });
      writeFileSync(path, "{not json");
      expect(readAutoUpdateMarker(path)).toBeNull(); // malformed JSON
      writeFileSync(path, JSON.stringify({ version: 7, attempted_at: "soon" }));
      expect(readAutoUpdateMarker(path)).toBeNull(); // wrong shapes
      expect(AUTO_UPDATE.RETRY_MS).toBe(6 * 60 * 60_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
