import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CTX_DIR, type Engine } from "../src/core.js";
import {
  ENGINE_IDE,
  appendMemoryGuide,
  buildMemoryGuide,
  ensureInstalledForEngines,
  installForEngine,
  isInstalled,
} from "../src/memory.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-memory-"));
}

/** Write a WORKFLOW_POLICY.md into the repo's canonical context dir. */
function writePolicy(base: string, content: string): string {
  const p = join(base, CTX_DIR, "WORKFLOW_POLICY.md");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

describe("memory.isInstalled", () => {
  test("returns true when the injected PATH check finds claude-mem", () => {
    expect(isInstalled({ has: (cmd) => cmd === "claude-mem" })).toBe(true);
  });

  test("returns false when the injected PATH check misses", () => {
    expect(isInstalled({ has: () => false })).toBe(false);
  });

  test("defaults to the real hasCommand when no override is given", () => {
    // The real PATH lookup is harmless (no subprocess); just assert a boolean.
    expect(typeof isInstalled()).toBe("boolean");
  });
});

describe("memory.ENGINE_IDE", () => {
  test("maps each VibeFlow engine to claude-mem's exact --ide id", () => {
    expect(ENGINE_IDE).toEqual({
      claude: "claude-code",
      codex: "codex-cli",
      copilot: "copilot-cli",
    });
  });
});

describe("memory.installForEngine", () => {
  test("runs the non-interactive installer with the engine's --ide and returns ok on status 0", () => {
    const calls: { cmd: string; args: readonly string[]; opts: unknown }[] = [];
    const res = installForEngine("codex", {
      spawner: ((cmd: string, args: readonly string[], opts: unknown) => {
        calls.push({ cmd, args, opts });
        return { status: 0 };
      }) as never,
    });
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("npx");
    expect(calls[0]?.args).toEqual([
      "-y",
      "claude-mem",
      "install",
      "--ide",
      "codex-cli",
      "--provider",
      "claude",
      "--no-auto-start",
    ]);
  });

  test("pins claude-mem version when opts.version is set (MUST-FIX PR #160: supply-chain hardening)", () => {
    const calls: { args: readonly string[] }[] = [];
    installForEngine("claude", {
      version: "1.2.3",
      spawner: ((cmd: string, args: readonly string[]) => {
        calls.push({ args });
        return { status: 0 };
      }) as never,
    });
    expect(calls[0]?.args[1]).toBe("claude-mem@1.2.3");
  });

  test("uses VF_CLAUDE_MEM_VERSION env var when opts.version is unset", () => {
    const orig = process.env.VF_CLAUDE_MEM_VERSION;
    process.env.VF_CLAUDE_MEM_VERSION = "2.0.0";
    try {
      const calls: { args: readonly string[] }[] = [];
      installForEngine("claude", {
        spawner: ((cmd: string, args: readonly string[]) => {
          calls.push({ args });
          return { status: 0 };
        }) as never,
      });
      expect(calls[0]?.args[1]).toBe("claude-mem@2.0.0");
    } finally {
      if (orig === undefined) process.env.VF_CLAUDE_MEM_VERSION = undefined;
      else process.env.VF_CLAUDE_MEM_VERSION = orig;
    }
  });

  test("inherits stdio so the installer streams live (no perceived hang)", () => {
    let seenStdio: unknown;
    installForEngine("claude", {
      spawner: ((_cmd: string, _args: readonly string[], opts: { stdio?: unknown }) => {
        seenStdio = opts.stdio;
        return { status: 0 };
      }) as never,
    });
    expect(seenStdio).toBe("inherit");
  });

  test("returns ok=false with an exit-code reason on a nonzero exit", () => {
    const res = installForEngine("copilot", {
      spawner: (() => ({ status: 7 })) as never,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("7");
    expect(res.reason).toContain("copilot-cli");
  });

  test("reports a timeout (killed by signal) distinctly", () => {
    const res = installForEngine("claude", {
      spawner: (() => ({ status: null, signal: "SIGTERM" })) as never,
    });
    expect(res.ok).toBe(false);
    expect(res.reason?.toLowerCase()).toContain("timed out");
  });

  test("never throws — a throwing spawner yields ok=false with a reason", () => {
    const res = installForEngine("claude", {
      spawner: (() => {
        throw new Error("ENOENT npx");
      }) as never,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("ENOENT npx");
  });

  test("forwards the timeout bound and cwd to the spawner", () => {
    let seen: { timeout?: number; cwd?: string } | undefined;
    installForEngine("claude", {
      timeoutMs: 5000,
      cwd: "/tmp/proj",
      spawner: ((_cmd: string, _args: readonly string[], o: { timeout?: number; cwd?: string }) => {
        seen = o;
        return { status: 0 };
      }) as never,
    });
    expect(seen?.timeout).toBe(5000);
    expect(seen?.cwd).toBe("/tmp/proj");
  });
});

describe("memory.ensureInstalledForEngines", () => {
  test("wires every engine and records them in order", () => {
    const ides: string[] = [];
    const res = ensureInstalledForEngines(["claude", "codex", "copilot"], {
      spawner: ((_cmd: string, args: readonly string[]) => {
        ides.push(args[args.indexOf("--ide") + 1] as string);
        return { status: 0 };
      }) as never,
    });
    expect(res.wired).toEqual(["claude", "codex", "copilot"]);
    expect(res.failed).toEqual([]);
    // One installer invocation per engine, each with the matching --ide id.
    expect(ides).toEqual(["claude-code", "codex-cli", "copilot-cli"]);
  });

  test("is best-effort: one engine failing does not block the others", () => {
    const res = ensureInstalledForEngines(["claude", "codex", "copilot"], {
      spawner: ((_cmd: string, args: readonly string[]) => {
        // codex fails, the rest succeed.
        const ide = args[args.indexOf("--ide") + 1];
        return ide === "codex-cli" ? { status: 1 } : { status: 0 };
      }) as never,
    });
    expect(res.wired).toEqual(["claude", "copilot"]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]?.engine).toBe("codex");
    expect(res.failed[0]?.reason).toContain("codex-cli");
  });

  test("de-duplicates engines, preserving first-seen order (one install each)", () => {
    let calls = 0;
    const res = ensureInstalledForEngines(["claude", "claude", "codex"] as Engine[], {
      spawner: (() => {
        calls++;
        return { status: 0 };
      }) as never,
    });
    expect(res.wired).toEqual(["claude", "codex"]);
    expect(calls).toBe(2);
  });

  test("an empty engine list installs nothing and reports nothing", () => {
    let calls = 0;
    const res = ensureInstalledForEngines([], {
      spawner: (() => {
        calls++;
        return { status: 0 };
      }) as never,
    });
    expect(res).toEqual({ wired: [], failed: [] });
    expect(calls).toBe(0);
  });
});

describe("memory.buildMemoryGuide", () => {
  test("renders the claude-mem header and the search command", () => {
    const guide = buildMemoryGuide();
    expect(guide).toContain("## Memory: claude-mem");
    expect(guide).toContain('claude-mem search "<topic or task name>"');
  });
});

describe("memory.appendMemoryGuide", () => {
  test("appends the guide to an existing WORKFLOW_POLICY.md and returns true", () => {
    const dir = tmpRepo();
    try {
      const p = writePolicy(dir, "# Workflow Policy\n\n- existing rule\n");
      expect(appendMemoryGuide(dir)).toBe(true);
      const after = readFileSync(p, "utf8");
      expect(after).toContain("- existing rule");
      expect(after).toContain("## Memory: claude-mem");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent — a second call does not duplicate the block", () => {
    const dir = tmpRepo();
    try {
      const p = writePolicy(dir, "# Workflow Policy\n");
      expect(appendMemoryGuide(dir)).toBe(true);
      expect(appendMemoryGuide(dir)).toBe(false);
      const after = readFileSync(p, "utf8");
      const occurrences = after.split("## Memory: claude-mem").length - 1;
      expect(occurrences).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns false when WORKFLOW_POLICY.md is absent (never throws)", () => {
    const dir = tmpRepo();
    try {
      expect(appendMemoryGuide(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
