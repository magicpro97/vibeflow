import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RegistryEntry,
  type RegistryLock,
  handleRegistrySubcommand,
  parseRegistryLock,
  registryAdd,
  registryCacheDir,
  registryList,
  registryLockPath,
  registryUpdate,
  writeRegistryLock,
} from "../src/skills/registry-channel.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "vf-reg-"));
  dirs.push(d);
  return d;
}

function fakeGit(opts: { status?: number; stdout?: string; stderr?: string } = {}) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn = (
    _cmd: string,
    args: readonly string[],
    _opts: Record<string, unknown>,
  ): { status: number; stdout: string; stderr: string } => {
    calls.push({ cmd: _cmd, args: [...args] });
    return { status: opts.status ?? 0, stdout: opts.stdout ?? "", stderr: opts.stderr ?? "" };
  };
  return { calls, spawn };
}

describe("parseRegistryLock", () => {
  test("file missing → empty lock", () => {
    const repo = tmpRepo();
    const lock = parseRegistryLock(repo);
    expect(lock.schemaVersion).toBe(1);
    expect(lock.registries).toEqual([]);
  });

  test("valid lock file → parsed entries", () => {
    const repo = tmpRepo();
    const p = registryLockPath(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "platform",
            url: "https://github.com/x/platform.git",
            ref: "v1.0",
            commitOID: "abc123def456",
          },
          {
            name: "data",
            url: "https://github.com/x/data.git",
            ref: "main",
            commitOID: "def789abc012",
          },
        ],
      }),
    );
    const lock = parseRegistryLock(repo);
    expect(lock.registries).toHaveLength(2);
    expect(lock.registries[0]?.name).toBe("platform");
    expect(lock.registries[0]?.commitOID).toBe("abc123def456");
    expect(lock.registries[1]?.ref).toBe("main");
  });

  test("malformed JSON → empty lock", () => {
    const repo = tmpRepo();
    const p = registryLockPath(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(p, "not-json");
    const lock = parseRegistryLock(repo);
    expect(lock.registries).toEqual([]);
  });

  test("wrong schemaVersion → empty lock", () => {
    const repo = tmpRepo();
    const p = registryLockPath(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(p, JSON.stringify({ schemaVersion: 2, registries: [] }));
    const lock = parseRegistryLock(repo);
    expect(lock.registries).toEqual([]);
  });

  test("skips malformed entries", () => {
    const repo = tmpRepo();
    const p = registryLockPath(repo);
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          { name: "good", url: "https://x.com/g.git", ref: "main", commitOID: "aaa" },
          { name: "bad", url: 42, ref: "main", commitOID: "bbb" },
          { name: "missing-oid", url: "https://x.com/m.git", ref: "main" },
        ],
      }),
    );
    const lock = parseRegistryLock(repo);
    expect(lock.registries).toHaveLength(1);
    expect(lock.registries[0]?.name).toBe("good");
  });
});

describe("writeRegistryLock", () => {
  test("writes valid JSON to lock path", () => {
    const repo = tmpRepo();
    const lock: RegistryLock = {
      schemaVersion: 1,
      registries: [{ name: "t", url: "https://x.com/t.git", ref: "v1", commitOID: "abc" }],
    };
    writeRegistryLock(repo, lock);
    const p = registryLockPath(repo);
    expect(existsSync(p)).toBe(true);
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.registries).toHaveLength(1);
  });

  test("write failure preserves existing lock (atomicity)", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    const original: RegistryLock = {
      schemaVersion: 1,
      registries: [
        { name: "keep", url: "https://x.com/keep.git", ref: "v1", commitOID: "original-oid" },
      ],
    };
    writeRegistryLock(repo, original);
    const p = registryLockPath(repo);
    const originalContent = readFileSync(p, "utf8");

    const throwingWrite = (_path: string, _content: string) => {
      throw new Error("simulated write failure");
    };
    const newLock: RegistryLock = {
      schemaVersion: 1,
      registries: [{ name: "new", url: "https://x.com/new.git", ref: "v2", commitOID: "new-oid" }],
    };
    expect(() => writeRegistryLock(repo, newLock, { writeFileSafe: throwingWrite })).toThrow(
      "simulated write failure",
    );
    // Original lock file unchanged
    expect(readFileSync(p, "utf8")).toBe(originalContent);
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    expect(parsed.registries).toHaveLength(1);
    expect(parsed.registries[0]?.name).toBe("keep");
  });
});

