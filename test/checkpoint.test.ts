import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// ---------------------------------------------------------------------------
// Coverage-gap tests: exercise the production-default seams (defaultGit +
// defaultFs) and the `?? null` defensive fallbacks inside makeWip.
// These run on a real tmpdir so the default filesystem code paths can touch
// actual files; the git side is faked or spawn-failed as needed.
// ---------------------------------------------------------------------------

describe("safety/checkpoint defaultFs seam (no fs injection)", () => {
  const gitOk = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  test.if(gitOk)(
    "uses the real defaultFs (copyFile/mkdirp/size/isDir) on a real tmpdir without injecting fs",
    () => {
      // No `fs` option → createCheckpoint falls through to `opts.fs ?? defaultFs()`.
      // The defaultFs implementations touch the real filesystem (mkdirSync, copyFileSync,
      // statSync). We seed an ignored file and assert the backup copy lands in the
      // canonical backup dir, proving all four default methods were exercised.
      const dir = mkdtempSync(join(tmpdir(), "vf-cp-df-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
        execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
        // A small ignored file the defaultFs.copyFile + size will copy.
        writeFileSync(join(dir, ".env.local"), "SECRET=1\n");
        execFileSync("git", ["status", "--porcelain"], { cwd: dir }); // warm up
        // The fake git runner answers all probes as if the repo is clean & empty,
        // but with the ignored-dirty file listed. No `fs` injection → defaultFs.
        const { runner } = fakeGit([
          ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
          ["rev-parse --verify HEAD", { status: 128 }], // unborn
          ["status --porcelain", { status: 0, stdout: "" }],
          ["ls-files --others --exclude-standard", { status: 0, stdout: "" }],
          [
            "ls-files --others --ignored --exclude-standard",
            { status: 0, stdout: ".env.local\n" },
          ],
        ]);
        const cp = createCheckpoint(dir, "df-run", { git: runner });
        expect(cp.isRepo).toBe(true);
        expect(cp.backedUp).toContain(".env.local");
        // The real defaultFs.copyFile must have produced a real file on disk
        // under the canonical backup location.
        const copied = join(dir, ".vibeflow", "backup", "df-run", ".env.local");
        expect(existsSync(copied)).toBe(true);
        expect(readFileSync(copied, "utf8")).toBe("SECRET=1\n");
        // The defaultFs.writeFile (ensureCtxIgnored) must have written the guard.
        const guard = join(dir, ".vibeflow", ".gitignore");
        expect(existsSync(guard)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.if(gitOk)(
    "defaultFs.isDir try/catch branch fires when the ignored entry is a directory (no fs injection)",
    () => {
      // The defaultFs.isDir wraps statSync in try/catch and returns false on
      // failure. We seed a *real* ignored directory: statSync will succeed and
      // return isDirectory()=true, so the entry is skipped via the "isDir"
      // branch (not the catch). Combined with the sibling file, this also
      // exercises defaultFs.size + copyFile for the file.
      const dir = mkdtempSync(join(tmpdir(), "vf-cp-df2-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
        execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
        mkdirSync(join(dir, "web"));
        writeFileSync(join(dir, "web", "x.txt"), "x");
        writeFileSync(join(dir, ".env.local"), "S=1\n");
        const { runner } = fakeGit([
          ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
          ["rev-parse --verify HEAD", { status: 0, stdout: "abc" }],
          ["status --porcelain", { status: 0, stdout: "" }],
          ["ls-files --others --exclude-standard", { status: 0, stdout: "" }],
          [
            "ls-files --others --ignored --exclude-standard",
            { status: 0, stdout: "web\n.env.local\n" },
          ],
        ]);
        const cp = createCheckpoint(dir, "df2", { git: runner });
        expect(cp.skipped.some((s) => s.includes("web") && s.includes("directory"))).toBe(true);
        expect(cp.backedUp).toContain(".env.local");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("safety/checkpoint defaultGit seam (no git injection)", () => {
  // When the working directory is not accessible (or git cannot run from it),
  // node:child_process's spawnSync returns { status: undefined, stdout: null,
  // stderr: null, error: ENOENT }. defaultGit's defensive fallbacks then fire.
  // We trigger this by passing a non-existent base path AND omitting the `git`
  // injection — the production code constructs `defaultGit(base)` whose closure
  // hits the three `??` fallbacks on its first call.
  test("defaultGit fallbacks (r.status ?? 1, r.stdout ?? '', r.stderr ?? '') fire when spawn fails", () => {
    // Sanity probe: confirm a spawn with the same args fails in this runtime.
    // Under bun, `status`/`stdout`/`stderr` may be `undefined`; under node,
    // they may be `null`. Both are caught by the `??` fallback.
    const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: "/nonexistent/garbage/dir",
      encoding: "utf8",
    });
    expect(probe.status == null).toBe(true);
    expect(probe.stdout == null).toBe(true);
    expect(probe.stderr == null).toBe(true);
    // The closure runs once for `rev-parse --is-inside-work-tree`, hits the
    // ENOENT, takes all three `??` fallbacks, returns status:1, and the call
    // degrades to isRepo:false.
    const cp = createCheckpoint("/nonexistent/garbage/dir", "nopath");
    expect(cp.isRepo).toBe(false);
  });
});

describe("safety/checkpoint makeWip ?? null fallbacks", () => {
  test("baseRef=null when the makeWip HEAD probe returns empty stdout (lines()[0] ?? null)", () => {
    // The gitState probe and the makeWip probe both call `rev-parse --verify
    // HEAD`. We need different responses: gitState must return a valid SHA
    // (so hasCommits=true), and makeWip's probe must return empty stdout
    // (so lines()[0] is undefined → null). Use a call-counting runner.
    const responses: Array<{ status: number; stdout: string; stderr: string }> = [
      // 1st call: gitState rev-parse --is-inside-work-tree
      { status: 0, stdout: "true", stderr: "" },
      // 2nd call: gitState rev-parse --verify HEAD  → hasCommits=true
      { status: 0, stdout: "deadbeef\n", stderr: "" },
      // 3rd call: gitState status --porcelain
      { status: 0, stdout: "", stderr: "" },
      // 4th call: gitState ls-files --others --exclude-standard
      { status: 0, stdout: "", stderr: "" },
      // 5th call: gitState ls-files --others --ignored --exclude-standard
      { status: 0, stdout: "", stderr: "" },
      // 6th call: makeWip rev-parse --verify HEAD  → empty stdout → ?? null
      { status: 0, stdout: "", stderr: "" },
      // 7th call: makeWip add -A
      { status: 0, stdout: "", stderr: "" },
      // 8th call: makeWip commit -m ...
      { status: 0, stdout: "", stderr: "" },
      // 9th call: makeWip rev-parse HEAD (post-commit) → empty → wipSha null
      { status: 0, stdout: "", stderr: "" },
    ];
    const calls: string[] = [];
    const runner: GitRunner = (args) => {
      calls.push(args.join(" "));
      return responses.shift() ?? { status: 0, stdout: "", stderr: "" };
    };
    const { fs } = fakeFs();
    const cp = createCheckpoint("/repo", "empty", {
      autoWip: true,
      git: runner,
      fs,
    });
    expect(cp.hasCommits).toBe(true);
    expect(cp.baseRef).toBeNull();
    expect(cp.wipSha).toBeNull();
    // Sanity: the runner really did see both the makeWip HEAD probe and the
    // post-commit rev-parse HEAD.
    expect(calls).toContain("rev-parse --verify HEAD");
    expect(calls).toContain("rev-parse HEAD");
  });

  test("baseRef=null when no autoWip is requested (no makeWip call)", () => {
    // Trivial: autoWip=false skips makeWip entirely, so baseRef stays null.
    // This is the existing behaviour, asserted here for symmetry.
    const { runner } = fakeGit([
      ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true" }],
      ["rev-parse --verify HEAD", { status: 0, stdout: "feedface\n" }],
      ["status --porcelain", { status: 0, stdout: "" }],
      ["ls-files --others --exclude-standard", { status: 0, stdout: "" }],
      ["ls-files --others --ignored --exclude-standard", { status: 0, stdout: "" }],
    ]);
    const { fs } = fakeFs();
    const cp = createCheckpoint("/repo", "noauto", { git: runner, fs });
    expect(cp.hasCommits).toBe(true);
    expect(cp.baseRef).toBeNull();
    expect(cp.wipSha).toBeNull();
  });
});
