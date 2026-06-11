import { describe, expect, test } from "bun:test";
import {
  type ProbeSpawner,
  anyReady,
  checkEngine,
  checkEngineAsync,
  preflightAll,
  preflightAllAsync,
  readyEngines,
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

const opts = (over: Record<string, unknown>) => ({ now: () => FIXED_NOW, ...over });

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

  test("no ready engines returns empty readyEngines", async () => {
    const spawner: ProbeSpawner = () => ({ status: 1, stdout: "" });
    const list = await preflightAllAsync(["claude", "codex"], opts({ has: () => true, spawner }));
    expect(anyReady(list)).toBe(false);
    expect(readyEngines(list)).toEqual([]);
  });
});
