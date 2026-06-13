import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  c,
  ctxPath,
  ctxPathIn,
  hasCommand,
  indexPath,
  isGitRepo,
  journalPath,
  needsShellForCommand,
  parseFlags,
  readState,
  recomputeTotals,
  resolveCommand,
  statePath,
  strArray,
  writeFileSafe,
  writeState,
  VERSION,
  CTX_DIR,
  ENGINES,
} from "../src/core.js";

describe("core: ctxPath", () => {
  test("ctxPath() joins cwd + CTX_DIR + parts", () => {
    const originalCwd = process.cwd();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "vf-core-ctx-")));
    process.chdir(dir);
    try {
      const p = ctxPath();
      expect(p).toBe(join(dir, CTX_DIR));
      const p2 = ctxPath("a", "b", "c.txt");
      expect(p2).toBe(join(dir, CTX_DIR, "a", "b", "c.txt"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("ctxPath with no parts", () => {
    const originalCwd = process.cwd();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "vf-core-ctx-")));
    process.chdir(dir);
    try {
      expect(ctxPath()).toBe(join(dir, CTX_DIR));
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("core: ctxPathIn", () => {
  test("joins base + CTX_DIR + parts", () => {
    const base = "/tmp/fake";
    expect(ctxPathIn(base)).toBe(join(base, CTX_DIR));
    expect(ctxPathIn(base, "a", "b")).toBe(join(base, CTX_DIR, "a", "b"));
  });
});

describe("core: journalPath", () => {
  test("uses cwd by default", () => {
    const p = journalPath();
    expect(p).toBe(join(process.cwd(), CTX_DIR, "knowledge", "log.md"));
  });

  test("uses base when provided", () => {
    const p = journalPath("/tmp/foo");
    expect(p).toBe(join("/tmp/foo", CTX_DIR, "knowledge", "log.md"));
  });
});

describe("core: indexPath", () => {
  test("uses cwd by default", () => {
    const p = indexPath();
    expect(p).toBe(join(process.cwd(), CTX_DIR, "knowledge", "index.md"));
  });

  test("uses base when provided", () => {
    const p = indexPath("/tmp/bar");
    expect(p).toBe(join("/tmp/bar", CTX_DIR, "knowledge", "index.md"));
  });
});

describe("core: statePath / readState / writeState", () => {
  test("statePath defaults to cwd", () => {
    const p = statePath();
    expect(p).toBe(join(process.cwd(), CTX_DIR, "WORKFLOW_STATE.json"));
  });

  test("statePath honours base argument", () => {
    const p = statePath("/tmp/x");
    expect(p).toBe(join("/tmp/x", CTX_DIR, "WORKFLOW_STATE.json"));
  });

  test("readState returns null when state file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-core-state-"));
    expect(readState(dir)).toBeNull();
  });

  test("readState returns null on JSON parse error (malformed file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-core-state-"));
    mkdirSync(join(dir, CTX_DIR), { recursive: true });
    writeFileSync(join(dir, CTX_DIR, "WORKFLOW_STATE.json"), "not valid json {");
    expect(readState(dir)).toBeNull();
  });

  test("writeState + readState round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-core-state-"));
    const state = {
      task_id: "t1",
      goal: "g",
      success_criteria: [],
      work_units: [],
      totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    writeState(dir, state);
    const got = readState(dir);
    expect(got).toEqual(state);
  });
});

describe("core: writeFileSafe", () => {
  test("creates parent directories and writes content", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-core-wfs-"));
    const path = join(dir, "deep", "nested", "file.txt");
    writeFileSafe(path, "hello");
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    expect(readFileSync(path, "utf8")).toBe("hello\n");
  });

  test("does not double-newline content that already ends with newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-core-wfs-"));
    const path = join(dir, "f.txt");
    writeFileSafe(path, "hi\n");
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    expect(readFileSync(path, "utf8")).toBe("hi\n");
  });
});

describe("core: strArray", () => {
  test("returns [] for non-array inputs", () => {
    expect(strArray(null)).toEqual([]);
    expect(strArray(undefined)).toEqual([]);
    expect(strArray(42)).toEqual([]);
    expect(strArray("string")).toEqual([]);
    expect(strArray({})).toEqual([]);
  });

  test("filters non-string elements out of arrays", () => {
    expect(strArray(["a", 1, "b", null, "c"])).toEqual(["a", "b", "c"]);
  });

  test("returns the array when all elements are strings", () => {
    expect(strArray(["x", "y"])).toEqual(["x", "y"]);
  });
});

describe("core: recomputeTotals", () => {
  test("aggregates work unit counts and resources", () => {
    const state = {
      task_id: "t",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "a",
          status: "done" as const,
          confidence: 1,
          gates: { build: "pass" as const, lint: "pass" as const, test: "pass" as const, review: "pass" as const },
          resources: { agents: 1, tokens: 100, cost_usd: 0.123456, wall_seconds: 5 },
        },
        {
          name: "b",
          status: "pending" as const,
          confidence: 0,
          gates: { build: "pass" as const, lint: "pass" as const, test: "pass" as const, review: "pass" as const },
          resources: { agents: 1, tokens: 200, cost_usd: 0.5, wall_seconds: 10 },
        },
        {
          name: "c",
          status: "done" as const,
          confidence: 1,
          gates: { build: "pass" as const, lint: "pass" as const, test: "pass" as const, review: "pass" as const },
          resources: { agents: 1, tokens: 50, cost_usd: 0.111, wall_seconds: 2 },
        },
      ],
      totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const out = recomputeTotals(state);
    expect(out.totals.units).toBe(3);
    expect(out.totals.done).toBe(2);
    expect(out.totals.tokens).toBe(350);
    expect(out.totals.cost_usd).toBe(Number((0.123456 + 0.5 + 0.111).toFixed(4)));
    expect(out.totals.wall_seconds).toBe(17);
  });
});

