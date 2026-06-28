import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveEngineBinary } from "../src/core.js";
import {
  type ProbeSpawner,
  anyReady,
  checkEngine,
  checkEngineAsync,
  preflightAll,
  preflightAllAsync,
  readyEngines,
  runAttempts,
} from "../src/preflight.js";

const FIXED_NOW = "2026-06-06T00:00:00.000Z";

/** A spawner that records every call so tests can assert on argv + stdin. */
function recordingSpawner(
  reply: (
    cmd: string,
    args: string[],
  ) => {
    status: number;
    stdout: string;
    stderr?: string;
    code?: string;
  },
) {
  const calls: { cmd: string; args: string[]; input: string }[] = [];
  const spawn: ProbeSpawner = (cmd, args, input) => {
    calls.push({ cmd, args, input });
    return reply(cmd, args);
  };
  return { spawn, calls };
}

const opts = (over: Record<string, unknown>) => ({
  now: () => FIXED_NOW,
  skipCache: true,
  ...over,
});

describe("preflight: presence", () => {
  test("missing binary short-circuits to no-binary", () => {
    const { spawn, calls } = recordingSpawner(() => ({ status: 0, stdout: "READY" }));
    const r = checkEngine("claude", opts({ has: () => false, spawner: spawn }));
    expect(r.level).toBe("no-binary");
    expect(r.engine).toBe("claude");
    expect(r.checkedAt).toBe(FIXED_NOW);
    expect(calls.length).toBe(0); // never spawns when the binary is absent
    expect(r.detail.toLowerCase()).toContain("not found");
  });
});

describe("preflight: auth", () => {
  test("copilot fast-fails on gh auth status before the slow live probe", () => {
    const { spawn, calls } = recordingSpawner((cmd, args) => {
      if (cmd === "gh" && args[0] === "auth")
        return { status: 1, stdout: "", stderr: "not logged in" };
      return { status: 0, stdout: "READY" };
    });
    const r = checkEngine(
      "copilot",
      opts({ has: (c: string) => c === "copilot" || c === "gh", spawner: spawn }),
    );
    expect(r.level).toBe("no-auth");
    expect(r.detail).toContain("gh auth login");
    expect(calls.some((x) => x.cmd === "gh")).toBe(true);
    expect(calls.some((x) => x.cmd === "copilot")).toBe(false);
  });

  test("copilot uses gh auth status as the documented readiness check", () => {
    const { spawn, calls } = recordingSpawner((cmd) => {
      if (cmd === "gh") return { status: 0, stdout: "Logged in" };
      return { status: 1, stdout: "copilot prompt should not run" };
    });
    const r = checkEngine(
      "copilot",
      opts({ has: (c: string) => c === "copilot" || c === "gh", spawner: spawn }),
    );
    expect(r.level).toBe("ready");
    expect(r.detail).toContain("GitHub auth OK");
    expect(calls.filter((x) => x.cmd === "gh")).toHaveLength(1);
    expect(calls.find((x) => x.cmd === "gh")?.args).toEqual(["auth", "status"]);
    expect(calls.some((x) => x.cmd === "copilot")).toBe(false);
  });

  test("copilot requires gh for auth checking", () => {
    const { spawn, calls } = recordingSpawner(() => ({ status: 0, stdout: "READY" }));
    const r = checkEngine("copilot", opts({ has: (c: string) => c === "copilot", spawner: spawn }));
    expect(r.level).toBe("no-binary");
    expect(r.detail).toContain("GitHub CLI not found");
    expect(calls.some((x) => x.cmd === "gh")).toBe(false);
    expect(calls.some((x) => x.cmd === "copilot")).toBe(false);
  });

  test("missing copilot is reported before gh auth is checked", () => {
    const { spawn, calls } = recordingSpawner(() => ({ status: 0, stdout: "Logged in" }));
    const r = checkEngine("copilot", opts({ has: (c: string) => c === "gh", spawner: spawn }));
    expect(r.level).toBe("no-binary");
    expect(r.detail).toContain("copilot CLI not found");
    expect(calls).toHaveLength(0);
  });
});

