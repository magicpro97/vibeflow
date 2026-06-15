import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAiInitPrompt, runAiInit, selectBestEngine } from "../src/ai-init.js";
import type { Engine } from "../src/core.js";
import type { AsyncSpawner } from "../src/dispatch.js";
import type { EngineReadiness } from "../src/preflight.js";
import type { ProjectProfile } from "../src/scanner.js";

const FIXED_NOW = "2026-06-10T00:00:00.000Z";

type PreFlightProbeFn = (engines: Engine[], opts: { probe: boolean }) => EngineReadiness[];

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

  test("returns ok:false when forceEngine is not ready (line 446-447)", async () => {
    // preflight returns a list where claude is NOT ready.
    const noReadyPreflight: PreFlightProbeFn = () => [
      { engine: "claude", level: "no-binary", detail: "missing", checkedAt: "now" },
    ];
    const result = await runAiInit({
      base: process.cwd(),
      forceEngine: "claude",
      preflight: noReadyPreflight,
      spawner: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("claude is not ready");
  });

  test("no ready engine (line 452-457) without forceEngine", async () => {
    const noReadyPreflight: PreFlightProbeFn = () => [
      { engine: "claude", level: "no-binary", detail: "x", checkedAt: "now" },
      { engine: "codex", level: "no-binary", detail: "x", checkedAt: "now" },
    ];
    const result = await runAiInit({
      base: process.cwd(),
      preflight: noReadyPreflight,
      spawner: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no ready engine");
  });

  test("returns ok with isUnavailable branch (line 484-487)", async () => {
    // Inject engineCommandFn returning unavailable for the chosen
    // engine. Triggers the { ok: false, reason: invocation.unavailable }
    // branch (line 492).
    const result = await runAiInit({
      base: process.cwd(),
      forceEngine: "copilot",
      preflight: () => [
        {
          engine: "copilot",
          level: "ready" as const,
          detail: "ready",
          checkedAt: "now",
        },
      ],
      engineCommandFn: () => ({
        unavailable: "copilot CLI not found — test",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("copilot CLI not found");
  });

  // The original promptFile read-back (line 506-548) is REMOVED in
  // Task 7b: the file was always read back into JS and put on
  // cmd-line as argv anyway, so the round-trip accomplished nothing.
  // The 32K Windows limit is a hard constraint and is now enforced
  // by a fail-fast check at the top of runAiInit (tested separately
  // in the 30K-chars regression test). The shared `if
  // (result.status !== 0)` and `if (result.timedOut)` branches are
  // still reachable with the inline-argv path; cover them here.
  test("copilot huge prompt (inline argv): status !== 0 returns ok:false with stderr hint", async () => {
    // Force prompt > 10000 chars (now passed inline as argv, no file).
    // Inject a spawner that returns non-zero exit code with stderr.
    // The shared `if (result.status !== 0)` branch fires → returns
    // ok:false with stderr hint in the reason.
    const { mkdirSync, rmSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "vf-copilot-fail-"));
    mkdirSync(join(dir, ".vibeflow", "ai-context"), { recursive: true });
    const origSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
      const enc = new TextEncoder();
      return {
        stdin: { write: () => {}, end: () => {} },
        stdout: {
          getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
          }),
        },
        stderr: {
          getReader: () => {
            let yielded = false;
            return {
              read: async () => {
                if (!yielded) {
                  yielded = true;
                  return { done: false, value: enc.encode("auth failed") };
                }
                return { done: true, value: undefined };
              },
            };
          },
        },
        exited: Promise.resolve(2),
        kill: () => {},
      } as never;
    }) as unknown as typeof Bun.spawn;
    try {
      const r = await runAiInit({
        base: dir,
        forceEngine: "copilot",
        preflight: () => [
          {
            engine: "copilot",
            level: "ready" as const,
            detail: "ready",
            checkedAt: "now",
          },
        ],
        engineCommandFn: () => ({
          cmd: "copilot",
          args: ["-p", "--allow-all-tools"],
          promptMode: "arg" as const,
        }),
        buildPrompt: () => "x".repeat(20000),
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("status 2");
      expect(r.reason).toContain("auth failed");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Documented limitation: the timedOut branch is only reachable
  // via the real makeAsyncSpawner timeout (default graceMs: 3000ms),
  // which would make the test run for 3+ seconds. Not worth it.
  test("copilot huge prompt (inline argv): timed out returns ok:false", async () => {
    // Inject a spawner that yields timedOut:true → the shared
    // `if (result.timedOut)` branch fires.
    const { mkdirSync, rmSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "vf-ai-tmo-"));
    mkdirSync(join(dir, ".vibeflow", "ai-context"), { recursive: true });
    try {
      const r = await runAiInit({
        base: dir,
        forceEngine: "copilot",
        preflight: () => [
          {
            engine: "copilot",
            level: "ready" as const,
            detail: "ready",
            checkedAt: "now",
          },
        ],
        engineCommandFn: () => ({
          cmd: "copilot",
          args: ["-p", "--allow-all-tools"],
          promptMode: "arg" as const,
        }),
        buildPrompt: () => "x".repeat(20000),
        // Inject a spawner that times out.
        spawner: async () => ({
          status: 124,
          stdout: "partial output",
          stderr: "killed",
          timedOut: true,
        }),
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("timed out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("copilot prompt is passed inline as -p argv value (regression: Windows empty-prompt bug)", async () => {
    // Regression test for the bug where `type file | copilot -p ...`
    // on Windows results in copilot receiving `-p --allow-all-tools`
    // (no prompt value) and falling back to interactive mode.
    //
    // The fix is: do NOT shell-pipe. Pass the prompt as the `-p` argv
    // value via direct Bun.spawn (not shell). The promptFile round-
    // trip was REMOVED in Task 7b (it was dead code: the file content
    // was always put back on cmd-line as argv anyway). This test
    // captures the actual argv and asserts the prompt IS present as
    // the value of `-p`.
    const { mkdirSync, rmSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "vf-copilot-argv-"));
    mkdirSync(join(dir, ".vibeflow", "ai-context"), { recursive: true });
    const calls: { cmd: string; args: readonly string[]; stdin: string }[] = [];
    const captureSpawner: AsyncSpawner = async (cmd, args, input) => {
      calls.push({ cmd, args, stdin: input });
      return { status: 0, stdout: '{"files_edited":[]}', stderr: "", timedOut: false };
    };
    const origSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => ({
      stdin: { write: () => {}, end: () => {} },
      stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      exited: Promise.resolve(0),
      kill: () => {},
    })) as never;
    try {
      const r = await runAiInit({
        base: dir,
        forceEngine: "copilot",
        preflight: () => [
          { engine: "copilot", level: "ready" as const, detail: "ready", checkedAt: "now" },
        ],
        engineCommandFn: () => ({
          cmd: "copilot",
          args: ["-p", "--allow-all-tools"],
          promptMode: "arg" as const,
        }),
        // > 10_000 chars: the promptFile path is gone, so the prompt
        // goes inline as the -p argv value (no file written).
        buildPrompt: () => "PROMPT-CONTENT-XYZ".padEnd(20000, "-"),
        spawner: captureSpawner,
      });
      // The result is ok (the captured spawner returns status 0).
      expect(r.ok).toBe(true);
      // The real assertion: the copilot invocation got the prompt as
      // a `-p` value, NOT as stdin. If prompt is missing, the test fails.
      const copilotCall = calls.find((c) => c.cmd === "copilot");
      expect(copilotCall).toBeDefined();
      const args = copilotCall?.args ?? [];
      const pFlagIndex = args.findIndex((a) => a === "-p");
      expect(pFlagIndex).toBeGreaterThanOrEqual(0);
      // The next argv element after -p must contain the prompt text,
      // not `--allow-all-tools` (which would mean the prompt is missing).
      const value = args[pFlagIndex + 1];
      expect(value).toBeDefined();
      expect(value).not.toBe("--allow-all-tools");
      expect(value?.length).toBeGreaterThan(0);
      expect(value).toContain("PROMPT-CONTENT-XYZ");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dirListing: FS catch branches (line 80, 92)", () => {
  test("statSync catch: broken symlink silently skipped (line 92)", () => {
    // Create a broken symlink → statSync throws ENOENT → catch fires.
    const { dirListing } = require("../src/ai-init.js");
    const dir = mkdtempSync(join(tmpdir(), "vf-dir-stat-sym-"));
    try {
      writeFileSync(join(dir, "regular.txt"), "data");
      const { symlinkSync } = require("node:fs") as typeof import("node:fs");
      symlinkSync("/nonexistent/abc", join(dir, "badlink"));
      const out = dirListing(dir);
      // regular.txt is included, badlink is silently skipped
      expect(out).toContain("regular.txt");
      expect(out).not.toContain("badlink");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("copilot > 10K chars on Windows: prompt goes inline as argv, no file is written", async () => {
    // Regression test: with the promptFile mechanism REMOVED (Task 7b),
    // the prompt is passed as -p argv value. If the prompt is too long
    // for the Windows cmd-line, runAiInit returns an explicit error
    // (not a silent fall-through to a broken command).
    //
    // This test stubs the spawner to capture argv and asserts:
    //   1. No file is written to .vibeflow/ai-context/ai-init-prompt.txt
    //   2. The prompt content IS in args[1] of -p
    //   3. The spawner is called once
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const fakeSpawner = async (cmd: string, args: readonly string[], _input: string) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: "ok", stderr: "", timedOut: false };
    };
    try {
      // Force prompt > 10K
      const bigPrompt = "x".repeat(15000);
      const dir = mkdtempSync(join(tmpdir(), "vf-7b-inline-"));
      const r = await runAiInit({
        base: dir,
        forceEngine: "copilot",
        preflight: () => [
          { engine: "copilot", level: "ready" as const, detail: "ready", checkedAt: "now" },
        ],
        engineCommandFn: () => ({
          cmd: "copilot",
          args: ["-p", "--allow-all-tools"],
          promptMode: "arg" as const,
        }),
        spawner: fakeSpawner as never,
        buildPrompt: () => bigPrompt,
      });
      expect(r.ok).toBe(true);
      // 1. NO file written
      const promptFile = join(dir, ".vibeflow", "ai-context", "ai-init-prompt.txt");
      expect(existsSync(promptFile)).toBe(false);
      // 2. Prompt IS in argv
      const copilotCall = calls.find((c) => c.cmd === "copilot");
      expect(copilotCall).toBeDefined();
      const args = copilotCall?.args ?? [];
      const pFlag = args.findIndex((a) => a === "-p");
      expect(pFlag).toBeGreaterThanOrEqual(0);
      expect(args[pFlag + 1]).toBe(bigPrompt);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  test("copilot on Windows with prompt > 30K chars: returns fail-fast reason (not a silent crash)", async () => {
    // The 32K Windows cmd-line limit is a hard constraint. With the
    // promptFile mechanism removed, runAiInit now fail-fasts with a
    // clear "switch to claude or codex" message instead of letting
    // Windows produce a confusing "command line too long" error.
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const fakeSpawner = async (cmd: string, args: readonly string[], _input: string) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: "ok", stderr: "", timedOut: false };
    };
    try {
      const dir = mkdtempSync(join(tmpdir(), "vf-7b-toolong-"));
      const huge = "x".repeat(31_000);
      const r = await runAiInit({
        base: dir,
        forceEngine: "copilot",
        preflight: () => [
          { engine: "copilot", level: "ready" as const, detail: "ready", checkedAt: "now" },
        ],
        engineCommandFn: () => ({
          cmd: "copilot",
          args: ["-p", "--allow-all-tools"],
          promptMode: "arg" as const,
        }),
        spawner: fakeSpawner as never,
        buildPrompt: () => huge,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("claude or codex");
      // The spawner must NOT have been called.
      expect(calls).toHaveLength(0);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });
});
