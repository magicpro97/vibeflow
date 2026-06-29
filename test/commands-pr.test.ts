// test/commands-pr.test.ts
//
// Contract test for `vf pr create` (A7 #173).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_ACCOUNT,
  EXIT_DCO,
  EXIT_OK,
  EXIT_PR_CREATE,
  EXIT_PUSH,
  EXIT_USAGE,
  REQUIRED_GH_ACCOUNT,
  addPrToProject,
  createPr,
  defaultPrBody,
  detectActiveBranch,
  findCommitsLackingDco,
  pr,
  pushBranch,
  readBodyFile,
  verifyGhAccount,
} from "../src/commands/pr.js";

import { EXIT_NOT_FOUND } from "../src/commands/pr-queue.js";
let origCwd: string;
let dir: string;

beforeEach(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "vf-pr-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial", "--", "README.md"], { cwd: dir });
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("vf pr create (A7 #173) — MagicPro97 PR convention", () => {
  test("(a) defaultPrBody includes Summary, F0 review, Verification, Confidence, Fixes", () => {
    const body = defaultPrBody({
      issue: "#173",
      confidence: 1.0,
      opusEvidence: "## 1. No bug found",
      whatChanged: "## What changed\n- test.ts",
      verification: "## Verification\n- 5/5 tests pass",
    });
    expect(body).toContain("## Summary");
    expect(body).toContain("## F0 review fixes");
    expect(body).toContain("## Verification");
    expect(body).toContain("Confidence: 1.0");
    expect(body).toContain("Fixes #173");
  });

  test("(b) verifyGhAccount returns ok:true when account matches", () => {
    const run = (cmd: string) => {
      if (cmd === "gh")
        return { stdout: "github.com\n  account magicpro97\n", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 1 };
    };
    const result = verifyGhAccount({ runCommandSync: run as never });
    expect(result.ok).toBe(true);
    expect(result.account).toBe("magicpro97");
  });

  test("(c) verifyGhAccount returns ok:false when account differs", () => {
    const run = (cmd: string) => {
      if (cmd === "gh")
        return { stdout: "github.com\n  account someone-else\n", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 1 };
    };
    const result = verifyGhAccount({ runCommandSync: run as never });
    expect(result.ok).toBe(false);
    expect(result.account).toBe("someone-else");
  });

  test("(d) verifyGhAccount returns ok:false when no account detected", () => {
    const run = (cmd: string) => {
      if (cmd === "gh") return { stdout: "not logged in", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 1 };
    };
    const result = verifyGhAccount({ runCommandSync: run as never });
    expect(result.ok).toBe(false);
  });

  test("(e) findCommitsLackingDco: empty when all commits have Signed-off-by", () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "log" && args[1] === "--format=%H") {
        return { stdout: "abc\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "-1" && args[2] === "--format=%B") {
        return { stdout: "Signed-off-by: test <test@local>\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 1 };
    };
    const result = findCommitsLackingDco("main", "feature", { runCommandSync: run as never });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("(f) findCommitsLackingDco: lists commits without Signed-off-by", () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "log" && args[1] === "--format=%H") {
        return { stdout: "abc\ndef\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "-1" && args[2] === "--format=%B") {
        const sha = args[3] ?? "";
        if (sha === "def") return { stdout: "no DCO trailer here\n", stderr: "", status: 0 };
        return { stdout: "Signed-off-by: test <test@local>\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 1 };
    };
    const result = findCommitsLackingDco("main", "feature", { runCommandSync: run as never });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual(["def"]);
  });

  test("(g) findCommitsLackingDco: returns ok:false when git log fails (hard refusal)", () => {
    const run = () => ({ stdout: "", stderr: "fatal: bad revision", status: 1 });
    const result = findCommitsLackingDco("main", "feature", { runCommandSync: run as never });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.reason).toContain("git log");
    expect(result.reason).toContain("bad revision");
  });

  test("(h) pushBranch: ok:true on status 0", () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "push") {
        return { stdout: "ok\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 1 };
    };
    const result = pushBranch("feature", { runCommandSync: run as never });
    expect(result.ok).toBe(true);
  });

  test("(i) pushBranch: ok:false on non-zero status", () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "push") {
        return { stdout: "", stderr: "rejected", status: 1 };
      }
      return { stdout: "", stderr: "", status: 1 };
    };
    const result = pushBranch("feature", { runCommandSync: run as never });
    expect(result.ok).toBe(false);
  });

  test("(j) createPr: parses the URL from gh output", () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        return {
          stdout: "https://github.com/magicpro97/vibeflow/pull/207\n",
          stderr: "",
          status: 0,
        };
      }
      return { stdout: "", stderr: "", status: 1 };
    };
    const result = createPr(
      { title: "feat", body: "body", base: "main", head: "feature" },
      { runCommandSync: run as never },
    );
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://github.com/magicpro97/vibeflow/pull/207");
  });

  test("(k) createPr: ok:false on non-zero status", () => {
    const run = () => ({ stdout: "", stderr: "validation failed", status: 1 });
    const result = createPr(
      { title: "feat", body: "body", base: "main", head: "feature" },
      { runCommandSync: run as never },
    );
    expect(result.ok).toBe(false);
  });

  test("(l) addPrToProject: ok:true on status 0", () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "project" && args[1] === "link") {
        return { stdout: "ok\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 1 };
    };
    const result = addPrToProject("https://github.com/magicpro97/vibeflow/pull/207", 6, {
      runCommandSync: run as never,
    });
    expect(result.ok).toBe(true);
  });

  test("(m) addPrToProject: ok:false on non-zero status", () => {
    const run = () => ({ stdout: "", stderr: "project not found", status: 1 });
    const result = addPrToProject("https://github.com/magicpro97/vibeflow/pull/207", 6, {
      runCommandSync: run as never,
    });
    expect(result.ok).toBe(false);
  });

  test("(n) detectActiveBranch: returns stdout trimmed", () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "symbolic-ref") {
        return { stdout: "orch/a7\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 1 };
    };
    const result = detectActiveBranch({ runCommandSync: run as never });
    expect(result).toBe("orch/a7");
  });

  test("(o) readBodyFile: returns content for existing file", () => {
    const path = join(dir, "body.md");
    writeFileSync(path, "  ## Body content\n\n");
    const result = readBodyFile(path, {});
    expect(result).toBe("## Body content");
  });

  test("(p) readBodyFile: returns null for missing file", () => {
    const result = readBodyFile(join(dir, "does-not-exist.md"), {});
    expect(result).toBeNull();
  });

  test("(q) pr with no subcommand → exit 2", async () => {
    const code = await pr([], {}, {});
    expect(code).toBe(EXIT_USAGE);
  });

  test("(r) pr create with unknown subcommand → exit 2", async () => {
    const code = await pr(["bogus"], {}, {});
    expect(code).toBe(EXIT_USAGE);
  });

  test("(s) pr create with missing issue → exit 2", async () => {
    const code = await pr(["create"], {}, {});
    expect(code).toBe(EXIT_USAGE);
  });

  test("(t) pr create with wrong gh account → exit 3", async () => {
    const run = (cmd: string) => {
      if (cmd === "gh")
        return { stdout: "github.com\n  account someone-else\n", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 1 };
    };
    const code = await pr(["create", "#173"], {}, { runCommandSync: run as never });
    expect(code).toBe(EXIT_ACCOUNT);
  });

  test("(u) pr create with commits lacking DCO → exit 4", async () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth") {
        return { stdout: "github.com\n  account magicpro97\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "--format=%H") {
        return { stdout: "abc\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "-1" && args[2] === "--format=%B") {
        return { stdout: "no trailer here\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 1 };
    };
    const code = await pr(
      ["create", "#173"],
      { head: "feature" },
      { runCommandSync: run as never },
    );
    expect(code).toBe(EXIT_DCO);
  });

  test("(v) pr create with --body-file missing → exit 2", async () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth") {
        return { stdout: "github.com\n  account magicpro97\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log") {
        return { stdout: "", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 1 };
    };
    const code = await pr(
      ["create", "#173"],
      { head: "feature", "body-file": join(dir, "missing.md") },
      { runCommandSync: run as never },
    );
    expect(code).toBe(EXIT_USAGE);
  });

  test("(w) pr create happy path → exit 0", async () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth") {
        return { stdout: "github.com\n  account magicpro97\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "--format=%H") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "-1" && args[2] === "--format=%B") {
        return { stdout: "Signed-off-by: test <test@local>\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "push") {
        return { stdout: "ok\n", stderr: "", status: 0 };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        return {
          stdout: "https://github.com/magicpro97/vibeflow/pull/999\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd === "gh" && args[0] === "project" && args[1] === "link") {
        return { stdout: "ok\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "symbolic-ref") {
        return { stdout: "main\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "unmocked", status: 1 };
    };
    const code = await pr(
      ["create", "#173"],
      { head: "orch/a7" },
      { runCommandSync: run as never },
    );
    expect(code).toBe(EXIT_OK);
  });

  test("(x) pr create with push failure → exit 5", async () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth") {
        return { stdout: "github.com\n  account magicpro97\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "--format=%H") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "-1" && args[2] === "--format=%B") {
        return { stdout: "Signed-off-by: test <test@local>\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "push") {
        return { stdout: "", stderr: "rejected: non-fast-forward", status: 1 };
      }
      return { stdout: "", stderr: "", status: 1 };
    };
    const code = await pr(
      ["create", "#173"],
      { head: "orch/a7" },
      { runCommandSync: run as never },
    );
    expect(code).toBe(EXIT_PUSH);
  });

  test("(y) pr create with gh pr create failure → exit 6", async () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth") {
        return { stdout: "github.com\n  account magicpro97\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "--format=%H") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "-1" && args[2] === "--format=%B") {
        return { stdout: "Signed-off-by: test <test@local>\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "push") {
        return { stdout: "ok\n", stderr: "", status: 0 };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        return { stdout: "", stderr: "title is required", status: 1 };
      }
      return { stdout: "", stderr: "unmocked", status: 1 };
    };
    const code = await pr(
      ["create", "#173"],
      { head: "orch/a7" },
      { runCommandSync: run as never },
    );
    expect(code).toBe(EXIT_PR_CREATE);
  });

  test("(z) REQUIRED_GH_ACCOUNT is 'magicpro97'", () => {
    expect(REQUIRED_GH_ACCOUNT).toBe("magicpro97");
  });

  // ---- Additional coverage tests ----
  test("(aa) pr create with project link failure → warning + exit 0", async () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth") {
        return { stdout: "github.com\n  account magicpro97\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "--format=%H") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "-1" && args[2] === "--format=%B") {
        return { stdout: "Signed-off-by: test <test@local>\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "push") {
        return { stdout: "ok\n", stderr: "", status: 0 };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        return {
          stdout: "https://github.com/magicpro97/vibeflow/pull/1001\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd === "gh" && args[0] === "project" && args[1] === "link") {
        return { stdout: "", stderr: "project not found", status: 1 };
      }
      if (cmd === "git" && args[0] === "symbolic-ref") {
        return { stdout: "main\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "unmocked", status: 1 };
    };
    const code = await pr(
      ["create", "#173"],
      { head: "orch/a7" },
      { runCommandSync: run as never },
    );
    expect(code).toBe(EXIT_OK);
  });

  test("(bb) pr create with --project flag sets the project number", async () => {
    let linkProject: string | null = null;
    const run = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth") {
        return { stdout: "github.com\n  account magicpro97\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "--format=%H") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "-1" && args[2] === "--format=%B") {
        return { stdout: "Signed-off-by: test <test@local>\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "push") {
        return { stdout: "ok\n", stderr: "", status: 0 };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        return {
          stdout: "https://github.com/magicpro97/vibeflow/pull/1002\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd === "gh" && args[0] === "project" && args[1] === "link") {
        linkProject = args[4] ?? null;
        return { stdout: "ok\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "symbolic-ref") {
        return { stdout: "main\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "unmocked", status: 1 };
    };
    await pr(
      ["create", "#173"],
      // The flags type is Record<string, string | boolean>, so the
      // project flag comes in as a string. Number() is used in the
      // production code to coerce it. Cast to "as never" to bypass
      // the strict flag type (test-only).
      { head: "orch/a7", project: "42" as never },
      { runCommandSync: run as never },
    );
    // linkProject is args[4] (the project number string from
    // `String(projectNumber)`). Number(6) !== "42", so this proves
    // the --project flag was read and converted.
    expect(linkProject).toBe("42" as unknown as typeof linkProject);
  });

  test("(ff) pr create with no --head and detect returns empty → exit 2", async () => {
    const run = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth") {
        return { stdout: "github.com\n  account magicpro97\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "symbolic-ref") {
        return { stdout: "", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "unmocked", status: 1 };
    };
    const code = await pr(["create", "#173"], {}, { runCommandSync: run as never });
    expect(code).toBe(EXIT_USAGE);
  });

  test("(dd) pr create with DCO check error (git log fails) → exit 4", async () => {
    // The new "ok: false" branch in findCommitsLackingDco surfaces
    // as a DCO check failure with a distinct error message.
    const run = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth") {
        return { stdout: "github.com\n  account magicpro97\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "--format=%H") {
        return { stdout: "", stderr: "fatal: bad revision", status: 1 };
      }
      return { stdout: "", stderr: "unmocked", status: 1 };
    };
    const code = await pr(
      ["create", "#173"],
      { head: "feature" },
      { runCommandSync: run as never },
    );
    expect(code).toBe(EXIT_DCO);
  });

  test("(ee) pr create with --body-file present → reads content", async () => {
    // Coverage: the readBodyFile OK path is exercised in (v) and (w);
    // this test is the explicit "body found" happy path.
    const bodyPath = join(dir, "body.md");
    writeFileSync(bodyPath, "## My custom body\n\nSigned-off-by: x\n");
    const run = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth") {
        return { stdout: "github.com\n  account magicpro97\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "--format=%H") {
        return { stdout: "", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "log" && args[1] === "-1" && args[2] === "--format=%B") {
        return { stdout: "Signed-off-by: test <test@local>\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "push") {
        return { stdout: "ok\n", stderr: "", status: 0 };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        // Verify the body file content is what got passed to gh.
        // createPr invokes: gh pr create --title <t> --body <body>
        // So args[0] = "pr", args[1] = "create", args[2] = "--title",
        // args[3] = title, args[4] = "--body", args[5] = body.
        const bodyArg = args[5] ?? "";
        if (!bodyArg.includes("My custom body")) {
          return { stdout: "", stderr: `body mismatch: ${bodyArg}`, status: 1 };
        }
        return {
          stdout: "https://github.com/magicpro97/vibeflow/pull/2000\n",
          stderr: "",
          status: 0,
        };
      }
      if (cmd === "gh" && args[0] === "project" && args[1] === "link") {
        return { stdout: "ok\n", stderr: "", status: 0 };
      }
      if (cmd === "git" && args[0] === "symbolic-ref") {
        return { stdout: "main\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "unmocked", status: 1 };
    };
    const code = await pr(
      ["create", "#173"],
      { head: "orch/a7", "body-file": bodyPath },
      { runCommandSync: run as never },
    );
    expect(code).toBe(EXIT_OK);
  });

  test("(cc) default runCommandSync fallback exists (no inject)", () => {
    // Just check that the function doesn't crash on a real spawnSync
    // call. The actual `gh auth status` may succeed (we're logged in
    // as magicpro97) or fail (no auth). Either way the fallback path
    // ran (i.e. spawnSync was called).
    const result = verifyGhAccount({});
    expect(typeof result.ok).toBe("boolean");
  }, 30_000);
  test("(gg) pr queue list dispatches to prQueue → exit ok (empty queue)", async () => {
    const code = await pr(["queue", "list"], {}, { existsSync: () => false });
    expect(code).toBe(EXIT_OK);
  });

  test("(hh) pr merge-when-green dispatches → exit not-found (empty queue)", async () => {
    const code = await pr(["merge-when-green"], {}, { existsSync: () => false });
    expect(code).toBe(EXIT_NOT_FOUND);
  });
});

describe("pr split (#186 PR5 sentinel)", () => {
  const repoRoot = process.cwd();
  const facade = readFileSync(join(repoRoot, "src/commands/pr.ts"), "utf8");
  test("facade re-exports moved fns from pr-gh", () => {
    expect(facade).toMatch(/from\s*["']\.\/pr-gh\.js["']/);
  });
  test("moved bodies live in the new file, not the facade", () => {
    expect(facade).not.toMatch(/^export\s+function\s+verifyGhAccount\s*\(/m);
    const gh = readFileSync(join(repoRoot, "src/commands/pr-gh.ts"), "utf8");
    expect(gh).toMatch(/^export\s+function\s+verifyGhAccount\s*\(/m);
  });
  test("size-waiver removed", () => {
    expect(facade).not.toMatch(/size-waiver/);
  });
});
