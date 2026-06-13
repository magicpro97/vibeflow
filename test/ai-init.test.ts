import { describe, expect, test } from "bun:test";
import { buildAiInitPrompt, runAiInit, selectBestEngine } from "../src/ai-init.js";
import type { Engine } from "../src/core.js";
import type { EngineReadiness } from "../src/preflight.js";
import type { ProjectProfile } from "../src/scanner.js";

const FIXED_NOW = "2026-06-10T00:00:00.000Z";

function readiness(engine: Engine, level: EngineReadiness["level"]): EngineReadiness {
  return { engine, level, detail: `${engine}: ${level}`, checkedAt: FIXED_NOW };
}

describe("selectBestEngine", () => {
  test("returns claude when claude is ready", () => {
    const list: EngineReadiness[] = [
      readiness("claude", "ready"),
      readiness("copilot", "no-binary"),
      readiness("codex", "probe-failed"),
    ];
    expect(selectBestEngine(list)).toBe("claude");
  });

  test("skips unready engines and picks next in priority", () => {
    const list: EngineReadiness[] = [
      readiness("claude", "no-binary"),
      readiness("copilot", "ready"),
      readiness("codex", "ready"),
    ];
    expect(selectBestEngine(list)).toBe("copilot");
  });

  test("returns codex when only codex is ready", () => {
    const list: EngineReadiness[] = [
      readiness("claude", "probe-failed"),
      readiness("copilot", "no-binary"),
      readiness("codex", "ready"),
    ];
    expect(selectBestEngine(list)).toBe("codex");
  });

  test("returns fallback engine when no ready but some probe-failed", () => {
    const list: EngineReadiness[] = [
      readiness("claude", "no-binary"),
      readiness("copilot", "probe-failed"),
      readiness("codex", "unknown"),
    ];
    expect(selectBestEngine(list)).toBe("copilot");
  });

  test("returns null for empty readiness list", () => {
    expect(selectBestEngine([])).toBeNull();
  });
});

describe("buildAiInitPrompt", () => {
  const profile: ProjectProfile = {
    name: "test-project",
    summary: "A test project for unit tests",
    languages: ["TypeScript", "Kotlin"],
    packageManager: "bun",
    buildCommand: "bun run build",
    testCommand: "bun test",
    lintCommand: "bun run lint",
    frameworks: ["React"],
    hasCI: true,
    findings: [],
    manifests: ["package.json"],
  };

  test("includes project metadata in prompt", () => {
    const prompt = buildAiInitPrompt(profile, "/tmp");
    expect(prompt).toContain("test-project");
    expect(prompt).toContain("TypeScript, Kotlin");
    expect(prompt).toContain("React");
    expect(prompt).toContain("bun run build");
    expect(prompt).toContain("bun test");
  });

  test("includes task structure", () => {
    const prompt = buildAiInitPrompt(profile, "/tmp");
    expect(prompt).toContain("Analyze the Project (INVESTIGATE");
    expect(prompt).toContain("Write/Update Instruction Files");
    expect(prompt).toContain("Discover and Install Skills");
    expect(prompt).toContain("Update Project Context");
  });

  test("includes constraint section", () => {
    const prompt = buildAiInitPrompt(profile, "/tmp");
    expect(prompt).toContain("Critical Constraints");
    expect(prompt).toContain("NEVER delete or truncate");
    expect(prompt).toContain("vibeflow:start");
    expect(prompt).toContain("vibeflow:end");
  });

  test("includes directory listing section", () => {
    const prompt = buildAiInitPrompt(profile, "/tmp");
    expect(prompt).toContain("directory-listing.txt");
  });

  test("handles empty language/framework gracefully", () => {
    const lean: ProjectProfile = { ...profile, languages: [], frameworks: [] };
    const prompt = buildAiInitPrompt(lean, "/tmp");
    expect(prompt).toContain("unknown");
    expect(prompt).toContain("none detected");
  });
});

describe("runAiInit", () => {
  // Mock preflight: only claude ready, others skipped (avoids live probe delays).
  function mockPreflight(_engines: Engine[], _opts: { probe: boolean }): EngineReadiness[] {
    return [
      readiness("claude", "ready"),
      readiness("copilot", "no-binary"),
      readiness("codex", "no-binary"),
    ];
  }

  test("dry run returns prompt without spawning", async () => {
    const result = await runAiInit({
      base: process.cwd(),
      dryRun: true,
      forceEngine: "claude",
      preflight: mockPreflight,
    });
    expect(result.ok).toBe(true);
    expect(result.prompt).toBeTruthy();
    expect(result.engine).toBe("claude");
    expect(result.reason).toContain("dry run");
  });

  test("returns ok when forceEngine is ready and spawner succeeds", async () => {
    const result = await runAiInit({
      base: process.cwd(),
      forceEngine: "claude",
      preflight: mockPreflight,
      spawner: async (_cmd, _args, _input) => ({
        status: 0,
        stdout: '{"files_edited":[]}',
        stderr: "",
        timedOut: false,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.engine).toBe("claude");
  });

  test("returns error when spawner times out", async () => {
    const result = await runAiInit({
      base: process.cwd(),
      forceEngine: "claude",
      preflight: mockPreflight,
      spawner: async (_cmd, _args, _input) => ({
        status: 0,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("timed out");
  });

  test("returns error when spawner exits non-zero", async () => {
    const result = await runAiInit({
      base: process.cwd(),
      forceEngine: "claude",
      preflight: mockPreflight,
      spawner: async (_cmd, _args, _input) => ({
        status: 1,
        stdout: "",
        stderr: "boom",
        timedOut: false,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("exited with status 1");
  });

  test("returns error when forceEngine is not ready (no fallback)", async () => {
    // mockPreflight only has claude ready. Force copilot (not ready).
    const result = await runAiInit({
      base: process.cwd(),
      forceEngine: "copilot",
      preflight: mockPreflight,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("forced engine copilot is not ready");
    expect(result.reason).toContain("vf doctor --probe");
  });

  test("returns error when no engine is ready (no forceEngine)", async () => {
    // mockPreflight: all engines not ready.
    const allDown: EngineReadiness[] = [
      readiness("claude", "no-binary"),
      readiness("copilot", "no-binary"),
      readiness("codex", "no-binary"),
    ];
    const result = await runAiInit({
      base: process.cwd(),
      preflight: () => allDown,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no ready engine found");
  });
});
