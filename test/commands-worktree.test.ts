// test/commands-worktree.test.ts
//
// Contract test for A6 (issue #172) `vf worktree create|remove|list`.
//
// Per the A6 spec test requirement:
//   "Test: create + remove in a temp repo; verify node_modules is a
//    symlink to the parent's."
//
// We use REAL git in a tmpdir (not mocked git) per the RCA rule from
// the prior failure. The TS wrapper is unit-tested via the
// `runCommandSync` inject seam (same pattern as `commands-review.test.ts`).
// The end-to-end real-git test exercises the helper script.
//
// Coverage targets:
//   (a) worktree() with no action → exit 2 (usage)
//   (b) worktree() with unknown action → exit 2
//   (c) worktreeCreate() with no branch → exit 2
//   (d) worktreeCreate() with existing worktree path → exit 2 (clobber refused)
//   (e) worktreeCreate() with happy inject → exit 0
//   (f) worktreeCreate() with helper exit 1 → exit 1 (relays stderr)
//   (g) worktreeCreate() with helper spawn error → exit 1
//   (h) worktreeRemove() with no branch → exit 2
//   (i) worktreeRemove() with branch that has no worktree → exit 2
//   (j) worktreeRemove() happy path → exit 0
//   (k) worktreeRemove() with git worktree remove failure → exit 1
//   (l) worktreeList() with no worktrees → exit 0, prints "(no worktrees)"
//   (m) worktreeList() happy path → exit 0
//   (n) worktreeList() with git failure → exit 1
//   (o) defaultWorktreePath: sibling of parent dir
//   (p) buildCreateArgs: includes --base when given
//   (q) [E2E] real git in tmpdir: create a worktree, verify
//       node_modules is a symlink to the parent's, then remove it
//   (r) [E2E] create refuses to clobber an existing worktree path
//   (s) [E2E] create with --base works (branches from a named base)
//   (t) [E2E] TS wrapper: worktree(["create", ...]) end-to-end —
//       exit 0, worktree exists, node_modules is a symlink to parent
//   (u) [E2E] TS wrapper: worktree(["remove", ...]) end-to-end —
//       exit 0, worktree gone, branch pruned from worktree list

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCreateArgs,
  defaultWorktreePath,
  worktree,
  worktreeCreate,
  worktreeList,
  worktreeRemove,
} from "../src/commands.js";
import type { RunCommandResult, WorktreeInject } from "../src/commands.js";

let origCwd: string;
let dir: string;

beforeEach(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "vf-worktree-test-"));
});