describe("registryCacheDir", () => {
  test("resolves to ~/.vibeflow/skill-registries/<sha256-truncated>", () => {
    const dir = registryCacheDir("https://github.com/x/platform.git");
    expect(dir).toContain(".vibeflow");
    expect(dir).toContain("skill-registries");
    expect(dir).not.toContain("platform");
    // SHA-256 of "https://github.com/x/platform.git" truncated to 16 hex chars
    expect(dir).toMatch(/[0-9a-f]{16}$/);
  });

  test("different URLs produce different cache dirs", () => {
    const a = registryCacheDir("https://github.com/x/a.git");
    const b = registryCacheDir("https://github.com/x/b.git");
    expect(a).not.toBe(b);
  });
});

describe("registryAdd", () => {
  test("dry-run (no --yes): prints planned git ops, returns 0, no network", () => {
    const repo = tmpRepo();
    const { calls, spawn } = fakeGit();
    const code = registryAdd(repo, "https://github.com/x/skills.git", "platform", "v1.0", {
      spawnSync: spawn as never,
    });
    expect(code).toBe(0);
    // No git commands executed in dry-run
    expect(calls).toHaveLength(0);
    // Lock file NOT written
    expect(existsSync(registryLockPath(repo))).toBe(false);
  });

  test("validates name format", () => {
    const repo = tmpRepo();
    const { spawn } = fakeGit();
    const code = registryAdd(repo, "https://x.com/s.git", "UPPERCASE", "v1", { spawnSync: spawn });
    expect(code).toBe(2);
  });

  test("rejects duplicate name", () => {
    const repo = tmpRepo();
    const lock: RegistryLock = {
      schemaVersion: 1,
      registries: [{ name: "dup", url: "https://x.com/d.git", ref: "v1", commitOID: "aaa" }],
    };
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, lock);
    const { spawn } = fakeGit();
    const code = registryAdd(repo, "https://x.com/d2.git", "dup", "v1", { spawnSync: spawn });
    expect(code).toBe(1);
  });

  test("with --yes: executes git clone/fetch/checkout, writes lock", () => {
    const repo = tmpRepo();
    const { calls, spawn } = fakeGit({ stdout: "deadbeef123456789012345678901234567890\n" });
    const code = registryAdd(repo, "https://github.com/x/skills.git", "platform", "v1.0", {
      spawnSync: spawn,
      yes: true,
    });
    expect(code).toBe(0);
    // First 4 ops: clone, fetch, checkout, rev-parse, plus final rev-parse = 5
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(calls[0]?.args[0]).toBe("clone");
    // Lock file written with correct OID
    const lock = parseRegistryLock(repo);
    expect(lock.registries).toHaveLength(1);
    expect(lock.registries[0]?.commitOID).toBe("deadbeef123456789012345678901234567890");
  });

  test("git failure during clone → exit 1, no lock written", () => {
    const repo = tmpRepo();
    const { spawn } = fakeGit({ status: 1, stderr: "fatal: repo not found" });
    const code = registryAdd(repo, "https://github.com/x/skills.git", "broken", "v1.0", {
      spawnSync: spawn,
      yes: true,
    });
    expect(code).toBe(1);
    const lock = parseRegistryLock(repo);
    expect(lock.registries).toHaveLength(0);
  });

  test("rev-parse HEAD returns non-hex → exit 1, no lock written", () => {
    const repo = tmpRepo();
    const { spawn } = fakeGit({ stdout: "not-a-hex-string\n" });
    const code = registryAdd(repo, "https://github.com/x/skills.git", "bad-oid", "v1.0", {
      spawnSync: spawn,
      yes: true,
    });
    expect(code).toBe(1);
    const lock = parseRegistryLock(repo);
    expect(lock.registries).toHaveLength(0);
  });

  test("rev-parse HEAD returns empty → exit 1, no lock written", () => {
    const repo = tmpRepo();
    const { spawn } = fakeGit({ stdout: "\n" });
    const code = registryAdd(repo, "https://github.com/x/skills.git", "empty-oid", "v1.0", {
      spawnSync: spawn,
      yes: true,
    });
    expect(code).toBe(1);
    const lock = parseRegistryLock(repo);
    expect(lock.registries).toHaveLength(0);
  });
});

