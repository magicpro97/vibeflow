import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorktreeOps } from "../../src/commands/dispatch-runtime.js";

const HAS_BASH = process.platform !== "win32";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

describe("makeWorktreeOps real-git integration (F1 lock-in)", () => {
  test.skipIf(!HAS_BASH)(
    "create makes a worktree in an isolated temp repo, remove cleans up, base HEAD unchanged",
    () => {
      const repo = mkdtempSync(join(tmpdir(), "vf-isolate-real-git-"));
      const branch = `vf-test-iso-${Date.now()}`;
      let wt: ReturnType<typeof makeWorktreeOps> | undefined;
      let path: string | undefined;
      let baseSha = "";
      try {
        mkdirSync(join(repo, "scripts"));
        copyFileSync(
          new URL("../../scripts/create-worktree.sh", import.meta.url).pathname,
          join(repo, "scripts", "create-worktree.sh"),
        );
        git(repo, ["init", "-q", "-b", "main"]);
        git(repo, ["config", "user.email", "t@t"]);
        git(repo, ["config", "user.name", "t"]);
        writeFileSync(join(repo, "README.md"), "fixture\n");
        git(repo, ["add", "README.md"]);
        git(repo, ["commit", "-qm", "base"]);
        baseSha = git(repo, ["rev-parse", "HEAD"]).trim();

        wt = makeWorktreeOps(undefined, repo);
        path = wt.create(branch, "HEAD");
        expect(existsSync(path)).toBe(true);
        expect(git(repo, ["worktree", "list", "--porcelain"])).toContain(branch);

        // base HEAD unchanged after worktree create
        expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseSha);
      } finally {
        if (path && wt) {
          wt.remove(path);
          expect(existsSync(path)).toBe(false);
          try {
            git(repo, ["branch", "-D", branch]);
          } catch {
            /* best-effort: branch may already be gone */
          }
        }
        // after cleanup: no leftover branch/worktree, base HEAD unchanged
        expect(baseSha).toBeTruthy();
        expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseSha);
        expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(branch);
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});
