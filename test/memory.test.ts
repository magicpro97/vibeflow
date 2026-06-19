import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CTX_DIR } from "../src/core.js";
import {
  appendMemoryGuide,
  buildMemoryGuide,
  ensureInstalled,
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

describe("memory.ensureInstalled", () => {
  test("short-circuits ok when claude-mem is already installed (no spawn)", async () => {
    let spawned = false;
    const res = await ensureInstalled({
      has: () => true,
      spawner: (() => {
        spawned = true;
        return { status: 0 };
      }) as never,
    });
    expect(res).toEqual({ ok: true });
    expect(spawned).toBe(false);
  });

  test("runs the non-interactive installer and returns ok on status 0", async () => {
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const res = await ensureInstalled({
      has: () => false,
      spawner: ((cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args });
        return { status: 0 };
      }) as never,
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("npx");
    expect(calls[0]?.args).toEqual([
      "-y",
      "claude-mem",
      "install",
      "--provider",
      "claude",
      "--no-auto-start",
    ]);
  });

  test("returns ok=false with the stderr reason on a nonzero exit", async () => {
    const res = await ensureInstalled({
      has: () => false,
      spawner: (() => ({ status: 1, stderr: "network down" })) as never,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("network down");
  });

  test("falls back to an exit-code reason when stderr is empty", async () => {
    const res = await ensureInstalled({
      has: () => false,
      spawner: (() => ({ status: 7, stderr: "" })) as never,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("7");
  });

  test("never throws — a throwing spawner yields ok=false with a reason", async () => {
    const res = await ensureInstalled({
      has: () => false,
      spawner: (() => {
        throw new Error("ENOENT npx");
      }) as never,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("ENOENT npx");
  });

  test("forwards the timeout bound and cwd to the spawner", async () => {
    let seen: { timeout?: number; cwd?: string } | undefined;
    await ensureInstalled({
      has: () => false,
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