describe("registryList", () => {
  test("no registries → dim message", () => {
    const repo = tmpRepo();
    const code = registryList(repo);
    expect(code).toBe(0);
  });

  test("lists entries from lock file", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [
        { name: "r1", url: "https://x.com/r1.git", ref: "v1", commitOID: "aaaabbbbcccc" },
      ],
    });
    const code = registryList(repo);
    expect(code).toBe(0);
  });
});

describe("registryUpdate", () => {
  test("dry-run: prints planned ops, no git calls", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [{ name: "r1", url: "https://x.com/r1.git", ref: "v1", commitOID: "old" }],
    });
    const { calls, spawn } = fakeGit();
    const code = registryUpdate(repo, undefined, { spawnSync: spawn });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("unknown id → error", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [{ name: "r1", url: "https://x.com/r1.git", ref: "v1", commitOID: "old" }],
    });
    const { spawn } = fakeGit();
    const code = registryUpdate(repo, "r2", { spawnSync: spawn, yes: true });
    expect(code).toBe(1);
  });

  test("updates all registries with --yes", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [
        { name: "r1", url: "https://x.com/r1.git", ref: "v1", commitOID: "old1" },
        { name: "r2", url: "https://x.com/r2.git", ref: "v2", commitOID: "old2" },
      ],
    });
    let callCount = 0;
    const spawn = (_cmd: string, _args: readonly string[], _opts: unknown) => {
      callCount++;
      const oid = "a".repeat(39) + callCount.toString(16);
      return { status: 0, stdout: `${oid}\n`, stderr: "" };
    };
    const code = registryUpdate(repo, undefined, { spawnSync: spawn, yes: true });
    expect(code).toBe(0);
    const lock = parseRegistryLock(repo);
    expect(lock.registries).toHaveLength(2);
    expect(lock.registries[0]?.commitOID).not.toBe("old1");
    expect(lock.registries[1]?.commitOID).not.toBe("old2");
  });

  test("updates single registry by id", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [
        { name: "r1", url: "https://x.com/r1.git", ref: "v1", commitOID: "old1" },
        { name: "r2", url: "https://x.com/r2.git", ref: "v2", commitOID: "old2" },
      ],
    });
    const { calls, spawn } = fakeGit({ stdout: `${"a".repeat(40)}\n` });
    const code = registryUpdate(repo, "r1", { spawnSync: spawn, yes: true });
    expect(code).toBe(0);
    const lock = parseRegistryLock(repo);
    expect(lock.registries[0]?.commitOID).toBe("a".repeat(40));
    expect(lock.registries[1]?.commitOID).toBe("old2");
  });

  test("failed registry preserves prior lock entry, others proceed", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [
        { name: "good", url: "https://x.com/good.git", ref: "v1", commitOID: "good-old" },
        { name: "bad", url: "https://x.com/bad.git", ref: "v2", commitOID: "bad-old" },
      ],
    });
    let callIdx = 0;
    const spawn = (_cmd: string, args: readonly string[], _opts: unknown) => {
      callIdx++;
      if (args.some((a) => a.includes("bad"))) {
        return { status: 1, stdout: "", stderr: "fatal: bad repo" };
      }
      const oid = "a".repeat(39) + callIdx.toString(16);
      return { status: 0, stdout: `${oid}\n`, stderr: "" };
    };
    const code = registryUpdate(repo, undefined, { spawnSync: spawn, yes: true });
    expect(code).toBe(1);
    const lock = parseRegistryLock(repo);
    // good registry updated, bad preserved
    expect(lock.registries[0]?.commitOID).not.toBe("good-old");
    expect(lock.registries[1]?.commitOID).toBe("bad-old");
  });

  test("no targets when id matches nothing → error", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [{ name: "r1", url: "https://x.com/r1.git", ref: "v1", commitOID: "old" }],
    });
    const { spawn } = fakeGit({ stdout: `${"a".repeat(40)}\n` });
    const code = registryUpdate(repo, "nonexistent", { spawnSync: spawn, yes: true });
    expect(code).toBe(1);
  });

  test("empty registry list → dim message", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, { schemaVersion: 1, registries: [] });
    const { spawn } = fakeGit();
    const code = registryUpdate(repo, undefined, { spawnSync: spawn, yes: true });
    expect(code).toBe(0);
  });

  test("update rev-parse HEAD returns non-hex → preserves prior entry", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [{ name: "r1", url: "https://x.com/r1.git", ref: "v1", commitOID: "prior-oid" }],
    });
    let callCount = 0;
    const spawn = (_cmd: string, args: readonly string[], _opts: unknown) => {
      callCount++;
      if (args.includes("clone") || args.includes("fetch") || args.includes("checkout")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "not-hex\n", stderr: "" };
    };
    const code = registryUpdate(repo, "r1", { spawnSync: spawn, yes: true });
    expect(code).toBe(1);
    const lock = parseRegistryLock(repo);
    expect(lock.registries).toHaveLength(1);
    expect(lock.registries[0]?.commitOID).toBe("prior-oid");
  });

  test("update rev-parse HEAD returns empty → preserves prior entry", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [{ name: "r1", url: "https://x.com/r1.git", ref: "v1", commitOID: "prior-oid" }],
    });
    let callCount = 0;
    const spawn = (_cmd: string, args: readonly string[], _opts: unknown) => {
      callCount++;
      if (args.includes("clone") || args.includes("fetch") || args.includes("checkout")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "\n", stderr: "" };
    };
    const code = registryUpdate(repo, "r1", { spawnSync: spawn, yes: true });
    expect(code).toBe(1);
    const lock = parseRegistryLock(repo);
    expect(lock.registries).toHaveLength(1);
    expect(lock.registries[0]?.commitOID).toBe("prior-oid");
  });
});