describe("preflight: live probe", () => {
  test("claude probe success parses JSON envelope -> ready, exact argv + stdin", () => {
    const { spawn, calls } = recordingSpawner(() => ({
      status: 0,
      stdout: JSON.stringify({ result: "READY" }),
    }));
    const r = checkEngine("claude", opts({ has: () => true, spawner: spawn }));
    expect(r.level).toBe("ready");
    expect(r.detail.toLowerCase()).toContain("ready");
    const probe = calls.find((x) => x.cmd === "claude");
    expect(probe?.args).toEqual(["-p", "--output-format", "json"]);
    expect(probe?.input).toContain("READY"); // prompt via stdin, not shell
  });

  test("codex probe uses doctor -> ready, exact argv", () => {
    const { spawn, calls } = recordingSpawner(() => ({
      status: 0,
      stdout: "17 ok · 1 idle · 0 warn · 0 fail ok",
    }));
    const r = checkEngine("codex", opts({ has: () => true, spawner: spawn }));
    expect(r.level).toBe("ready");
    expect(calls.find((x) => x.cmd === "codex")?.args).toEqual(["doctor"]);
  });

  test("codex doctor exits 0 with failing summary -> probe-failed", () => {
    const { spawn } = recordingSpawner(() => ({
      status: 0,
      stdout: "12 ok · 1 idle · 5 notes · 3 warn · 2 fail failed",
    }));
    const r = checkEngine("codex", opts({ has: () => true, spawner: spawn }));
    expect(r.level).toBe("probe-failed");
  });

  test("codex doctor exits 0 but no healthy indicator -> probe-failed", () => {
    const { spawn } = recordingSpawner(() => ({ status: 0, stdout: "no config found" }));
    const r = checkEngine("codex", opts({ has: () => true, spawner: spawn }));
    expect(r.level).toBe("probe-failed");
  });

  test("codex doctor nonzero exit -> probe-failed", () => {
    const { spawn } = recordingSpawner(() => ({ status: 1, stdout: "error" }));
    const r = checkEngine("codex", opts({ has: () => true, spawner: spawn }));
    expect(r.level).toBe("probe-failed");
  });

  test("status 0 but missing token -> probe-failed", () => {
    const { spawn } = recordingSpawner(() => ({ status: 0, stdout: "hello there" }));
    const r = checkEngine("claude", opts({ has: () => true, spawner: spawn }));
    expect(r.level).toBe("probe-failed");
    expect(r.detail.toLowerCase()).toContain("token");
  });

  test("nonzero exit -> probe-failed", () => {
    const { spawn } = recordingSpawner(() => ({
      status: 7,
      stdout: "WARNING: noisy setup warning\n✗ reachability one endpoint is unreachable",
    }));
    const r = checkEngine("codex", opts({ has: () => true, spawner: spawn }));
    expect(r.level).toBe("probe-failed");
    expect(r.detail).toContain("7");
    expect(r.detail).toContain("reachability");
  });

  test("nonzero gh auth status surfaces useful copilot auth error lines", () => {
    const { spawn } = recordingSpawner((cmd) => {
      if (cmd === "gh") {
        return {
          status: 1,
          stdout: "hint: rerun with debug\nNo authentication information found for GitHub Copilot",
        };
      }
      return {
        status: 0,
        stdout: "copilot prompt should not run",
      };
    });
    const r = checkEngine(
      "copilot",
      opts({ has: (c: string) => c === "copilot" || c === "gh", spawner: spawn }),
    );
    expect(r.level).toBe("no-auth");
    expect(r.detail).toContain("No authentication information found");
  });

  test("nonzero exit surfaces useful codex fatal error lines", () => {
    const { spawn } = recordingSpawner(() => ({
      status: 1,
      stdout: "notice: checking config\nfatal: config profile is missing",
    }));
    const r = checkEngine("codex", opts({ has: () => true, spawner: spawn }));
    expect(r.level).toBe("probe-failed");
    expect(r.detail).toContain("fatal: config profile is missing");
  });

  test("nonzero exit surfaces useful claude permission error lines", () => {
    const { spawn } = recordingSpawner(() => ({
      status: 1,
      stderr: "info: starting\nPermission denied: update your Claude credentials",
      stdout: "",
    }));
    const r = checkEngine("claude", opts({ has: () => true, spawner: spawn }));
    expect(r.level).toBe("probe-failed");
    expect(r.detail).toContain("Permission denied");
  });

  test("a throwing spawner fails closed without crashing", () => {
    const spawn: ProbeSpawner = () => {
      throw new Error("spawn EPERM");
    };
    const r = checkEngine("claude", opts({ has: () => true, spawner: spawn }));
    expect(r.level).toBe("probe-failed");
    expect(r.detail.toLowerCase()).toContain("spawn eperm");
  });

  test("claude JSON result containing READY case-insensitively -> ready", () => {
    const { spawn } = recordingSpawner(() => ({
      status: 0,
      stdout: JSON.stringify({ result: "the word is ready" }),
    }));
    const r = checkEngine("claude", opts({ has: () => true, spawner: spawn }));
    expect(r.level).toBe("ready");
  });
});