afterEach(() => {
  process.chdir(origCwd);
  // Best-effort: any leftover worktrees in `dir` get pruned. Tests
  // that exercise `worktreeRemove` already clean up; this guards
  // against mid-test failures.
  if (existsSync(dir)) {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: dir, stdio: "ignore" });
    } catch {
      // not a git repo or no worktrees — safe to ignore
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a fake inject that records calls and returns a configurable result. */
function fakeRun(
  result: RunCommandResult,
  calls: { cmd: string; args: readonly string[] }[] = [],
): WorktreeInject["runCommandSync"] {
  return (cmd, args) => {
    calls.push({ cmd, args });
    return result;
  };
}

describe("vf worktree (A6 #172) — TS wrapper, inject-driven", () => {
  test("(a) worktree() with no action → exit 2 (usage)", () => {
    const code = worktree([], {});
    expect(code).toBe(2);
  });

  test("(b) worktree() with unknown action → exit 2", () => {
    const code = worktree(["bogus"], {});
    expect(code).toBe(2);
  });

  test("(c) worktreeCreate() with no branch → exit 2", () => {
    const code = worktreeCreate([], {});
    expect(code).toBe(2);
  });

  test("(d) worktreeCreate() with existing worktree path → exit 2 (clobber refused)", () => {
    // The clobber check uses `existsSync(<wtPath>)`. Plant a file
    // at the default path so the check trips.
    process.chdir(dir);
    const branch = "feature";
    const wtPath = defaultWorktreePath(branch, dir);
    mkdirSync(wtPath, { recursive: true });
    const code = worktreeCreate([branch], {});
    expect(code).toBe(2);
  });

  test("(e) worktreeCreate() happy path → exit 0", () => {
    process.chdir(dir);
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const run = fakeRun({ status: 0, stdout: "", stderr: "" }, calls);
    const code = worktreeCreate(["feature"], {}, { runCommandSync: run });
    expect(code).toBe(0);
    // The helper script is invoked with branch + path as argv.
    expect(calls.length).toBe(1);
    const c0 = calls[0];
    if (!c0) throw new Error("expected one call");
    expect(c0.args[0]).toBe("feature");
    // `defaultWorktreePath(branch, dir)` joins `dir` (raw tmpdir
    // path) to `vf-wt-<branch>`. The worktree module itself uses
    // `cwd()` which resolves the tmpdir symlink (e.g. on macOS
    // `/var/folders/...` -> `/private/var/folders/...`). Compare
    // against the resolved path so the test works on both
    // symlinked and non-symlinked tmpdirs.
    expect(c0.args[1]).toBe(defaultWorktreePath("feature", process.cwd()));
  });

  test("(f) worktreeCreate() with helper exit 1 → exit 1 (relays stderr)", () => {
    process.chdir(dir);
    const run = fakeRun({
      status: 1,
      stdout: "",
      stderr: "create-worktree.sh: git worktree add -b feature /tmp/... failed",
    });
    const code = worktreeCreate(["feature"], {}, { runCommandSync: run });
    expect(code).toBe(1);
  });

  test("(g) worktreeCreate() with helper spawn error → exit 1", () => {
    process.chdir(dir);
    const err = new Error("ENOENT");
    const run = fakeRun({ status: null, stdout: "", stderr: "", error: err });
    const code = worktreeCreate(["feature"], {}, { runCommandSync: run });
    expect(code).toBe(1);
  });

  test("(h) worktreeRemove() with no branch → exit 2", () => {
    const code = worktreeRemove([], {});
    expect(code).toBe(2);
  });

  test("(i) worktreeRemove() with branch that has no worktree → exit 2", () => {
    process.chdir(dir);
    // git worktree list —porcelain with no worktrees (just the
    // main repo) won't include the branch we're looking for.
    const porcelain = `worktree ${dir}\nHEAD abc123\nbranch refs/heads/main\n\n`;
    const run = fakeRun({ status: 0, stdout: porcelain, stderr: "" });
    const code = worktreeRemove(["nope"], {}, { runCommandSync: run });
    expect(code).toBe(2);
  });

  test("(j) worktreeRemove() happy path → exit 0", () => {
    process.chdir(dir);
    const wt = "/tmp/some-worktree";
    const porcelain = `worktree ${wt}\nHEAD abc123\nbranch refs/heads/feature\n\n`;
    const calls: { cmd: string; args: readonly string[] }[] = [];
    // First call (list) returns the porcelain; second call (remove)
    // returns success.
    let n = 0;
    const run: WorktreeInject["runCommandSync"] = (_cmd, args) => {
      calls.push({ cmd: _cmd, args });
      if (args[1] === "list") {
        return { status: 0, stdout: porcelain, stderr: "" };
      }
      n++;
      return { status: 0, stdout: "", stderr: "" };
    };
    const code = worktreeRemove(["feature"], {}, { runCommandSync: run });
    expect(code).toBe(0);
    expect(calls.length).toBe(2);
    const removeCall = calls[1];
    if (!removeCall) throw new Error("expected remove call");
    expect(removeCall.cmd).toBe("git");
    expect(removeCall.args).toEqual(["worktree", "remove", "--force", wt]);
    expect(n).toBe(1);
  });

  test("(k) worktreeRemove() with git worktree remove failure → exit 1", () => {
    process.chdir(dir);
    const wt = "/tmp/some-worktree";
    const porcelain = `worktree ${wt}\nHEAD abc123\nbranch refs/heads/feature\n\n`;
    let n = 0;
    const run: WorktreeInject["runCommandSync"] = (_cmd, args) => {
      if (args[1] === "list") {
        return { status: 0, stdout: porcelain, stderr: "" };
      }
      n++;
      return { status: 1, stdout: "", stderr: "permission denied" };
    };
    const code = worktreeRemove(["feature"], {}, { runCommandSync: run });
    expect(code).toBe(1);
    expect(n).toBe(1);
  });

  test("(l) worktreeList() with no worktrees → exit 0, prints (no worktrees)", () => {
    process.chdir(dir);
    const run = fakeRun({ status: 0, stdout: "", stderr: "" });
    const code = worktreeList([], {}, { runCommandSync: run });
    expect(code).toBe(0);
  });

  test("(m) worktreeList() happy path → exit 0", () => {
    process.chdir(dir);
    const porcelain = [
      `worktree ${dir}`,
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      `worktree ${dir}-wt`,
      "HEAD def456",
      "branch refs/heads/feature",
      "",
    ].join("\n");
    const run = fakeRun({ status: 0, stdout: porcelain, stderr: "" });
    const code = worktreeList([], {}, { runCommandSync: run });
    expect(code).toBe(0);
  });

  test("(n) worktreeList() with git failure → exit 1", () => {
    process.chdir(dir);
    const run = fakeRun({ status: 128, stdout: "", stderr: "fatal: not a git repo" });
    const code = worktreeList([], {}, { runCommandSync: run });
    expect(code).toBe(1);
  });

  test("(o) defaultWorktreePath: sibling of parent dir", () => {
    const p = defaultWorktreePath("mybranch", "/tmp/parent");
    expect(p).toBe("/tmp/parent/vf-wt-mybranch");
  });

  test("(p) buildCreateArgs: includes --base when given", () => {
    process.chdir(dir);
    const r = buildCreateArgs("feature", "/tmp/wt", "main");
    expect(r.args).toEqual(["feature", "/tmp/wt", "--base", "main"]);
    const r2 = buildCreateArgs("feature", "/tmp/wt");
    expect(r2.args).toEqual(["feature", "/tmp/wt"]);
  });
});

describe("vf worktree (A6 #172) — E2E with real git + real helper script", () => {
  // We use REAL git (execFileSync) in a tmpdir per the A6 spec:
  // "Test: create + remove in a temp repo; verify node_modules is a
  //  symlink to the parent's." The helper script is invoked
  // unchanged. We plant a `node_modules` dir in the parent so the
  // symlink has something to point at.

  /** Plant a tmpdir git repo with one commit on `main`. */
  function plantRepo(): { repoDir: string; wtDir: string } {
    const repoDir = dir;
    const wtDir = join(repoDir, "vf-wt-a6test");
    execFileSync("git", ["init", "--initial-branch=main", repoDir], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"], { stdio: "ignore" });
    writeFileSync(join(repoDir, "README.md"), "# test\n");
    // Gitignore node_modules — the real-world case is that
    // `node_modules` is never tracked, so `git worktree add`
    // doesn't auto-checkout a real dir into the worktree. If we
    // committed node_modules, the helper would see the
    // auto-checked-out dir and (correctly) refuse to overwrite
    // it. The symlink contract only fires when node_modules is
    // not in the worktree yet.
    writeFileSync(join(repoDir, ".gitignore"), "node_modules\n");
    // Plant a fake node_modules so the symlink has a target.
    mkdirSync(join(repoDir, "node_modules"), { recursive: true });
    writeFileSync(join(repoDir, "node_modules", "package.json"), "{}\n");
    execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "init"], { stdio: "ignore" });
    return { repoDir, wtDir };
  }

  /** Plant a tmpdir git repo AND copy the helper script into
   *  `<repoDir>/scripts/create-worktree.sh`. The TS wrapper
   *  resolves the helper via `buildCreateArgs` =
   *  `join(cwd(), "scripts", "create-worktree.sh")`, so the
   *  test must chdir into a dir where that path resolves. */
  function plantRepoWithScripts(): { repoDir: string; wtDir: string } {
    const { repoDir, wtDir } = plantRepo();
    const srcScript = join(process.cwd(), "scripts", "create-worktree.sh");
    const dstDir = join(repoDir, "scripts");
    mkdirSync(dstDir, { recursive: true });
    const { copyFileSync } = require("node:fs") as typeof import("node:fs");
    copyFileSync(srcScript, join(dstDir, "create-worktree.sh"));
    // The helper has its shebang + execution perms in the repo
    // tree; preserve them in the copy.
    const { statSync, chmodSync } = require("node:fs") as typeof import("node:fs");
    const s = statSync(srcScript);
    chmodSync(join(dstDir, "create-worktree.sh"), s.mode);
    return { repoDir, wtDir };
  }

  test("(q) create + remove in a temp repo; verify node_modules is a symlink to the parent's", () => {
    const { repoDir, wtDir } = plantRepo();
    // Run the helper directly (it's a real bash script). The TS
    // wrapper just shells out to it; verifying the helper's real
    // behavior covers the A6 spec's "Test:" requirement.
    const helper = join(process.cwd(), "scripts", "create-worktree.sh");
    execFileSync("bash", [helper, "a6test", wtDir], {
      cwd: repoDir,
      stdio: "ignore",
    });

    // After the create: the worktree exists, node_modules in the
    // worktree is a SYMLINK to <repoDir>/node_modules, and `git
    // worktree list` shows the new branch.
    expect(existsSync(join(wtDir, "README.md"))).toBe(true);
    const lstat = lstatSync(join(wtDir, "node_modules"));
    expect(lstat.isSymbolicLink()).toBe(true);
    const linkTarget = readlinkSync(join(wtDir, "node_modules"));
    // The helper uses an absolute symlink to the parent's
    // node_modules. `linkTarget` is the stored symlink value —
    // on macOS the parent's path may already be resolved
    // (`/private/var/folders/...`) or unresolved (`/var/folders/...`)
    // depending on how the helper was invoked. Compare via
    // realpath so the test works on both.
    const expectedParent = join(repoDir, "node_modules");
    if (linkTarget.startsWith("/")) {
      // Absolute symlink — compare via realpath to handle the
      // macOS /var vs /private/var symlink case.
      const { realpathSync } = require("node:fs") as typeof import("node:fs");
      expect(realpathSync(linkTarget)).toBe(realpathSync(expectedParent));
    } else {
      // Relative symlink — resolve relative to the worktree.
      const resolved = join(wtDir, "node_modules", linkTarget);
      expect(resolved).toBe(expectedParent);
    }

    // Remove the worktree.
    execFileSync("git", ["worktree", "remove", "--force", wtDir], {
      cwd: repoDir,
      stdio: "ignore",
    });
    expect(existsSync(wtDir)).toBe(false);
  });

  test("(r) create refuses to clobber an existing worktree path", () => {
    const { repoDir, wtDir } = plantRepo();
    // Plant a directory at the target path BEFORE running the
    // helper. The helper's preflight check should refuse to clobber.
    mkdirSync(wtDir, { recursive: true });
    const helper = join(process.cwd(), "scripts", "create-worktree.sh");
    let code = 0;
    let stderr = "";
    try {
      execFileSync("bash", [helper, "a6test", wtDir], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer };
      code = e.status ?? 1;
      stderr = e.stderr ? e.stderr.toString() : "";
    }
    expect(code).not.toBe(0);
    expect(stderr).toContain("refusing to clobber");
  });

  test("(s) create with --base works (branches from a named base)", () => {
    const { repoDir, wtDir } = plantRepo();
    // Create a `base` branch with a marker commit so we can verify
    // the new branch is forked from it.
    execFileSync("git", ["-C", repoDir, "checkout", "-b", "base"], { stdio: "ignore" });
    writeFileSync(join(repoDir, "BASE.md"), "base\n");
    execFileSync("git", ["-C", repoDir, "add", "BASE.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "base"], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "checkout", "main"], { stdio: "ignore" });

    const helper = join(process.cwd(), "scripts", "create-worktree.sh");
    execFileSync("bash", [helper, "feature", wtDir, "--base", "base"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    // The new worktree should be on `feature` and contain BASE.md.
    expect(existsSync(join(wtDir, "BASE.md"))).toBe(true);

    // Cleanup
    execFileSync("git", ["worktree", "remove", "--force", wtDir], {
      cwd: repoDir,
      stdio: "ignore",
    });
  });

  // --- E2E via the TS wrapper (not just the bash helper) ---
  // The (q) test above exercises the bash helper directly. These
  // two tests exercise the TS entry point (`worktree(["create",
  // ...])` / `worktree(["remove", ...])`) end-to-end against a
  // real tmpdir repo, per the Codex review gap: "the TS path is
  // covered by inject tests (j/k) but never against a real `git
  // worktree list --porcelain`."

  test("(t) E2E [TS wrapper] worktree create: exit 0, worktree exists, node_modules is a symlink", () => {
    const { repoDir } = plantRepoWithScripts();
    // chdir into the tmpdir so `buildCreateArgs` resolves the
    // helper at `<repoDir>/scripts/create-worktree.sh`. The
    // `defaultWorktreePath` will also resolve to
    // `<repoDir>/vf-wt-a6test`, which is inside the tmpdir.
    process.chdir(repoDir);

    const code = worktree(["create", "a6test"], {});
    expect(code).toBe(0);

    const wtDir = join(repoDir, "vf-wt-a6test");
    // The worktree path must exist after create.
    expect(existsSync(wtDir)).toBe(true);
    // A6 spec: "verify node_modules is a symlink to the parent's."
    const lstat = lstatSync(join(wtDir, "node_modules"));
    expect(lstat.isSymbolicLink()).toBe(true);
    const linkTarget = readlinkSync(join(wtDir, "node_modules"));
    const expectedParent = join(repoDir, "node_modules");
    if (linkTarget.startsWith("/")) {
      const { realpathSync } = require("node:fs") as typeof import("node:fs");
      expect(realpathSync(linkTarget)).toBe(realpathSync(expectedParent));
    } else {
      expect(join(wtDir, "node_modules", linkTarget)).toBe(expectedParent);
    }
  });

  test("(u) E2E [TS wrapper] worktree remove: exit 0, worktree gone, branch pruned from list", () => {
    const { repoDir, wtDir } = plantRepoWithScripts();
    // First, create a worktree via real `git worktree add` (no
    // need to go through the TS wrapper for the create here —
    // we're testing remove).
    execFileSync("git", ["-C", repoDir, "worktree", "add", "-b", "a6test", wtDir], {
      stdio: "ignore",
    });
    expect(existsSync(wtDir)).toBe(true);

    // Now run the TS wrapper's remove against the real repo.
    process.chdir(repoDir);
    const code = worktree(["remove", "a6test"], {});
    expect(code).toBe(0);

    // Worktree dir must be gone.
    expect(existsSync(wtDir)).toBe(false);
    // The branch must be pruned from the worktree list. We check
    // this by re-running `git worktree list --porcelain` and
    // asserting the branch doesn't appear.
    const porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(porcelain).not.toContain("branch refs/heads/a6test");
  });

  // ---- (y) worktree remove: when `git worktree list` itself fails → exit 1 ----
  test("(y) worktree remove: git worktree list fails → exit 1", async () => {
    const code = await worktree(
      ["remove", "feature-x"],
      {},
      {
        runCommandSync: (cmd, args) => {
          if (cmd === "git" && args[0] === "worktree" && args[1] === "list") {
            return { stdout: "", stderr: "fatal: not a git repository", status: 128 };
          }
          return { stdout: "", stderr: "unmocked", status: 1 };
        },
      },
    );
    expect(code).toBe(1);
  });

  // ---- (z) worktree list: routing through the switch's "list" arm ----
  // The list arm calls worktreeList() which prints the table. We
  // can't easily test the print output, but we can verify that
  // the routing reaches the list path by stubbing runCommandSync
  // to return a single worktree entry.
  test("(z) worktree list: routing reaches the list subcommand", async () => {
    const code = await worktree(
      ["list"],
      {},
      {
        runCommandSync: (cmd, args) => {
          if (cmd === "git" && args[0] === "worktree" && args[1] === "list") {
            return {
              stdout: "worktree /path/main\nHEAD aaa\nbranch refs/heads/main\n",
              stderr: "",
              status: 0,
            };
          }
          if (cmd === "git" && args[0] === "merge-base") {
            return { stdout: "", stderr: "", status: 0 };
          }
          if (cmd === "git" && args[0] === "log") {
            return { stdout: "2026-06-20T12:00:00+07:00", stderr: "", status: 0 };
          }
          return { stdout: "", stderr: "unmocked", status: 1 };
        },
      },
    );
    expect(code).toBe(0);
  });
});
