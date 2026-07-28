import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InstalledSkill,
  type MarketplaceSkill,
  type RegistryEntry,
  type RegistryLock,
  type SpawnFn,
  handleRegistrySubcommand,
  parseMarketplace,
  parseRegistryLock,
  registryAdd,
  registryCacheDir,
  registryInstall,
  registryList,
  registryLockPath,
  registryUpdate,
  skillBundleHash,
  writeRegistryLock,
} from "../src/commands/_shared.js";

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
    // clone + fetch, then resolve FETCH_HEAD and detached-checkout exact OID.
    expect(calls).toHaveLength(4);
    expect(calls[0]?.args[0]).toBe("clone");
    expect(calls[2]?.args).toContain("FETCH_HEAD");
    expect(calls[3]?.args).toEqual([
      "-C",
      registryCacheDir("https://github.com/x/skills.git"),
      "checkout",
      "--detach",
      "deadbeef123456789012345678901234567890",
    ]);
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

describe("parseMarketplace", () => {
  function withMarketplace(data: string): string {
    const d = mkdtempSync(join(tmpdir(), "vf-mp-"));
    dirs.push(d);
    writeFileSync(join(d, "marketplace.json"), data);
    return d;
  }

  test("valid marketplace → parsed skills", () => {
    const dir = withMarketplace(
      JSON.stringify({
        schemaVersion: 1,
        skills: [
          { name: "alpha", version: "1.0.0", status: "verified" },
          { name: "beta", version: "2.0.0", status: "verified", path: "skills/beta" },
        ],
      }),
    );
    const { skills, errors } = parseMarketplace(dir);
    expect(errors).toEqual([]);
    expect(skills).toHaveLength(2);
    expect(skills[0]?.name).toBe("alpha");
    expect(skills[0]?.version).toBe("1.0.0");
    expect(skills[1]?.path).toBe("skills/beta");
  });

  test("missing file → errors", () => {
    const d = mkdtempSync(join(tmpdir(), "vf-mp-nope-"));
    dirs.push(d);
    const { skills, errors } = parseMarketplace(d);
    expect(skills).toEqual([]);
    expect(errors).toContain("marketplace.json not found");
  });

  test("malformed JSON → errors", () => {
    const dir = withMarketplace("not-json");
    const { skills, errors } = parseMarketplace(dir);
    expect(skills).toEqual([]);
    expect(errors).toContain("marketplace.json malformed JSON");
  });

  test("wrong schemaVersion → errors", () => {
    const dir = withMarketplace(JSON.stringify({ schemaVersion: 2, skills: [] }));
    const { skills, errors } = parseMarketplace(dir);
    expect(skills).toEqual([]);
    expect(errors[0]).toContain("unsupported schemaVersion");
  });

  test("missing skills array → errors", () => {
    const dir = withMarketplace(JSON.stringify({ schemaVersion: 1 }));
    const { skills, errors } = parseMarketplace(dir);
    expect(skills).toEqual([]);
    expect(errors[0]).toContain("missing skills array");
  });

  test("skips malformed entries", () => {
    const dir = withMarketplace(
      JSON.stringify({
        schemaVersion: 1,
        skills: [
          { name: "good", version: "1.0", status: "verified" },
          { name: "", version: "1.0", status: "verified" },
          { version: "1.0", status: "verified" },
          { name: "no-version", status: "verified" },
          { name: "no-status", version: "1.0" },
        ],
      }),
    );
    const { skills, errors } = parseMarketplace(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("good");
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  test("rejects a primitive marketplace entry", () => {
    const dir = withMarketplace(JSON.stringify({ schemaVersion: 1, skills: ["bad"] }));
    expect(parseMarketplace(dir).errors).toContain("marketplace.json: invalid skill entry");
  });
});

describe("registryInstall", () => {
  function setup(
    opts: {
      marketplace?: string;
      lockRegistries?: RegistryEntry[];
      skillName?: string;
      skillBody?: string;
      fmName?: string;
      fmVersion?: string;
    } = {},
  ): {
    repo: string;
    registryId: string;
    skillName: string;
    catalogHome: string;
  } {
    const repo = tmpRepo();
    const registryId = "test-reg";
    const skillName = opts.skillName ?? "my-skill";
    const fmName = opts.fmName ?? "my-skill";
    const fmVersion = opts.fmVersion ?? "1.0.0";
    const mpSkills =
      opts.marketplace ??
      JSON.stringify({
        schemaVersion: 1,
        skills: [{ name: skillName, version: "1.0.0", status: "verified" }],
      });
    const body = opts.skillBody ?? "Enough body content to pass validation threshold.\n".repeat(5);

    // Build registry in lock
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    const url = "https://github.com/x/test-skills.git";
    const entry: RegistryEntry = opts.lockRegistries?.[0] ?? {
      name: registryId,
      url,
      ref: "v1",
      commitOID: "a".repeat(40),
    };
    writeRegistryLock(repo, { schemaVersion: 1, registries: [entry] });

    const catalogHome = mkdtempSync(join(tmpdir(), "vf-install-cat-"));
    dirs.push(catalogHome);

    // Build cache dir with marketplace
    const cacheDir = registryCacheDir(url, { homedir: () => catalogHome });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "marketplace.json"), mpSkills);

    // Build skill dir in cache
    const subPath = `skills/${skillName}`;
    mkdirSync(join(cacheDir, subPath), { recursive: true });
    const skillMd = [
      "---",
      `name: ${fmName}`,
      `version: ${fmVersion}`,
      "description: Test skill for registry install.",
      "---",
      "",
      `# ${fmName}`,
      "",
      body,
    ].join("\n");
    writeFileSync(join(cacheDir, subPath, "SKILL.md"), skillMd);

    return { repo, registryId, skillName, catalogHome };
  }

  function catDir(home: string): string {
    return join(home, ".vibeflow", "skills");
  }

  test("dry-run: prints planned actions, no writes", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      onCollision: "replace",
      homedir: () => catalogHome,
    });
    expect(code).toBe(0);
    expect(existsSync(join(catDir(catalogHome), "my-skill"))).toBe(false);
  });

  test("registry not in lock → error", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(repo, { schemaVersion: 1, registries: [] });
    const code = registryInstall(repo, "missing-reg", "any-skill");
    expect(code).toBe(1);
  });

  test("cache dir missing → error", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    const url = "https://github.com/x/test.git";
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [{ name: "reg", url, ref: "v1", commitOID: "a".repeat(40) }],
    });
    // No cache dir created
    const code = registryInstall(repo, "reg", "any");
    expect(code).toBe(1);
  });

  test("marketplace parse errors → error", () => {
    const { repo, registryId, skillName, catalogHome } = setup({
      marketplace: JSON.stringify({ schemaVersion: 1, skills: ["bad"] }),
    });
    expect(registryInstall(repo, registryId, skillName, { homedir: () => catalogHome })).toBe(1);
  });

  test("marketplace path with no SKILL.md → error", () => {
    const { repo, registryId, skillName, catalogHome } = setup({
      marketplace: JSON.stringify({
        schemaVersion: 1,
        skills: [
          { name: "my-skill", version: "1.0.0", status: "verified", path: "skills/missing" },
        ],
      }),
    });
    expect(registryInstall(repo, registryId, skillName, { homedir: () => catalogHome })).toBe(1);
  });

  test("source skill validation errors → error", () => {
    const { repo, registryId, skillName, catalogHome } = setup({ skillBody: "short" });
    expect(registryInstall(repo, registryId, skillName, { homedir: () => catalogHome })).toBe(1);
  });

  test("skill not in marketplace → error", () => {
    const { repo, registryId, catalogHome } = setup();
    const code = registryInstall(repo, registryId, "nonexistent-skill", {
      homedir: () => catalogHome,
    });
    expect(code).toBe(1);
  });

  test("skill not verified in marketplace → error", () => {
    const { repo, registryId, skillName, catalogHome } = setup({
      marketplace: JSON.stringify({
        schemaVersion: 1,
        skills: [{ name: "my-skill", version: "1.0.0", status: "experimental" }],
      }),
    });
    const code = registryInstall(repo, registryId, skillName, {
      homedir: () => catalogHome,
    });
    expect(code).toBe(1);
  });

  test("version mismatch → error", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      version: "2.0.0",
      homedir: () => catalogHome,
    });
    expect(code).toBe(1);
  });

  test("frontmatter name mismatch marketplace → error", () => {
    const { repo, registryId, skillName, catalogHome } = setup({ fmName: "wrong-name" });
    const code = registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
    });
    expect(code).toBe(1);
  });

  test("frontmatter version mismatch marketplace → error", () => {
    const { repo, registryId, skillName, catalogHome } = setup({ fmVersion: "9.9.9" });
    const code = registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
    });
    expect(code).toBe(1);
  });

  test("marketplace path traversal → rejects before copying", () => {
    const { repo, registryId, skillName, catalogHome } = setup({
      marketplace: JSON.stringify({
        schemaVersion: 1,
        skills: [{ name: "my-skill", version: "1.0.0", status: "verified", path: "../escape" }],
      }),
    });
    expect(
      registryInstall(repo, registryId, skillName, { yes: true, homedir: () => catalogHome }),
    ).toBe(1);
    expect(existsSync(join(catDir(catalogHome), "my-skill"))).toBe(false);
  });

  test("successful install with --yes → copies skill, writes lock", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
    });
    expect(code).toBe(0);
    expect(existsSync(join(catDir(catalogHome), "my-skill", "SKILL.md"))).toBe(true);
    const lock = parseRegistryLock(repo);
    const reg = lock.registries.find((r) => r.name === registryId);
    expect(reg?.installed).toBeDefined();
    expect(reg?.installed?.some((s: InstalledSkill) => s.name === "my-skill")).toBe(true);
  });

  test("skip collision: existing skill left untouched", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const d = join(catDir(catalogHome), "my-skill");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "EXISTING.txt"), "I was here first");

    const code = registryInstall(repo, registryId, skillName, {
      onCollision: "skip",
      yes: true,
      homedir: () => catalogHome,
    });
    expect(code).toBe(0);
    expect(readFileSync(join(d, "EXISTING.txt"), "utf8")).toBe("I was here first");
  });

  test("replace collision: backs up existing then overwrites", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const d = join(catDir(catalogHome), "my-skill");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "ORIGINAL.txt"), "original");

    const code = registryInstall(repo, registryId, skillName, {
      onCollision: "replace",
      yes: true,
      homedir: () => catalogHome,
    });
    expect(code).toBe(0);
    expect(existsSync(join(d, "SKILL.md"))).toBe(true);
    expect(existsSync(join(d, "ORIGINAL.txt"))).toBe(false);
    expect(existsSync(join(catDir(catalogHome), ".backup"))).toBe(true);
  });

  test("rename collision: copies to new slug, rewrites frontmatter name", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const d = join(catDir(catalogHome), "my-skill");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "ORIGINAL.txt"), "original");

    const code = registryInstall(repo, registryId, skillName, {
      onCollision: "rename",
      yes: true,
      homedir: () => catalogHome,
    });
    expect(code).toBe(0);
    expect(existsSync(join(d, "ORIGINAL.txt"))).toBe(true);
    expect(existsSync(join(catDir(catalogHome), "my-skill-1", "SKILL.md"))).toBe(true);
    const renamedFm = readFileSync(join(catDir(catalogHome), "my-skill-1", "SKILL.md"), "utf8");
    expect(renamedFm).toContain("name: my-skill-1");
    const lock = parseRegistryLock(repo);
    const reg = lock.registries.find((r) => r.name === registryId);
    expect(reg?.installed?.some((s: InstalledSkill) => s.name === "my-skill-1")).toBe(true);
  });

  test("rename collision: re-validates and rolls back on failure", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const d = join(catDir(catalogHome), "my-skill");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "KEEP.txt"), "keep");

    const code = registryInstall(repo, registryId, skillName, {
      onCollision: "rename",
      yes: true,
      homedir: () => catalogHome,
      writeFileSync: (path, _content) => writeFileSync(path, "invalid"),
    });
    expect(code).toBe(1);
    expect(existsSync(join(catDir(catalogHome), "my-skill-1"))).toBe(false);
    expect(existsSync(join(d, "KEEP.txt"))).toBe(true);
  });

  test("installed skill recorded in lock only after successful copy", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
    });
    expect(code).toBe(0);
    const lock = parseRegistryLock(repo);
    const reg = lock.registries.find((r) => r.name === registryId);
    expect(reg?.installed).toHaveLength(1);
    expect(reg?.installed?.[0]?.name).toBe("my-skill");
    expect(reg?.installed?.[0]?.version).toBe("1.0.0");
    expect(reg?.installed?.[0]?.commitOID).toBe("a".repeat(40));
  });

  test("installed skill includes bundleHash in lock entry", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
    });
    expect(code).toBe(0);
    const lock = parseRegistryLock(repo);
    const sk = lock.registries.find((r) => r.name === registryId)?.installed?.[0];
    expect(sk?.bundleHash).toBeDefined();
    expect(sk?.bundleHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("skillBundleHash", () => {
  test("deterministic SHA-256 over sorted files — same dir gives same hash", () => {
    const d = mkdtempSync(join(tmpdir(), "vf-bhash-"));
    dirs.push(d);
    writeFileSync(join(d, "a.txt"), "hello");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "b.txt"), "world");
    const h1 = skillBundleHash(d);
    const h2 = skillBundleHash(d);
    expect(h1).toBe(h2);
  });

  test("different content produces different hash", () => {
    const d1 = mkdtempSync(join(tmpdir(), "vf-bh1-"));
    dirs.push(d1);
    writeFileSync(join(d1, "f.txt"), "content-a");
    const d2 = mkdtempSync(join(tmpdir(), "vf-bh2-"));
    dirs.push(d2);
    writeFileSync(join(d2, "f.txt"), "content-b");
    expect(skillBundleHash(d1)).not.toBe(skillBundleHash(d2));
  });

  test("excludes .git directory", () => {
    const d = mkdtempSync(join(tmpdir(), "vf-bh-git-"));
    dirs.push(d);
    writeFileSync(join(d, "SKILL.md"), "content");
    mkdirSync(join(d, ".git"));
    writeFileSync(join(d, ".git", "HEAD"), "ref: refs/heads/main\n");
    // Hash should only include SKILL.md
    const hash = skillBundleHash(d);
    // Manually compute expected hash
    const expected = createHash("sha256").update("SKILL.md\0").update("content").digest("hex");
    expect(hash).toBe(expected);
  });

  test("sorts files alphabetically for determinism", () => {
    const d = mkdtempSync(join(tmpdir(), "vf-bh-sort-"));
    dirs.push(d);
    writeFileSync(join(d, "z.txt"), "last");
    writeFileSync(join(d, "a.txt"), "first");
    mkdirSync(join(d, "m"));
    writeFileSync(join(d, "m", "b.txt"), "mid");
    const hash = skillBundleHash(d);
    const expected = createHash("sha256")
      .update("a.txt\0")
      .update("first")
      .update("m/b.txt\0")
      .update("mid")
      .update("z.txt\0")
      .update("last")
      .digest("hex");
    expect(hash).toBe(expected);
  });
});