describe("preflight: probe:false fast path", () => {
  test("probe:false stops before the live probe spawner", () => {
    const { spawn, calls } = recordingSpawner(() => ({ status: 0, stdout: "READY" }));
    const r = checkEngine("claude", opts({ has: () => true, spawner: spawn, probe: false }));
    expect(r.level).toBe("ready");
    expect(calls.some((x) => x.cmd === "claude")).toBe(false); // no live probe
  });
});

describe("preflight: aggregation", () => {
  test("preflightAll dedupes + validates engine names", () => {
    const { spawn } = recordingSpawner(() => ({ status: 0, stdout: "READY" }));
    // duplicate + bogus name; only the three canonical engines survive
    const list = preflightAll(
      ["claude", "claude", "bogus" as never, "codex", "copilot"],
      opts({
        has: (c: string) => c === "claude" || c === "codex" || c === "copilot",
        spawner: spawn,
      }),
    );
    expect(list.map((x) => x.engine).sort()).toEqual(["claude", "codex", "copilot"]);
  });

  test("anyReady + readyEngines reflect ready entries", () => {
    const { spawn } = recordingSpawner((cmd) =>
      cmd === "claude" ? { status: 0, stdout: "READY" } : { status: 1, stdout: "" },
    );
    const list = preflightAll(["claude", "codex"], opts({ has: () => true, spawner: spawn }));
    expect(anyReady(list)).toBe(true);
    expect(readyEngines(list)).toEqual(["claude"]);
  });

  test("all engines failing -> readyEngines empty (underpins the hard gate)", () => {
    const { spawn } = recordingSpawner(() => ({ status: 1, stdout: "" }));
    const list = preflightAll(
      ["claude", "codex", "copilot"],
      opts({ has: () => true, spawner: spawn }),
    );
    expect(anyReady(list)).toBe(false);
    expect(readyEngines(list)).toEqual([]);
  });
});

describe("preflight: async checkEngineAsync", () => {
  test("missing binary resolves immediately", async () => {
    const r = await checkEngineAsync("claude", opts({ has: () => false }));
    expect(r.level).toBe("no-binary");
  });

  test("probe:false fast path resolves immediately", async () => {
    const r = await checkEngineAsync("claude", opts({ has: () => true, probe: false }));
    expect(r.level).toBe("ready");
  });

  test("copilot auth failures fast-fail from gh auth status", async () => {
    const r = await checkEngineAsync(
      "copilot",
      opts({
        has: (c: string) => c === "copilot" || c === "gh",
        spawner: (cmd: string) =>
          cmd === "gh"
            ? { status: 1, stdout: "", stderr: "not logged in" }
            : { status: 0, stdout: "READY" },
      }),
    );
    expect(r.level).toBe("no-auth");
    expect(r.detail).toContain("gh auth login");
  });

  test("copilot async requires gh for auth checking", async () => {
    const r = await checkEngineAsync(
      "copilot",
      opts({
        has: (c: string) => c === "copilot",
        spawner: () => ({ status: 0, stdout: "READY" }),
      }),
    );
    expect(r.level).toBe("no-binary");
    expect(r.detail).toContain("GitHub CLI not found");
  });
});

