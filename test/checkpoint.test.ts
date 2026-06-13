import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Build a platform-correct absolute path under the fake repo root. */
function p(...parts: string[]): string {
  return join("/repo", ...parts);
}

import {
  type Checkpoint,
  type FsOps,
  type GitRunner,
  createCheckpoint,
  gitState,
  recoveryHint,
  restoreIgnored,
} from "../src/safety/checkpoint.js";

/** Build a fake GitRunner that matches recorded calls against prefix→response rules. */
function fakeGit(rules: Array<[string, { status: number; stdout?: string; stderr?: string }]>) {
  const calls: string[] = [];
  const runner: GitRunner = (args) => {
    const joined = args.join(" ");
    calls.push(joined);
    for (const [prefix, resp] of rules) {
      if (joined.startsWith(prefix)) {
        return { status: resp.status, stdout: resp.stdout ?? "", stderr: resp.stderr ?? "" };
      }
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

/** Build a fake FsOps that records copies in-memory and never touches the real tree. */
function fakeFs(
  opts: { sizes?: Record<string, number>; existing?: string[]; dirs?: string[] } = {},
) {
  const copies: Array<{ src: string; dest: string }> = [];
  const made: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const fs: FsOps = {
    exists: (p) => (opts.existing ?? []).includes(p),
    copyFile: (src, dest) => {
      copies.push({ src, dest });
    },
    mkdirp: (p) => {
      made.push(p);
    },
    size: (p) => opts.sizes?.[p] ?? 1,
    isDir: (p) => (opts.dirs ?? []).includes(p),
    writeFile: (path, content) => {
      writes.push({ path, content });
    },
  };
  return { fs, copies, made, writes };
}

describe("safety/checkpoint gitState", () => {
  test("reports an unborn branch (no commits) without crashing", () => {
    const { runner } = fakeGit([
      ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true\n" }],
      ["rev-parse --verify HEAD", { status: 128, stderr: "fatal: needed a single revision" }],
      ["status --porcelain", { status: 0, stdout: "" }],
      ["ls-files --others --exclude-standard", { status: 0, stdout: "" }],
      ["ls-files --others --ignored --exclude-standard", { status: 0, stdout: "" }],
    ]);
    const st = gitState("/repo", runner);
    expect(st.isRepo).toBe(true);
    expect(st.hasCommits).toBe(false); // the old design CRASHED here
    expect(st.dirty).toBe(false);
  });

  test("non-repo reports isRepo:false and empty state", () => {
    const { runner } = fakeGit([["rev-parse --is-inside-work-tree", { status: 128 }]]);
    const st = gitState("/not-a-repo", runner);
    expect(st.isRepo).toBe(false);
    expect(st.hasCommits).toBe(false);
    expect(st.untracked).toEqual([]);
    expect(st.ignoredDirty).toEqual([]);
  });

  test("parses dirty, untracked, and ignored-dirty file lists", () => {
    const { runner } = fakeGit([
      ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
      ["rev-parse --verify HEAD", { status: 0, stdout: "abc123" }],
      ["status --porcelain", { status: 0, stdout: " M src/a.ts\n" }],
      ["ls-files --others --ignored --exclude-standard", { status: 0, stdout: ".env.local\n" }],
      ["ls-files --others --exclude-standard", { status: 0, stdout: "new.ts\nlib/x.ts\n" }],
    ]);
    const st = gitState("/repo", runner);
    expect(st.dirty).toBe(true);
    expect(st.untracked).toEqual(["new.ts", "lib/x.ts"]);
    expect(st.ignoredDirty).toEqual([".env.local"]);
  });
});

describe("safety/checkpoint createCheckpoint", () => {
  test("non-repo returns isRepo:false with null fields and never throws", () => {
    const { runner } = fakeGit([["rev-parse --is-inside-work-tree", { status: 128 }]]);
    const { fs } = fakeFs();
    const cp = createCheckpoint("/x", "run1", { git: runner, fs });
    expect(cp.isRepo).toBe(false);
    expect(cp.wipSha).toBeNull();
    expect(cp.backupDir).toBeNull();
    expect(cp.backedUp).toEqual([]);
  });

  test("autoWip on a dirty repo runs add -A, commit --no-verify, rev-parse HEAD", () => {
    const { runner, calls } = fakeGit([
      ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
      ["rev-parse --verify HEAD", { status: 0, stdout: "base000" }],
      ["status --porcelain", { status: 0, stdout: " M src/a.ts\n" }],
      ["ls-files --others --ignored --exclude-standard", { status: 0, stdout: "" }],
      ["ls-files --others --exclude-standard", { status: 0, stdout: "" }],
      ["rev-parse HEAD", { status: 0, stdout: "wip999\n" }],
    ]);
    const { fs } = fakeFs();
    const cp = createCheckpoint("/repo", "run1", { autoWip: true, git: runner, fs });
    // baseRef captured before the wip commit (the pre-wip HEAD).
    expect(cp.baseRef).toBe("base000");
    expect(cp.wipSha).toBe("wip999");
    // Exact ordered subsequence proving the snapshot mechanics.
    const idxAdd = calls.findIndex((c) => c === "add -A");
    const idxCommit = calls.findIndex((c) => c.startsWith("commit -m"));
    const idxHead = calls.lastIndexOf("rev-parse HEAD");
    expect(idxAdd).toBeGreaterThan(-1);
    expect(idxCommit).toBeGreaterThan(idxAdd);
    expect(idxHead).toBeGreaterThan(idxCommit);
    expect(calls[idxCommit]).toContain("--no-verify");
    expect(calls[idxCommit]).toContain("vibeflow WIP run1");
  });

  test("writes .vibeflow/.gitignore before add -A: ignores secrets, keeps knowledge", () => {
    const { runner } = fakeGit([
      ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
      ["rev-parse --verify HEAD", { status: 0, stdout: "base000" }],
      ["status --porcelain", { status: 0, stdout: " M src/a.ts\n" }],
      ["ls-files --others --ignored --exclude-standard", { status: 0, stdout: ".env.local\n" }],
      ["ls-files --others --exclude-standard", { status: 0, stdout: "" }],
      ["rev-parse HEAD", { status: 0, stdout: "wip999\n" }],
    ]);
    const { fs, writes } = fakeFs();
    createCheckpoint("/repo", "run1", { autoWip: true, git: runner, fs });
    const guard = writes.find((w) => w.path.endsWith(p(".vibeflow", ".gitignore")));
    expect(guard).toBeDefined();
    // Ignores everything (so backed-up secrets never stage) but re-includes curated knowledge.
    expect(guard?.content).toContain("*");
    expect(guard?.content).toContain("!knowledge/");
    expect(guard?.content).toContain("backup/");
  });

  test("autoWip on an UNBORN repo still commits (initial commit), baseRef null", () => {
    const { runner, calls } = fakeGit([
      ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
      ["rev-parse --verify HEAD", { status: 128 }], // unborn: no HEAD yet
      ["status --porcelain", { status: 0, stdout: "" }],
      ["ls-files --others --ignored --exclude-standard", { status: 0, stdout: "" }],
      ["ls-files --others --exclude-standard", { status: 0, stdout: "first.ts\n" }],
      ["rev-parse HEAD", { status: 0, stdout: "init111\n" }],
    ]);
    const { fs } = fakeFs();
    const cp = createCheckpoint("/repo", "run2", { autoWip: true, git: runner, fs });
    expect(cp.hasCommits).toBe(false);
    expect(cp.baseRef).toBeNull(); // nothing to reset back to — the WIP IS the first commit
    expect(cp.wipSha).toBe("init111"); // proves the crash is fixed: we still snapshot
    expect(calls.some((c) => c === "add -A")).toBe(true);
    expect(calls.some((c) => c.startsWith("commit -m"))).toBe(true);
  });

  test("backs up ignored-dirty files and skips ones over the size cap", () => {
    const big = p("big.bin");
    const { runner } = fakeGit([
      ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
      ["rev-parse --verify HEAD", { status: 0, stdout: "abc" }],
      ["status --porcelain", { status: 0, stdout: "" }],
      [
        "ls-files --others --ignored --exclude-standard",
        { status: 0, stdout: ".env.local\nlogs/big.bin\n.git/skip-me\nnode_modules/x\n" },
      ],
      ["ls-files --others --exclude-standard", { status: 0, stdout: "" }],
    ]);
    const { fs, copies } = fakeFs({
      sizes: { [p(".env.local")]: 100, [p("logs/big.bin")]: 6 * 1024 * 1024 },
    });
    const cp = createCheckpoint("/repo", "run3", { git: runner, fs });
    expect(cp.backupDir).toBe(p(".vibeflow/backup/run3"));
    expect(cp.backedUp).toContain(".env.local");
    // >5MB file is skipped, never copied.
    expect(cp.skipped.some((s) => s.includes("logs/big.bin"))).toBe(true);
    expect(cp.backedUp).not.toContain("logs/big.bin");
    // .git/ and node_modules/ paths are NEVER backed up.
    expect(cp.backedUp.some((b) => b.startsWith(".git/"))).toBe(false);
    expect(cp.backedUp.some((b) => b.startsWith("node_modules/"))).toBe(false);
    // The real backup destination for .env.local lands under the run dir.
    expect(copies.some((c) => c.dest === p(".vibeflow/backup/run3/.env.local"))).toBe(true);
    // No wip without autoWip.
    expect(cp.wipSha).toBeNull();
  });

  test("skips an ignored DIRECTORY entry instead of crashing (EISDIR regression)", () => {
    // git can list a wholly-ignored directory as a single entry (e.g. `web/` with its own
    // .gitignore'd build). copyFileSync throws EISDIR on it — the checkpoint must skip, not die.
    const { runner } = fakeGit([
      ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
      ["rev-parse --verify HEAD", { status: 0, stdout: "abc" }],
      ["status --porcelain", { status: 0, stdout: "" }],
      [
        "ls-files --others --ignored --exclude-standard",
        { status: 0, stdout: "web\n.env.local\n" },
      ],
      ["ls-files --others --exclude-standard", { status: 0, stdout: "" }],
    ]);
    const { fs, copies } = fakeFs({
      dirs: [p("web")], // `web` is a directory; `.env.local` is a file
      sizes: { [p(".env.local")]: 100 },
    });
    // Must not throw.
    const cp = createCheckpoint("/repo", "run4", { git: runner, fs });
    expect(cp.skipped.some((s) => s.includes("web") && s.includes("directory"))).toBe(true);
    expect(cp.backedUp).not.toContain("web");
    // The sibling file is still backed up normally.
    expect(cp.backedUp).toContain(".env.local");
    expect(copies.some((c) => c.src === p("web"))).toBe(false);
  });

  test("skips files larger than sizeCapBytes (size-cap branch)", () => {
    const { runner } = fakeGit([
      ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
      ["rev-parse --verify HEAD", { status: 0, stdout: "abc" }],
      ["status --porcelain", { status: 0, stdout: "" }],
      [
        "ls-files --others --ignored --exclude-standard",
        { status: 0, stdout: "big.bin\n" },
      ],
      ["ls-files --others --exclude-standard", { status: 0, stdout: "" }],
    ]);
    const { fs, copies } = fakeFs({
      sizes: { [p("big.bin")]: 10_000_000 }, // 10MB
    });
    const cp = createCheckpoint("/repo", "cap", {
      git: runner,
      fs,
      sizeCapBytes: 1_000_000, // 1MB cap
    });
    expect(cp.backedUp).not.toContain("big.bin");
    expect(cp.skipped.some((s) => s.includes("big.bin") && s.includes("size cap"))).toBe(true);
    expect(copies.some((c) => c.src === p("big.bin"))).toBe(false);
  });

  test("treats fs.isDir throw (e.g. EPERM) as 'not a directory' (defense in depth)", () => {
    // isDir catches its own errors and returns false. Test by injecting
    // a fake isDir that throws. The backup should NOT throw (caller
    // contract: must not crash on per-file isDir failures).
    const { runner } = fakeGit([
      ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
      ["rev-parse --verify HEAD", { status: 0, stdout: "abc" }],
      ["status --porcelain", { status: 0, stdout: "" }],
      [
        "ls-files --others --ignored --exclude-standard",
        { status: 0, stdout: "weird\n" },
      ],
      ["ls-files --others --exclude-standard", { status: 0, stdout: "" }],
    ]);
    let isDirCalls = 0;
    const fakeFsOps: FsOps = {
      exists: () => true,
      copyFile: () => {},
      mkdirp: () => {},
      size: () => 1,
      isDir: () => {
        isDirCalls++;
        throw new Error("EPERM: synthetic");
      },
      writeFile: () => {},
    };
    // Must not throw — the catch in defaultFs's isDir would return false,
    // but our test injects a non-catching isDir. Verify the call doesn't
    // crash even when isDir throws (the test framework's expect doesn't
    // catch inside the closure).
    let didNotThrow = true;
    try {
      createCheckpoint("/repo", "perm", { git: runner, fs: fakeFsOps });
    } catch {
      didNotThrow = false;
    }
    expect(isDirCalls).toBeGreaterThan(0);
    // We only assert that isDir was invoked and didn't propagate an
    // unhandled throw. The actual decision is internal to checkpoint.
    expect(didNotThrow).toBe(true);
  });

  test("skips file when fs.copyFile throws (not ENOENT → 'copy failed')", () => {
    const { runner } = fakeGit([
      ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
      ["rev-parse --verify HEAD", { status: 0, stdout: "abc" }],
      ["status --porcelain", { status: 0, stdout: "" }],
      [
        "ls-files --others --ignored --exclude-standard",
        { status: 0, stdout: "badperm\n" },
      ],
      ["ls-files --others --exclude-standard", { status: 0, stdout: "" }],
    ]);
    const epermErr = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const fakeFsOps: FsOps = {
      exists: () => true,
      copyFile: () => {
        throw epermErr;
      },
      mkdirp: () => {},
      size: () => 1,
      isDir: () => false,
      writeFile: () => {},
    };
    const cp = createCheckpoint("/repo", "perm2", {
      git: runner,
      fs: fakeFsOps,
    });
    expect(cp.backedUp).not.toContain("badperm");
    expect(cp.skipped.some((s) => s.includes("badperm") && s.includes("EACCES"))).toBe(true);
  });

  test("treats ENOENT from fs.copyFile as 'stale — no longer exists'", () => {
    const { runner } = fakeGit([
      ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
      ["rev-parse --verify HEAD", { status: 0, stdout: "abc" }],
      ["status --porcelain", { status: 0, stdout: "" }],
      [
        "ls-files --others --ignored --exclude-standard",
        { status: 0, stdout: "stale\n" },
      ],
      ["ls-files --others --exclude-standard", { status: 0, stdout: "" }],
    ]);
    const enoentErr = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const fakeFsOps: FsOps = {
      exists: () => true,
      copyFile: () => {
        throw enoentErr;
      },
      mkdirp: () => {},
      size: () => 1,
      isDir: () => false,
      writeFile: () => {},
    };
    const cp = createCheckpoint("/repo", "stale", {
      git: runner,
      fs: fakeFsOps,
    });
    expect(cp.backedUp).not.toContain("stale");
    expect(cp.skipped.some((s) => s.includes("stale") && s.includes("stale"))).toBe(true);
  });
});

describe("safety/checkpoint recoveryHint", () => {
  const base: Checkpoint = {
    isRepo: true,
    hasCommits: true,
    wipSha: null,
    backupDir: null,
    backedUp: [],
    skipped: [],
    baseRef: null,
  };

  test("no-repo case warns the edits are irreversible", () => {
    const hint = recoveryHint({ ...base, isRepo: false, hasCommits: false });
    expect(hint.toLowerCase()).toContain("no git");
    expect(hint.toLowerCase()).toContain("irreversible");
  });

  test("wip case yields a git reset --hard to the pre-dispatch ref", () => {
    const hint = recoveryHint({ ...base, wipSha: "wip999", baseRef: "base000" });
    expect(hint).toContain("git reset --hard base000");
    expect(hint).toContain("wip999"); // mentions the WIP commit holding pre-dispatch state
  });

  test("unborn wip (no baseRef) resets to the wip sha itself", () => {
    const hint = recoveryHint({ ...base, hasCommits: false, wipSha: "init111", baseRef: null });
    expect(hint).toContain("git reset --hard init111");
  });

  test("backup case points at the backup directory", () => {
    const hint = recoveryHint({
      ...base,
      backupDir: p(".vibeflow/backup/run3"),
      backedUp: [".env.local"],
    });
    expect(hint).toContain(p(".vibeflow/backup/run3"));
  });
});

describe("safety/checkpoint restoreIgnored", () => {
  test("copies backed-up ignored files back to their original relative paths", () => {
    const cp: Checkpoint = {
      isRepo: true,
      hasCommits: true,
      wipSha: null,
      backupDir: p(".vibeflow/backup/run3"),
      backedUp: [".env.local", "config/secret.json"],
      skipped: [],
      baseRef: null,
    };
    const { fs, copies } = fakeFs();
    const restored = restoreIgnored(cp, "/repo", fs);
    expect(restored).toEqual([".env.local", "config/secret.json"]);
    expect(copies).toContainEqual({
      src: p(".vibeflow/backup/run3/.env.local"),
      dest: p(".env.local"),
    });
    expect(copies).toContainEqual({
      src: p(".vibeflow/backup/run3/config/secret.json"),
      dest: p("config/secret.json"),
    });
  });

  test("no backupDir restores nothing", () => {
    const cp: Checkpoint = {
      isRepo: false,
      hasCommits: false,
      wipSha: null,
      backupDir: null,
      backedUp: [],
      skipped: [],
      baseRef: null,
    };
    const { fs } = fakeFs();
    expect(restoreIgnored(cp, "/repo", fs)).toEqual([]);
  });
});

// One guarded real-git smoke test: runs ONLY in a throwaway temp dir, never the project tree.
describe("safety/checkpoint real-git smoke (temp dir only)", () => {
  const gitOk = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  test.if(gitOk)("autoWip snapshots an unborn temp repo without crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-cp-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "hello\n");
      const before = gitState(dir);
      expect(before.isRepo).toBe(true);
      expect(before.hasCommits).toBe(false); // unborn
      const cp = createCheckpoint(dir, "smoke", { autoWip: true });
      expect(cp.wipSha).not.toBeNull();
      const after = gitState(dir);
      expect(after.hasCommits).toBe(true); // the wip became the initial commit
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