describe("registryAdd OID checkout plan (#694)", () => {
  test("planClone omits checkout/rev-parse steps (delegated to resolveOidAndCheckout)", () => {
    const repo = tmpRepo();
    const { calls, spawn } = fakeGit({ stdout: `${"a".repeat(40)}\n` });
    const code = registryAdd(repo, "https://github.com/x/skills.git", "oid-reg", "v1.0", {
      spawnSync: spawn,
      yes: true,
    });
    expect(code).toBe(0);
    // clone + fetch — no checkout step in plan
    const cloneCall = calls.find((c) => c.args[0] === "clone");
    expect(cloneCall).toBeDefined();
    // After the planned ops, resolveOidAndCheckout runs rev-parse FETCH_HEAD + checkout --detach
    const revParseCall = calls.find((c) => c.args.includes("FETCH_HEAD"));
    expect(revParseCall).toBeDefined();
    const detachCall = calls.find((c) => c.args.includes("--detach"));
    expect(detachCall).toBeDefined();
    // OID used for checkout is full hex, not a ref/tag
    const detachIdx = calls.findIndex((c) => c.args.includes("--detach"));
    if (detachIdx >= 0) {
      const oidArg = calls[detachIdx]?.args.slice(-1)[0];
      expect(oidArg).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  // registryUpdate's cache root is the actual user home (no homedir test seam),
  // so its detached-OID behavior is covered by unit tests for registryAdd above.
});

describe("registryInstall security scan gate (#651)", () => {
  function setup(): {
    repo: string;
    registryId: string;
    skillName: string;
    catalogHome: string;
  } {
    const repo = tmpRepo();
    const registryId = "test-reg";
    const skillName = "safe-skill";
    const fmName = "safe-skill";
    const fmVersion = "1.0.0";
    const body = "Enough body content to pass validation threshold.\n".repeat(5);

    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    const url = "https://github.com/x/scanned.git";
    writeRegistryLock(repo, {
      schemaVersion: 1,
      registries: [{ name: registryId, url, ref: "v1", commitOID: "a".repeat(40) }],
    });

    const catalogHome = mkdtempSync(join(tmpdir(), "vf-scan-651-"));
    dirs.push(catalogHome);

    const cacheDir = registryCacheDir(url, { homedir: () => catalogHome });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "marketplace.json"),
      JSON.stringify({
        schemaVersion: 1,
        skills: [{ name: skillName, version: "1.0.0", status: "verified" }],
      }),
    );
    const subPath = `skills/${skillName}`;
    mkdirSync(join(cacheDir, subPath), { recursive: true });
    writeFileSync(
      join(cacheDir, subPath, "SKILL.md"),
      [
        "---",
        `name: ${fmName}`,
        `version: ${fmVersion}`,
        "description: Test skill for scan gate.",
        "---",
        "",
        `# ${fmName}`,
        "",
        body,
      ].join("\n"),
    );

    return { repo, registryId, skillName, catalogHome };
  }

  function fakeSpawn(result: {
    stdout: string;
    status?: number;
    stderr?: string;
  }): SpawnFn {
    return (() => ({
      status: result.status ?? 0,
      stdout: result.stdout,
      stderr: result.stderr ?? "",
    })) as unknown as SpawnFn;
  }

  test("absent scanner → install succeeds, scan_summary.scanned:false in lock", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
    });
    expect(code).toBe(0);
    const lock = parseRegistryLock(repo);
    const reg = lock.registries.find((r) => r.name === registryId);
    expect(reg?.installed?.[0]?.scan_summary).toEqual({
      scanned: false,
      risk_severity: undefined,
      finding_count: 0,
      reason: "skillspector not installed",
    });
  });

  test("HIGH severity → blocked before catalog copy, lock unchanged", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
      hasCommand: () => true,
      spawnSync: fakeSpawn({
        stdout: JSON.stringify({
          risk_severity: "HIGH",
          filtered_findings: [{ rule_id: "R1", message: "dangerous exec" }],
        }),
        status: 1,
      }),
    });
    expect(code).toBe(1);
    // Catalog must NOT have the skill
    expect(existsSync(join(catalogHome, ".vibeflow", "skills", "safe-skill"))).toBe(false);
    // Lock must NOT have it installed
    const lock = parseRegistryLock(repo);
    const reg = lock.registries.find((r) => r.name === registryId);
    expect(reg?.installed).toBeUndefined();
  });

  test("CRITICAL severity → blocked, no catalog/lock mutation", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
      hasCommand: () => true,
      spawnSync: fakeSpawn({
        stdout: JSON.stringify({
          risk_severity: "CRITICAL",
          filtered_findings: [{ rule_id: "EXFIL", message: "sends env" }],
        }),
        status: 1,
      }),
    });
    expect(code).toBe(1);
    expect(existsSync(join(catalogHome, ".vibeflow", "skills", "safe-skill"))).toBe(false);
  });

  test("MEDIUM severity → warns but install proceeds, scan_summary in lock", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
      hasCommand: () => true,
      spawnSync: fakeSpawn({
        stdout: JSON.stringify({
          risk_severity: "MEDIUM",
          filtered_findings: [{ rule_id: "M1", message: "suspicious pattern" }],
        }),
        status: 1,
      }),
    });
    expect(code).toBe(0);
    // Catalog must have the skill
    expect(existsSync(join(catalogHome, ".vibeflow", "skills", "safe-skill", "SKILL.md"))).toBe(
      true,
    );
    const lock = parseRegistryLock(repo);
    const reg = lock.registries.find((r) => r.name === registryId);
    expect(reg?.installed?.[0]?.scan_summary).toEqual({
      scanned: true,
      risk_severity: "MEDIUM",
      finding_count: 1,
    });
  });

  test("LOW severity → passes, scan_summary in lock", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
      hasCommand: () => true,
      spawnSync: fakeSpawn({
        stdout: JSON.stringify({ risk_severity: "LOW", filtered_findings: [] }),
      }),
    });
    expect(code).toBe(0);
    const lock = parseRegistryLock(repo);
    const reg = lock.registries.find((r) => r.name === registryId);
    expect(reg?.installed?.[0]?.scan_summary).toEqual({
      scanned: true,
      risk_severity: "LOW",
      finding_count: 0,
    });
  });

  test("scan failure (empty stdout) → treated as not-scanned, install proceeds", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
      hasCommand: () => true,
      spawnSync: fakeSpawn({ stdout: "", status: 2, stderr: "skillspector crashed" }),
    });
    expect(code).toBe(0);
    const lock = parseRegistryLock(repo);
    const reg = lock.registries.find((r) => r.name === registryId);
    expect(reg?.installed?.[0]?.scan_summary?.scanned).toBe(false);
  });

  test("scan spawn throws → treated as not-scanned, install proceeds", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
      spawnSync: (() => {
        throw new Error("ENOMEM");
      }) as unknown as SpawnFn,
    });
    expect(code).toBe(0);
    const lock = parseRegistryLock(repo);
    const reg = lock.registries.find((r) => r.name === registryId);
    expect(reg?.installed?.[0]?.scan_summary?.scanned).toBe(false);
  });

  test("scan_summary is non-secret (includes severity/count, not raw findings)", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    registryInstall(repo, registryId, skillName, {
      yes: true,
      homedir: () => catalogHome,
      hasCommand: () => true,
      spawnSync: fakeSpawn({
        stdout: JSON.stringify({
          risk_severity: "MEDIUM",
          risk_score: 42,
          filtered_findings: [
            { rule_id: "SECRET", message: "api key in body", severity: "MEDIUM" },
          ],
        }),
        status: 1,
      }),
    });
    const lock = parseRegistryLock(repo);
    const summary = lock.registries[0]?.installed?.[0]?.scan_summary;
    // Summary has severity and count, NOT raw rule_id/message
    expect(summary?.risk_severity).toBe("MEDIUM");
    expect(summary?.finding_count).toBe(1);
    expect((summary as unknown as Record<string, unknown>)?.rule_id).toBeUndefined();
    expect((summary as unknown as Record<string, unknown>)?.message).toBeUndefined();
  });

  test("dry-run with --yes omitted prints security scan planned action", () => {
    const { repo, registryId, skillName, catalogHome } = setup();
    const code = registryInstall(repo, registryId, skillName, {
      homedir: () => catalogHome,
    });
    expect(code).toBe(0);
    // No catalog or lock mutation in dry-run
    expect(existsSync(join(catalogHome, ".vibeflow", "skills", "safe-skill"))).toBe(false);
    const lock = parseRegistryLock(repo);
    expect(lock.registries[0]?.installed).toBeUndefined();
  });

  describe("handleRegistrySubcommand install routing", () => {
    test("install with valid args calls registryInstall", () => {
      const repo = tmpRepo();
      mkdirSync(join(repo, ".vibeflow"), { recursive: true });
      writeRegistryLock(repo, {
        schemaVersion: 1,
        registries: [
          { name: "reg", url: "https://x.com/r.git", ref: "v1", commitOID: "a".repeat(40) },
        ],
      });
      const url = "https://x.com/r.git";
      const cacheDir = registryCacheDir(url);
      mkdirSync(join(cacheDir, "skills", "alpha"), { recursive: true });
      writeFileSync(
        join(cacheDir, "marketplace.json"),
        JSON.stringify({
          schemaVersion: 1,
          skills: [{ name: "alpha", version: "1.0", status: "verified" }],
        }),
      );
      writeFileSync(
        join(cacheDir, "skills", "alpha", "SKILL.md"),
        [
          "---",
          "name: alpha",
          "version: 1.0",
          "description: test",
          "---",
          "",
          "# alpha",
          "",
          "Enough body for validation threshold requirement.",
        ].join("\n"),
      );

      const code = handleRegistrySubcommand(repo, ["install", "reg/alpha"]);
      // Dry-run → 0
      expect(code).toBe(0);
    });

    test("install missing registry-id/skill-name → exit 2", () => {
      expect(handleRegistrySubcommand(tmpRepo(), ["install"])).toBe(2);
      expect(handleRegistrySubcommand(tmpRepo(), ["install", "no-slash"])).toBe(2);
      expect(handleRegistrySubcommand(tmpRepo(), ["install", "/only-slash"])).toBe(2);
      expect(handleRegistrySubcommand(tmpRepo(), ["install", "only-slash/"])).toBe(2);
    });

    test("install with --on-collision invalid value → exit 2", () => {
      expect(
        handleRegistrySubcommand(tmpRepo(), ["install", "r/s", "--on-collision", "destroy"]),
      ).toBe(2);
      expect(handleRegistrySubcommand(tmpRepo(), ["install", "r/s", "--on-collision=delete"])).toBe(
        2,
      );
    });

    test("install with --version passes filter", () => {
      const repo = tmpRepo();
      mkdirSync(join(repo, ".vibeflow"), { recursive: true });
      writeRegistryLock(repo, { schemaVersion: 1, registries: [] });
      const code = handleRegistrySubcommand(repo, ["install", "r/s", "--version", "1.0.0"]);
      // Registry not found → exits 1 (not 2) — confirms version was parsed
      expect(code).toBe(1);
    });

    test("install with --yes and --on-collision replace passes flags", () => {
      const repo = tmpRepo();
      mkdirSync(join(repo, ".vibeflow"), { recursive: true });
      writeRegistryLock(repo, { schemaVersion: 1, registries: [] });
      const code = handleRegistrySubcommand(repo, [
        "install",
        "r/s",
        "--on-collision",
        "replace",
        "--yes",
      ]);
      // Registry not found → exits 1 (not 2) — confirms flags parsed
      expect(code).toBe(1);
    });

    test("update rejects duplicate id and unknown flag", () => {
      const repo = tmpRepo();
      expect(handleRegistrySubcommand(repo, ["update", "one", "two"])).toBe(2);
      expect(handleRegistrySubcommand(repo, ["update", "--bogus"])).toBe(2);
    });

    test("install rejects duplicate target and unknown flag", () => {
      const repo = tmpRepo();
      expect(handleRegistrySubcommand(repo, ["install", "r/s", "other"])).toBe(2);
      expect(handleRegistrySubcommand(repo, ["install", "r/s", "--bogus"])).toBe(2);
    });
  });
});