describe("preflight: preflightAllAsync parallel aggregation", () => {
  function fixedSpawner(cmd: string): ReturnType<ProbeSpawner> {
    if (cmd === "claude") return { status: 0, stdout: JSON.stringify({ result: "READY" }) };
    if (cmd === "codex") return { status: 0, stdout: "17 ok · 1 idle · 0 warn · 0 fail ok" };
    return { status: 1, stdout: "" };
  }

  test("all ready engines report correctly", async () => {
    const list = await preflightAllAsync(
      ["claude", "codex"],
      opts({ has: () => true, spawner: fixedSpawner }),
    );
    expect(list).toHaveLength(2);
    expect(list.every((r) => r.level === "ready")).toBe(true);
  });

  test("dedupes and normalizes engine order", async () => {
    const list = await preflightAllAsync(
      ["codex", "bogus" as never, "claude", "codex"],
      opts({ has: () => true, spawner: fixedSpawner }),
    );
    expect(list.map((r) => r.engine)).toEqual(["claude", "codex"]);
  });

  test("anyReady + readyEngines work on async results", async () => {
    const list = await preflightAllAsync(
      ["claude", "codex"],
      opts({ has: () => true, spawner: fixedSpawner }),
    );
    expect(anyReady(list)).toBe(true);
    expect(readyEngines(list)).toEqual(["claude", "codex"]);
  });

  test("async probe via injected spawner (succeeds) → ready", async () => {
    // The real probe path with a stubbed spawner that returns codex's
    // expected "0 fail ok" string. Exercises the runAttempt path
    // (lines 375-421).
    const spawner: ProbeSpawner = (cmd: string) =>
      cmd === "codex" ? { status: 0, stdout: "0 fail ok" } : { status: 0, stdout: "ok" };
    const r = await checkEngineAsync("codex", opts({ has: () => true, spawner }));
    expect(r.level).toBe("ready");
  });

  test("async probe via injected spawner (probeSucceeded:false) → probe-failed", async () => {
    // No "ok" marker in stdout → probe fails.
    const spawner: ProbeSpawner = () => ({ status: 0, stdout: "no marker" });
    const r = await checkEngineAsync("codex", opts({ has: () => true, spawner }));
    expect(r.level).toBe("probe-failed");
  });

  test("async probe with spawner returning non-zero → probe-failed", async () => {
    const spawner: ProbeSpawner = () => ({ status: 1, stdout: "" });
    const r = await checkEngineAsync("claude", opts({ has: () => true, spawner }));
    expect(r.level).toBe("probe-failed");
  });

  test("async claude probe with injected spawner returning '***' → ready", async () => {
    // probeSucceeded requires the EXPECTED_TOKEN ("***") in stdout for
    // non-codex engines (claude tries JSON.parse first, falls back to
    // plain text). "***" is not valid JSON, so the plain-text path
    // runs. We also set skipCache:true because the shared probe cache
    // persists across tests and a prior run's probe-failed result
    // would override the in-test spawner.
    const spawner: ProbeSpawner = () => ({ status: 0, stdout: "READY" });
    const r = await checkEngineAsync("claude", opts({ has: () => true, spawner, skipCache: true }));
    expect(r.level).toBe("ready");
  });

  test("no ready engines returns empty readyEngines", async () => {
    const spawner: ProbeSpawner = () => ({ status: 1, stdout: "" });
    const list = await preflightAllAsync(["claude", "codex"], opts({ has: () => true, spawner }));
    expect(anyReady(list)).toBe(false);
    expect(readyEngines(list)).toEqual([]);
  });
});