describe("registryUpdate planFetch path (cacheDir exists)", () => {
  test("update with pre-existing cache dir uses planFetch ops", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    const url = "https://github.com/x/skills.git";
    const ref = "v1";
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [{ name: "r1", url, ref, commitOID: "old" }],
    });
    // Pre-create cache dir to trigger planFetch branch
    const { registryCacheDir: rcd } = require("../src/skills/registry-channel.js");
    const cacheDir = rcd(url);
    mkdirSync(cacheDir, { recursive: true });

    const { calls, spawn } = fakeGit({ stdout: `${"a".repeat(40)}\n` });
    const code = registryUpdate(repo, "r1", { spawnSync: spawn, yes: true });
    expect(code).toBe(0);
    // git -C <cacheDir> fetch origin  (not "clone")
    const fetchCall = calls.find((c) => c.args.includes("fetch"));
    expect(fetchCall).toBeDefined();
    const cloneCall = calls.find((c) => c.args.includes("clone"));
    expect(cloneCall).toBeUndefined();
  });
});

describe("handleRegistrySubcommand coverage", () => {
  test("add with all required args calls registryAdd", () => {
    const repo = tmpRepo();
    const { spawn } = fakeGit();
    const code = handleRegistrySubcommand(repo, [
      "add",
      "https://x.com/s.git",
      "--name",
      "x",
      "--ref",
      "v1",
    ]);
    expect(code).toBe(0);
  });

  test("add missing url/name/ref returns 2", () => {
    const repo = tmpRepo();
    expect(handleRegistrySubcommand(repo, ["add", "--name", "x", "--ref", "v1"])).toBe(2);
    expect(handleRegistrySubcommand(repo, ["add", "https://x.com/s.git", "--name", "x"])).toBe(2);
    expect(handleRegistrySubcommand(repo, ["add", "https://x.com/s.git", "--ref", "v1"])).toBe(2);
  });

  test("list with no extra args returns 0", () => {
    const repo = tmpRepo();
    const code = handleRegistrySubcommand(repo, ["list"]);
    expect(code).toBe(0);
  });

  test("update through handleRegistrySubcommand calls registryUpdate", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [{ name: "r1", url: "https://x.com/r1.git", ref: "v1", commitOID: "old" }],
    });
    const code = handleRegistrySubcommand(repo, ["update"]);
    expect(code).toBe(0);
  });

  test("unknown subcommand returns 2", () => {
    const repo = tmpRepo();
    const code = handleRegistrySubcommand(repo, ["unknown-cmd"]);
    expect(code).toBe(2);
  });

  test("add with --name= and --ref= syntax", () => {
    const repo = tmpRepo();
    const code = handleRegistrySubcommand(repo, [
      "add",
      "https://x.com/s.git",
      "--name=my-reg",
      "--ref=v2.0",
    ]);
    expect(code).toBe(0);
  });

  test("add with --yes produces dry-run first (0) then git fails on real run (1)", () => {
    const repo = tmpRepo();
    const code = handleRegistrySubcommand(repo, [
      "add",
      "https://x.com/s.git",
      "--name",
      "x",
      "--ref",
      "v1",
      "--yes",
    ]);
    // Real git fails in tmpdir so returns 1
    expect(code).toBe(1);
  });

  test("update with id passes id to registryUpdate", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [{ name: "r1", url: "https://x.com/r1.git", ref: "v1", commitOID: "old" }],
    });
    const code = handleRegistrySubcommand(repo, ["update", "r1"]);
    // dry-run returns 0
    expect(code).toBe(0);
  });

  test("update with --yes passes flag (git fails in test env so exit 1)", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [{ name: "r1", url: "https://x.com/r1.git", ref: "v1", commitOID: "old" }],
    });
    // Real git clone will fail in temp dir → exit 1. The --yes flag is parsed and
    // forwarded to registryUpdate; the git failure confirms we left dry-run mode.
    const code = handleRegistrySubcommand(repo, ["update", "--yes"]);
    expect(code).toBe(1);
  });
});

describe("handleRegistrySubcommand error validation (#649)", () => {
  test("unknown flag in 'add' → exit 2", () => {
    const code = handleRegistrySubcommand(tmpRepo(), [
      "add",
      "https://x.com/s.git",
      "--name",
      "x",
      "--ref",
      "v1",
      "--foo",
    ]);
    expect(code).toBe(2);
  });

  test("duplicate positional URL in 'add' → exit 2", () => {
    const code = handleRegistrySubcommand(tmpRepo(), [
      "add",
      "https://x.com/a.git",
      "https://x.com/b.git",
      "--name",
      "x",
      "--ref",
      "v1",
    ]);
    expect(code).toBe(2);
  });

  test("args to 'list' → exit 2", () => {
    const code = handleRegistrySubcommand(tmpRepo(), ["list", "extra"]);
    expect(code).toBe(2);
  });
});