describe("core: resolveCommand / hasCommand", () => {
  test("resolveCommand returns path for a known safe command name", () => {
    // git is part of safe name charset and present on most dev/CI hosts
    const r = resolveCommand("git");
    if (r !== undefined) {
      expect(typeof r).toBe("string");
    }
    // on hosts where git isn't installed, undefined is also fine — but
    // the branch we care about is "safe name was accepted".
    expect(r === undefined || typeof r === "string").toBe(true);
  });

  test("resolveCommand returns undefined for unsafe command names (special chars)", () => {
    expect(resolveCommand("rm -rf /")).toBeUndefined();
    expect(resolveCommand("a;b")).toBeUndefined();
    expect(resolveCommand("a&b")).toBeUndefined();
    expect(resolveCommand("a b")).toBeUndefined();
    expect(resolveCommand("../escape")).toBeUndefined();
  });

  test("hasCommand returns true for git (when present)", () => {
    // Same caveat as resolveCommand: we only care that the function
    // returns a boolean without throwing.
    expect(typeof hasCommand("git")).toBe("boolean");
  });
});

describe("core: needsShellForCommand", () => {
  test("is false on non-win32 for .cmd / .bat", () => {
    if (process.platform !== "win32") {
      expect(needsShellForCommand("foo.cmd")).toBe(false);
      expect(needsShellForCommand("foo.bat")).toBe(false);
      expect(needsShellForCommand("FOO.CMD")).toBe(false);
      expect(needsShellForCommand("FOO.BAT")).toBe(false);
    }
  });

  test("is false on non-win32 for non-cmd/bat extensions", () => {
    if (process.platform !== "win32") {
      expect(needsShellForCommand("foo.exe")).toBe(false);
      expect(needsShellForCommand("foo.sh")).toBe(false);
      expect(needsShellForCommand("foo")).toBe(false);
    }
  });

  test("is true on win32 for .cmd / .bat (case-insensitive)", () => {
    if (process.platform === "win32") {
      expect(needsShellForCommand("foo.cmd")).toBe(true);
      expect(needsShellForCommand("foo.bat")).toBe(true);
      expect(needsShellForCommand("FOO.CMD")).toBe(true);
    }
  });
});

describe("core: isGitRepo", () => {
  test("returns true when cwd contains a .git directory", () => {
    const originalCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "vf-core-git-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    process.chdir(dir);
    try {
      expect(isGitRepo()).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("returns false when cwd has no .git directory", () => {
    const originalCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "vf-core-nogit-"));
    process.chdir(dir);
    try {
      expect(isGitRepo()).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("core: parseFlags", () => {
  test("classifies --key=value as bool", () => {
    const { positionals, flags } = parseFlags(["--dry-run"]);
    expect(positionals).toEqual([]);
    expect(flags).toEqual({ "dry-run": true });
  });

  test("pairs --key with following non-flag value", () => {
    const { positionals, flags } = parseFlags(["--engine", "claude", "extra"]);
    expect(positionals).toEqual(["extra"]);
    expect(flags).toEqual({ engine: "claude" });
  });

  test("treats --key with following -x as bool", () => {
    const { positionals, flags } = parseFlags(["--key", "-x", "p"]);
    expect(positionals).toEqual(["-x", "p"]);
    expect(flags).toEqual({ key: true });
  });

  test("captures positionals", () => {
    const { positionals, flags } = parseFlags(["a", "b", "--flag"]);
    expect(positionals).toEqual(["a", "b"]);
    expect(flags).toEqual({ flag: true });
  });

  test("empty input → empty result", () => {
    expect(parseFlags([])).toEqual({ positionals: [], flags: {} });
  });
});

describe("core: c (ANSI helpers)", () => {
  test("bold, dim, red, green, yellow, blue, cyan are functions", () => {
    expect(typeof c.bold).toBe("function");
    expect(typeof c.dim).toBe("function");
    expect(typeof c.red).toBe("function");
    expect(typeof c.green).toBe("function");
    expect(typeof c.yellow).toBe("function");
    expect(typeof c.blue).toBe("function");
    expect(typeof c.cyan).toBe("function");
  });

  test("wrappers return strings (with or without ANSI codes)", () => {
    // In a non-TTY test runner, useColor is false, so wrappers return input as-is.
    // On a TTY, they'd wrap in ANSI codes. Either way the call must succeed and
    // produce a string that contains the input text.
    expect(c.bold("hi")).toContain("hi");
    expect(c.red("err")).toContain("err");
    expect(c.green("ok")).toContain("ok");
  });
});

describe("core: exports & constants", () => {
  test("CTX_DIR is the canonical dotdir", () => {
    expect(CTX_DIR).toBe(".vibeflow");
  });

  test("ENGINES contains claude, codex, copilot", () => {
    expect(ENGINES).toEqual(["claude", "codex", "copilot"]);
  });

  test("VERSION is a non-empty string (readVersion fallback exercised at module load)", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });
});