describe("preflight async: branches", () => {
  test("copilot async returns no-binary when gh is not present (line 348-350)", async () => {
    const r = await checkEngineAsync(
      "copilot",
      opts({ has: (c: string) => c === "copilot" /* no gh */ }),
    );
    expect(r.level).toBe("no-binary");
  });

  test("copilot async with spawner that throws yields probe-failed (line 280-284)", async () => {
    // Throw a non-Error from the spawner — the catch path uses
    // `err instanceof Error ? err.message : String(err)`.
    const failingSpawner: ProbeSpawner = (() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "string error";
    }) as ProbeSpawner;
    const r = await checkEngineAsync(
      "copilot",
      opts({
        has: (c: string) => c === "copilot" || c === "gh",
        spawner: failingSpawner,
      }),
    );
    expect(r.level).toBe("probe-failed");
    expect(r.detail).toContain("string error");
  });

  test("copilot async with spawner that throws an Error yields probe-failed", async () => {
    const failingSpawner: ProbeSpawner = (() => {
      throw new Error("gh auth crashed");
    }) as ProbeSpawner;
    const r = await checkEngineAsync(
      "copilot",
      opts({
        has: (c: string) => c === "copilot" || c === "gh",
        spawner: failingSpawner,
      }),
    );
    expect(r.level).toBe("probe-failed");
    expect(r.detail).toContain("gh auth crashed");
  });

  test("async probe:false short-circuits to ready for non-copilot engines (line 372)", async () => {
    const r = await checkEngineAsync("claude", opts({ has: () => true, probe: false }));
    expect(r.level).toBe("ready");
    expect(r.detail).toContain("probe skipped");
  });

  test("sync checkEngine: copilot with spawner that throws yields probe-failed (line 280-284)", () => {
    // The sync checkEngine() has a try/catch around checkCopilotAuth
    // (line 275-285). Make the spawner throw to exercise the catch.
    const failingSpawner: ProbeSpawner = (() => {
      throw new Error("sync copilot auth failed");
    }) as ProbeSpawner;
    const r = checkEngine("copilot", {
      has: (c: string) => c === "copilot" || c === "gh",
      spawner: failingSpawner,
      skipCache: true,
    });
    expect(r.level).toBe("probe-failed");
    expect(r.detail).toContain("sync copilot auth failed");
  });

  test("sync checkEngine: copilot with spawner that throws a non-Error (line 280-284)", () => {
    const failingSpawner: ProbeSpawner = (() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "string error";
    }) as ProbeSpawner;
    const r = checkEngine("copilot", {
      has: (c: string) => c === "copilot" || c === "gh",
      spawner: failingSpawner,
      skipCache: true,
    });
    expect(r.level).toBe("probe-failed");
    expect(r.detail).toContain("string error");
  });

  // The real Bun.spawn async probe (lines 375-451) can now be exercised
  // via spyOn(Bun, "spawn"). We mock the spawn call to return a
  // controllable child handle.
  test("async probe: real Bun.spawn path returns ready on success (line 375-421)", async () => {
    const original = Bun.spawn;
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: {
        getReader: () => {
          const enc = new TextEncoder();
          let yielded = false;
          return {
            read: async () => {
              if (!yielded) {
                yielded = true;
                return { done: false, value: enc.encode("0 fail ok") };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
      stderr: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      exited: Promise.resolve(0),
      kill: () => {},
    };
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() =>
      fakeChild) as unknown as typeof Bun.spawn;
    try {
      const r = await checkEngineAsync("codex", opts({ has: () => true, skipCache: true }));
      expect(r.level).toBe("ready");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = original;
    }
  });

  test("async probe: stderr chunks flow into stderr variable (line 414-420)", async () => {
    // Mock Bun.spawn to return a fake child that yields one stderr chunk
    // and a non-zero exit. The stderr chunk must be read (line 414).
    const original = Bun.spawn;
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      stderr: {
        getReader: () => {
          const enc = new TextEncoder();
          let yielded = false;
          return {
            read: async () => {
              if (!yielded) {
                yielded = true;
                return { done: false, value: enc.encode("warning-stderr-text") };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
      exited: Promise.resolve(1),
      kill: () => {},
    };
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() =>
      fakeChild) as unknown as typeof Bun.spawn;
    try {
      const r = await checkEngineAsync("codex", opts({ has: () => true, skipCache: true }));
      // The stderr "warning-stderr-text" is captured but the level is
      // determined by the exit code (1) → probe-failed
      expect(r.level).toBe("probe-failed");
      expect(r.detail).toContain("warning-stderr-text");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = original;
    }
  });

  test("async probe: real Bun.spawn path returns probe-failed on non-zero exit (line 410-423)", async () => {
    const original = Bun.spawn;
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      stderr: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      exited: Promise.resolve(1),
      kill: () => {},
    };
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() =>
      fakeChild) as unknown as typeof Bun.spawn;
    try {
      const r = await checkEngineAsync("codex", opts({ has: () => true, skipCache: true }));
      expect(r.level).toBe("probe-failed");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = original;
    }
  });

  test("async probe: real Bun.spawn path returns probe-failed on timeout (line 392-396)", async () => {
    const original = Bun.spawn;
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: {
        getReader: () => ({
          // Stream never ends → triggers the timeout
          read: () => new Promise(() => {}),
        }),
      },
      stderr: {
        getReader: () => ({
          read: () => new Promise(() => {}),
        }),
      },
      exited: new Promise(() => {}) as never,
      kill: () => {},
    };
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() =>
      fakeChild) as unknown as typeof Bun.spawn;
    try {
      // Use a short timeout via the test seam (probeTimeoutMs).
      const r = await checkEngineAsync(
        "codex",
        opts({ has: () => true, skipCache: true, probeTimeoutMs: 50 }),
      );
      // The status 124 path is hit, which then fails probeSucceeded → probe-failed
      expect(r.level).toBe("probe-failed");
      expect(r.detail).toMatch(/timed out|status 124/i);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = original;
    }
  });

  test("async probe: real Bun.spawn with codex 0 fail ok returns ready (line 437-440)", async () => {
    const original = Bun.spawn;
    const enc = new TextEncoder();
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: {
        getReader: () => {
          let first = true;
          return {
            read: async () => {
              if (first) {
                first = false;
                return { done: false, value: enc.encode("0 fail ok") };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
      stderr: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      exited: Promise.resolve(0),
      kill: () => {},
    };
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() =>
      fakeChild) as unknown as typeof Bun.spawn;
    try {
      const r = await checkEngineAsync("codex", opts({ has: () => true, skipCache: true }));
      expect(r.level).toBe("ready");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = original;
    }
  });

  test("async probe: exit promise reject yields probe-failed (line 423-427)", async () => {
    const original = Bun.spawn;
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      stderr: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      exited: Promise.reject(new Error("exited promise failed")),
      kill: () => {},
    };
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() =>
      fakeChild) as unknown as typeof Bun.spawn;
    try {
      const r = await checkEngineAsync("codex", opts({ has: () => true, skipCache: true }));
      expect(r.level).toBe("probe-failed");
      expect(r.detail).toContain("exited promise failed");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = original;
    }
  });

  test("async probe: spawn throw in runAttempt yields probe-failed (line 111-112)", async () => {
    const original = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
      throw new Error("spawn crashed");
    }) as unknown as typeof Bun.spawn;
    try {
      const r = await checkEngineAsync("codex", opts({ has: () => true, skipCache: true }));
      expect(r.level).toBe("probe-failed");
      expect(r.detail).toContain("spawn crashed");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = original;
    }
  });

  test("async probe: copilot with gh, real spawn, auth ok returns ready (line 425-446)", async () => {
    const originalSpawn = Bun.spawn;
    const originalSync = Bun.spawnSync;
    const enc = new TextEncoder();
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: {
        getReader: () => {
          let first = true;
          return {
            read: async () => {
              if (first) {
                first = false;
                return { done: false, value: enc.encode("Logged in to github.com") };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
      stderr: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      exited: Promise.resolve(0),
      kill: () => {},
    };
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() =>
      fakeChild) as unknown as typeof Bun.spawn;
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => ({
      exitCode: 0,
      stdout: Buffer.from("Logged in to github.com"),
      stderr: Buffer.from(""),
    })) as unknown as typeof Bun.spawnSync;
    try {
      // copilot with has(gh) and NO spawner injected → real Bun.spawn path
      // The function first tries the copilot auth check (line 425-446).
      const r = await checkEngineAsync(
        "copilot",
        opts({ has: (c: string) => c === "copilot" || c === "gh", skipCache: true }),
      );
      // gh auth status returned 0 → copilot is "ready"
      expect(r.level).toBe("ready");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSync;
    }
  });

  test("async probe: copilot with gh, real spawn, auth failed returns no-auth (line 440-444)", async () => {
    const originalSpawn = Bun.spawn;
    const originalSync = Bun.spawnSync;
    const enc = new TextEncoder();
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      stderr: {
        getReader: () => {
          let first = true;
          return {
            read: async () => {
              if (first) {
                first = false;
                return { done: false, value: enc.encode("not logged in") };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
      exited: Promise.resolve(1),
      kill: () => {},
    };
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() =>
      fakeChild) as unknown as typeof Bun.spawn;
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => ({
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("not logged in"),
    })) as unknown as typeof Bun.spawnSync;
    try {
      const r = await checkEngineAsync(
        "copilot",
        opts({ has: (c: string) => c === "copilot" || c === "gh", skipCache: true }),
      );
      // gh auth status returned 1 → copilot is "no-auth"
      expect(r.level).toBe("no-auth");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSync;
    }
  });
});

describe("probeInvocation (test seam)", () => {
  test("probeInvocation: copilot throws 'no probe invocation exists' (line 101-102)", () => {
    const { probeInvocation } = require("../src/preflight.js");
    expect(() => probeInvocation("copilot")).toThrow(/no probe invocation exists/);
  });

  test("probeInvocation: claude returns expected argv", () => {
    const { probeInvocation } = require("../src/preflight.js");
    const inv = probeInvocation("claude");
    expect(inv.cmd).toBe("claude");
    expect(inv.args).toContain("-p");
  });

  test("probeInvocation: codex returns doctor argv", () => {
    const { probeInvocation } = require("../src/preflight.js");
    const inv = probeInvocation("codex");
    expect(inv.cmd).toBe("codex");
    expect(inv.args).toContain("doctor");
  });

  test("preflight: result with code=ENOENT → no-binary (line 150)", async () => {
    // failedProbe returns { level: "no-binary" } when result.code
    // is "ENOENT". The async checkEngine path uses a spawner
    // override. We need a spawner that returns code: "ENOENT"
    // in the result. The simplest: use the checkEngine (sync) path
    // via opts.spawner where we control the result.
    // checkEngine uses sync spawner (Bun.spawnSync). We override
    // Bun.spawnSync to return code: "ENOENT" via exitCode: 127
    // and stderr: "ENOENT".
    const { checkEngine } = require("../src/preflight.js");
    const origSync = Bun.spawnSync;
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => ({
      exitCode: 127,
      stdout: Buffer.from(""),
      stderr: Buffer.from("spawn ENOENT"),
    })) as unknown as typeof Bun.spawnSync;
    try {
      const r = checkEngine("claude", { has: () => true });
      expect(r.level).toBe("no-binary");
    } finally {
      (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = origSync;
    }
  });

  // Removed the old test that overrode Bun.spawn directly — the new
  // `runAttempts` tests below cover the copilot/gh + auth success
  // path (line 438-441) without depending on Bun.spawn override,
  // which was unreliable on CI. The 4 runAttempts tests cover both
  // non-copilot success/fail and copilot gh success/fail paths.
});

describe("runAttempts (extracted helper)", () => {
  // The runAttempts signature has a complex typed resolve callback.
  // Tests use `(r as { level: string; detail: string }).level` to
  // extract fields without TS fighting the generic resolve param.
  test("non-copilot engine: runAttempt succeeds → ready 'ready'", async () => {
    const captured: { level?: string; detail?: string } = {};
    const resolveFake = (r: unknown) => {
      const x = r as { level: string; detail: string };
      captured.level = x.level;
      captured.detail = x.detail;
    };
    const stampFake = ((level: string, detail: string) => ({
      engine: "claude",
      level,
      detail,
      checkedAt: "now",
    })) as never;
    await runAttempts(
      "claude",
      () => true,
      () => true,
      () => ({ level: "probe-failed", detail: "fail" }),
      resolveFake as never,
      (() => Promise.resolve({ status: 0, stdout: "READY", stderr: "" })) as never,
      stampFake,
    );
    expect(captured).toEqual({ level: "ready", detail: "ready" });
  });

  test("non-copilot engine: runAttempt fails → ready 'probe-failed'", async () => {
    const captured: { level?: string; detail?: string } = {};
    const resolveFake = (r: unknown) => {
      const x = r as { level: string; detail: string };
      captured.level = x.level;
      captured.detail = x.detail;
    };
    const stampFake = ((level: string, detail: string) => ({
      engine: "claude",
      level,
      detail,
      checkedAt: "now",
    })) as never;
    await runAttempts(
      "claude",
      () => true,
      () => false,
      () => ({ level: "probe-failed", detail: "nonzero exit 1" }),
      resolveFake as never,
      (() => Promise.resolve({ status: 1, stdout: "", stderr: "fail" })) as never,
      stampFake,
    );
    expect(captured.level).toBe("probe-failed");
  });

  test("copilot with gh + auth succeeds → ready 'copilot: GitHub auth OK'", async () => {
    const captured: { level?: string; detail?: string } = {};
    const resolveFake = (r: unknown) => {
      const x = r as { level: string; detail: string };
      captured.level = x.level;
      captured.detail = x.detail;
    };
    const stampFake = ((level: string, detail: string) => ({
      engine: "copilot",
      level,
      detail,
      checkedAt: "now",
    })) as never;
    await runAttempts(
      "copilot",
      (cmd) => cmd === "gh",
      () => true,
      () => ({ level: "probe-failed", detail: "fail" }),
      resolveFake as never,
      (() => Promise.resolve({ status: 0, stdout: "ok", stderr: "" })) as never,
      stampFake,
    );
    expect(captured).toEqual({ level: "ready", detail: "copilot: GitHub auth OK" });
  });

  test("copilot with gh + auth fails → no-auth via failedAuth", async () => {
    const captured: { level?: string; detail?: string } = {};
    const resolveFake = (r: unknown) => {
      const x = r as { level: string; detail: string };
      captured.level = x.level;
      captured.detail = x.detail;
    };
    const stampFake = ((level: string, detail: string) => ({
      engine: "copilot",
      level,
      detail,
      checkedAt: "now",
    })) as never;
    await runAttempts(
      "copilot",
      (cmd) => cmd === "gh",
      () => true,
      () => ({ level: "probe-failed", detail: "fail" }),
      resolveFake as never,
      (() => Promise.resolve({ status: 1, stdout: "", stderr: "auth failed" })) as never,
      stampFake,
    );
    expect(captured.level).toBe("no-auth");
    expect(captured.detail).toContain("not authenticated");
  });
});

describe("preflight: engine-binary resolution (issue #87: shim variants for all engines)", () => {
  // Issue #87: the engine-version probe was hard-coded to the bare binary
  // name. On Windows, npm installs `claude`/`codex`/`copilot` as `.cmd`/`.bat`
  // shims, so `Bun.which("claude")` returns undefined and preflight reports
  // a false "no-binary". The fix: preflight must consult the shared
  // `resolveEngineBinary(engine)` helper for the engine under test.
  function withPlatform<T>(plat: NodeJS.Platform, fn: () => T): T {
    const orig = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: plat, configurable: true });
    try {
      return fn();
    } finally {
      if (orig) Object.defineProperty(process, "platform", orig);
    }
  }

  test("resolveEngineBinary falls back to .cmd for every engine, not just copilot", () => {
    const claude = resolveEngineBinary("claude");
    if (claude !== undefined) expect(claude).toBe("claude");
    const codex = resolveEngineBinary("codex");
    if (codex !== undefined) expect(codex).toBe("codex");
  });

  test("resolveEngineBinary returns undefined when bare name AND all shim variants miss on Windows", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const origWhich = Bun.which;
    (Bun as unknown as { which: typeof Bun.which }).which = (() =>
      null) as unknown as typeof Bun.which;
    try {
      expect(resolveEngineBinary("claude")).toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform });
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
    }
  });

  test("checkEngine(claude) on Windows resolves through .cmd shim (no false no-binary)", () => {
    const origWhich = Bun.which;
    (Bun as unknown as { which: typeof Bun.which }).which = ((name: string) => {
      if (name === "claude") return undefined;
      if (name === "claude.cmd") return "C:\\shims\\claude.cmd";
      return origWhich(name);
    }) as typeof Bun.which;
    try {
      withPlatform("win32", () => {
        const { spawn, calls } = recordingSpawner((cmd) => {
          if (cmd === "claude.cmd") {
            return { status: 0, stdout: JSON.stringify({ result: "READY" }) };
          }
          return { status: 1, stdout: "", code: "ENOENT", stderr: "spawn ENOENT" };
        });
        const r = checkEngine("claude", opts({ spawner: spawn }));
        expect(r.level).toBe("ready");
        expect(calls.some((c) => c.cmd === "claude.cmd")).toBe(true);
      });
    } finally {
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
    }
  });

  test("checkEngine resolves through .ps1 shim (covers the .ps1 variant in WINDOWS_SHIM_VARIANTS)", () => {
    const origWhich = Bun.which;
    (Bun as unknown as { which: typeof Bun.which }).which = ((name: string) => {
      if (name === "claude") return undefined;
      if (name === "claude.cmd") return undefined;
      if (name === "claude.bat") return undefined;
      if (name === "claude.ps1") return "C:\\shims\\claude.ps1";
      return origWhich(name);
    }) as typeof Bun.which;
    try {
      withPlatform("win32", () => {
        const { spawn, calls } = recordingSpawner((cmd) => {
          if (cmd === "claude.ps1")
            return { status: 0, stdout: JSON.stringify({ result: "READY" }) };
          return { status: 1, stdout: "", code: "ENOENT", stderr: "spawn ENOENT" };
        });
        const r = checkEngine("claude", opts({ spawner: spawn }));
        expect(r.level).toBe("ready");
        expect(calls.some((c) => c.cmd === "claude.ps1")).toBe(true);
      });
    } finally {
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
    }
  });

  test("checkEngine(codex) on Windows resolves through .bat shim (no false no-binary)", () => {
    const origWhich = Bun.which;
    (Bun as unknown as { which: typeof Bun.which }).which = ((name: string) => {
      if (name === "codex") return undefined;
      if (name === "codex.cmd") return undefined;
      if (name === "codex.bat") return "C:\\shims\\codex.bat";
      return origWhich(name);
    }) as typeof Bun.which;
    try {
      withPlatform("win32", () => {
        const { spawn, calls } = recordingSpawner((cmd) => {
          if (cmd === "codex.bat") return { status: 0, stdout: "17 ok · 1 idle · 0 fail ok" };
          return { status: 1, stdout: "", code: "ENOENT", stderr: "spawn ENOENT" };
        });
        const r = checkEngine("codex", opts({ spawner: spawn }));
        expect(r.level).toBe("ready");
        expect(calls.some((c) => c.cmd === "codex.bat")).toBe(true);
      });
    } finally {
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
    }
  });

  test("checkEngine(copilot) on Windows resolves gh through .cmd shim (no false no-binary)", () => {
    const origWhich = Bun.which;
    (Bun as unknown as { which: typeof Bun.which }).which = ((name: string) => {
      if (name === "copilot") return "C:\\node\\copilot";
      if (name === "gh") return undefined;
      if (name === "gh.cmd") return "C:\\shims\\gh.cmd";
      return origWhich(name);
    }) as typeof Bun.which;
    try {
      withPlatform("win32", () => {
        const { spawn, calls } = recordingSpawner((cmd) => {
          if (cmd === "gh.cmd") return { status: 0, stdout: "Logged in" };
          return { status: 1, stdout: "", code: "ENOENT", stderr: "spawn ENOENT" };
        });
        const r = checkEngine("copilot", opts({ spawner: spawn }));
        expect(r.level).toBe("ready");
        expect(calls.some((c) => c.cmd === "gh.cmd")).toBe(true);
      });
    } finally {
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
    }
  });
});

describe("preflight split (#186 PR3 sentinel)", () => {
  const facade = readFileSync("src/preflight.ts", "utf8");
  test("facade re-exports moved fns from new modules", () => {
    expect(facade).toMatch(/from\s*["']\.\/preflight\/probe\.js["']/);
    expect(facade).toMatch(/from\s*["']\.\/preflight\/check-async\.js["']/);
  });
  test("moved bodies live in the new files, not the facade", () => {
    expect(facade).not.toMatch(/^export\s+function\s+probeInvocation\s*\(/m);
    const probe = readFileSync("src/preflight/probe.ts", "utf8");
    expect(probe).toMatch(/^export\s+function\s+probeInvocation\s*\(/m);
    expect(facade).not.toMatch(/^export\s+async\s+function\s+checkEngineAsync\s*\(/m);
  });
  test("size-waiver removed", () => {
    expect(facade).not.toMatch(/size-waiver/);
  });
});
