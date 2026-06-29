import { describe, expect, test } from "bun:test";
import {
  ProbeCache,
  getCachedProbe,
  invalidateProbe,
  setCachedProbe,
  setSharedCache,
} from "../src/preflight.js";

describe("ProbeCache", () => {
  test("returns undefined for missing key", () => {
    const c = new ProbeCache();
    expect(c.get("claude", "/repo", ["-p", "READY"])).toBeUndefined();
  });

  test("stores and retrieves a result", () => {
    const c = new ProbeCache();
    const at = new Date("2026-06-12T00:00:00Z");
    c.set(
      "claude",
      "/repo",
      ["-p", "READY"],
      { level: "ready", detail: "ok", engine: "claude", checkedAt: at.toISOString() },
      at,
    );
    expect(c.get("claude", "/repo", ["-p", "READY"], at)?.level).toBe("ready");
  });

  test("returns undefined when entry is expired", () => {
    const c = new ProbeCache({ ttlMs: 1000 });
    const t0 = new Date("2026-06-12T00:00:00Z");
    c.set(
      "claude",
      "/repo",
      ["x"],
      { level: "ready", detail: "", engine: "claude", checkedAt: t0.toISOString() },
      t0,
    );
    const t1 = new Date(t0.getTime() + 5000);
    expect(c.get("claude", "/repo", ["x"], t1)).toBeUndefined();
  });

  test("short TTL for probe-failed results (transient flakiness)", () => {
    const c = new ProbeCache({ shortTtlMs: 5_000, ttlMs: 60_000 });
    const t0 = new Date("2026-06-12T00:00:00Z");
    c.set(
      "claude",
      "/repo",
      ["x"],
      { level: "probe-failed", detail: "timeout", engine: "claude", checkedAt: t0.toISOString() },
      t0,
      "short",
    );
    const t1 = new Date(t0.getTime() + 10_000);
    expect(c.get("claude", "/repo", ["x"], t1)).toBeUndefined();
  });

  test("different engines don't collide", () => {
    const c = new ProbeCache();
    const t = new Date("2026-06-12T00:00:00Z");
    c.set(
      "claude",
      "/repo",
      ["x"],
      { level: "ready", detail: "", engine: "claude", checkedAt: t.toISOString() },
      t,
    );
    c.set(
      "codex",
      "/repo",
      ["x"],
      { level: "no-binary", detail: "", engine: "codex", checkedAt: t.toISOString() },
      t,
    );
    expect(c.get("claude", "/repo", ["x"], t)?.level).toBe("ready");
    expect(c.get("codex", "/repo", ["x"], t)?.level).toBe("no-binary");
  });

  test("invalidate() removes entries for one engine", () => {
    const c = new ProbeCache();
    const t = new Date("2026-06-12T00:00:00Z");
    c.set(
      "claude",
      "/repo",
      ["x"],
      { level: "ready", detail: "", engine: "claude", checkedAt: t.toISOString() },
      t,
    );
    c.set(
      "codex",
      "/repo",
      ["x"],
      { level: "ready", detail: "", engine: "codex", checkedAt: t.toISOString() },
      t,
    );
    c.invalidate("claude");
    expect(c.get("claude", "/repo", ["x"], t)).toBeUndefined();
    expect(c.get("codex", "/repo", ["x"], t)?.level).toBe("ready");
  });

  test("invalidateAll() clears the whole cache", () => {
    const c = new ProbeCache();
    const t = new Date("2026-06-12T00:00:00Z");
    c.set(
      "claude",
      "/repo",
      ["x"],
      { level: "ready", detail: "", engine: "claude", checkedAt: t.toISOString() },
      t,
    );
    c.invalidateAll();
    expect(c.get("claude", "/repo", ["x"], t)).toBeUndefined();
    expect(c.size()).toBe(0);
  });
});

describe("shared cache helpers", () => {
  test("setSharedCache/getCachedProbe/setCachedProbe/invalidateProbe", () => {
    const fresh = new ProbeCache();
    setSharedCache(fresh);
    setCachedProbe("claude", "/repo", ["x"], {
      level: "ready",
      detail: "via shared",
      engine: "claude",
      checkedAt: "2026-06-12",
    });
    expect(getCachedProbe("claude", "/repo", ["x"])?.detail).toBe("via shared");
    invalidateProbe("claude");
    expect(getCachedProbe("claude", "/repo", ["x"])).toBeUndefined();
    setSharedCache(undefined);
  });
});
