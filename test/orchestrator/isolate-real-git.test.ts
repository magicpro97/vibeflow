import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultWorktreeOps, makeWorktreeOps } from "../../src/commands/dispatch-runtime.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function copyHelper(repo: string): void {
  mkdirSync(join(repo, "scripts"));
  copyFileSync(
    new URL("../../scripts/create-worktree.mjs", import.meta.url),
    join(repo, "scripts", "create-worktree.mjs"),
  );
}

function setupRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  copyHelper(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

describe("makeWorktreeOps real-git integration (F1 lock-in)", () => {
  test("create makes a worktree in an isolated temp repo, remove cleans up, base HEAD unchanged", () => {
    const repo = setupRepo("vf-isolate-real-git-");
    const branch = `vf-test-iso-${Date.now()}`;
    const baseSha = git(repo, ["rev-parse", "HEAD"]).trim();
    const wt = makeWorktreeOps(undefined, repo);
    let path = "";
    try {
      path = wt.create(branch, "HEAD");
      expect(existsSync(path)).toBe(true);
      expect(git(repo, ["worktree", "list", "--porcelain"])).toContain(branch);
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseSha);
    } finally {
      wt.remove(path);
      try {
        git(repo, ["branch", "-D", branch]);
      } catch {
        /* best-effort: branch may already be gone */
      }
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseSha);
      expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(branch);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("defaultWorktreeOps resolves repoDir lazily at operation time (not import time)", () => {
    const repo = setupRepo("vf-isolate-lazy-");
    const branch = `vf-test-lazy-${Date.now()}`;
    const pristine = process.cwd();
    let path = "";
    const baseSha = git(repo, ["rev-parse", "HEAD"]).trim();
    try {
      process.chdir(repo);
      try {
        path = defaultWorktreeOps.create(branch, "HEAD");
      } finally {
        process.chdir(pristine);
      }
      expect(process.cwd()).toBe(pristine);
      expect(existsSync(path)).toBe(true);
      expect(realpathSync(dirname(path))).toBe(realpathSync(dirname(repo)));
      expect(git(repo, ["worktree", "list", "--porcelain"])).toContain(branch);
    } finally {
      if (path) {
        process.chdir(repo);
        try {
          defaultWorktreeOps.remove(path);
        } finally {
          process.chdir(pristine);
        }
        try {
          git(repo, ["branch", "-D", branch]);
        } catch {
          /* best-effort: branch may already be gone */
        }
      }
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseSha);
      expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(branch);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
