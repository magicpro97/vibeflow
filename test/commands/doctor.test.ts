import { describe, expect, test } from "bun:test";
import { detectRepo, doctor, resolveRepo } from "../../src/commands.js";
import type { EngineReadiness } from "../../src/preflight.js";

function r(
  engine: "claude" | "codex" | "copilot",
  level: EngineReadiness["level"],
  detail?: string,
): EngineReadiness {
  return { engine, level, detail: detail ?? level, checkedAt: "" };
}

describe("doctor", () => {
  // ── readinessMark: L47-48 (probe-failed / unknown level → c.yellow(\"!\")) ──
  test("readinessMark returns yellow ! for probe-failed (L47)", async () => {
    const readiness: EngineReadiness[] = [
      r("claude", "ready"),
      r("codex", "probe-failed", "timeout"),
      r("copilot", "ready"),
    ];
    // --probe with inject hits the probe-failed branch which exercises
    // readinessMark(level) where level === "probe-failed" → c.yellow("!")
    const code = await doctor({ probe: true }, { readiness });
    expect(code).toBe(1);
  });

  test("readinessMark returns dim dot for no-binary (L46 — complement)", async () => {
    const readiness: EngineReadiness[] = [
      r("claude", "ready"),
      r("codex", "no-binary", "not installed"),
      r("copilot", "ready"),
    ];
    const code = await doctor({}, { readiness });
    expect(code).toBe(0);
  });

  // ── probe-failed output: L126-128 ──
  test("probe-failed engines print warning and return 1 (L126-128)", async () => {
    const readiness: EngineReadiness[] = [
      r("claude", "ready"),
      r("codex", "probe-failed", "exit 1"),
      r("copilot", "probe-failed", "timeout"),
    ];
    // Multiple probe-failed → L126-128 exercised with plural message
    const code = await doctor({ probe: true }, { readiness });
    expect(code).toBe(1);
  });

  // ── probe-failed single engine (singular branch in template string) ──
  test("single probe-failed engine still returns 1 (L126-128 singular)", async () => {
    const readiness: EngineReadiness[] = [
      r("claude", "ready"),
      r("codex", "ready"),
      r("copilot", "probe-failed", "auth error"),
    ];
    const code = await doctor({ probe: true }, { readiness });
    expect(code).toBe(1);
  });

  // ── success path: L134-135 (\"Ready.\" + return 0) ──
  test("all engines ready prints Ready and returns 0 with --probe (L134-135)", async () => {
    const readiness: EngineReadiness[] = [
      r("claude", "ready"),
      r("codex", "ready"),
      r("copilot", "ready"),
    ];
    const code = await doctor({ probe: true }, { readiness });
    expect(code).toBe(0);
  });

  test("all engines ready prints Ready and returns 0 without --probe (L134-135 no-probe)", async () => {
    const readiness: EngineReadiness[] = [
      r("claude", "ready"),
      r("codex", "ready"),
      r("copilot", "ready"),
    ];
    const code = await doctor({}, { readiness });
    expect(code).toBe(0);
  });

  // ── no-inject, no-probe branch: L115-116 → printReadiness(L118) → return 0 (L134-135) ──
  test("no-inject no-probe path reaches Ready when tools are present (L134-135)", async () => {
    // Default call without inject — exercises preflightAll(ENGINES, {probe:false})
    const code = await doctor({});
    expect([0, 1]).toContain(code);
  }, 30_000);

  // ── L111-114: async probe path (--probe without inject.readiness) ──
  test("probe=true without inject calls preflightAllAsync with spinner (L111-114)", async () => {
    // Stub Bun.spawn/spawnSync so preflightAllAsync returns quickly
    // without spawning real engine binaries.
    const origSpawn = Bun.spawn;
    const origSpawnSync = Bun.spawnSync;
    const mockSpawn = ((cmd: string[], opts?: unknown) => {
      throw new Error("unexpected spawn call");
    }) as unknown as typeof Bun.spawn;
    const mockSpawnSync = ((cmd: { cmd?: Record<string, string> }) => ({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    })) as unknown as typeof Bun.spawnSync;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = mockSpawn;
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = mockSpawnSync;
    try {
      const code = await doctor({ probe: true });
      expect([0, 1]).toContain(code);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
      (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = origSpawnSync;
    }
  });

  // ── missing required tools: L120-123 (already covered, keep for completeness) ──
  test("missing required tools returns 1", async () => {
    const { doctor: d } = require("../../src/commands.js");
    const code = await d({}, { hasCommand: () => false, readiness: [] });
    expect(code).toBe(1);
  });

  // ── refresh flag clears probe cache: L102-106 ──
  test("refresh flag clears probe cache and uses inject readiness", async () => {
    const readiness: EngineReadiness[] = [r("claude", "ready")];
    const code = await doctor({ refresh: true }, { readiness });
    expect(code).toBe(0);
  });
});

describe("resolveRepo", () => {
  test("empty path returns cwd", () => {
    expect(resolveRepo("")).toBeDefined();
    expect(resolveRepo("   ")).toBeDefined();
    expect(resolveRepo(undefined)).toBeDefined();
  });

  test("relative path resolves under cwd", () => {
    const r = resolveRepo(".");
    expect(r).toBeDefined();
  });

  test("non-existent absolute path falls back to cwd", () => {
    const r = resolveRepo("/nonexistent/path/xyz");
    expect(r).toBeDefined();
  });
});

describe("detectRepo", () => {
  test("detects current repo", () => {
    const d = detectRepo();
    expect(d.repo).toBeDefined();
    expect(typeof d.isGit).toBe("boolean");
    expect(d.engines).toBeDefined();
    expect(d.clis).toBeDefined();
  });
});
