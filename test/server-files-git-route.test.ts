import { describe, expect, test } from "bun:test";
import { unsafeGitPath } from "../src/core/file-tree-contract.js";
import {
  DIFF_MAX_CHARS,
  type FilesGitDeps,
  STAGE_BUTTON_CAP,
  handleFilesDiffRoute,
  handleFilesStageRoute,
  handleFilesUnstageRoute,
  validateGitPaths,
} from "../src/server/files-git-route.js";

// Fake runner: records argv and returns the canned result — never launches git.
function fakeGit(result: { status: number | null; stdout: string; stderr?: string }) {
  const calls: { args: string[]; cwd: string }[] = [];
  const deps: FilesGitDeps = {
    runGit: (args, cwd) => {
      calls.push({ args, cwd });
      return result;
    },
  };
  return { calls, deps };
}

const PATHS = ["src/a.ts", "docs/b c.md"];

describe("stage/unstage routes: exact argv, git exit codes are not HTTP errors", () => {
  test("stage runs exactly `git add -- <paths>` and reports the changed count", async () => {
    const git = fakeGit({ status: 0, stdout: "" });
    const res = handleFilesStageRoute("/repo", PATHS, git.deps);
    const body = (await res.json()) as { ok: boolean; changed: number };
    expect(res.status).toBe(200);
    expect(git.calls).toHaveLength(1);
    expect(git.calls[0]?.args).toEqual(["add", "--", "src/a.ts", "docs/b c.md"]);
    expect(git.calls[0]?.cwd).toBe("/repo");
    expect(body).toEqual({ ok: true, changed: 2 });
  });

  test("unstage runs exactly `git restore --staged -- <paths>`", async () => {
    const git = fakeGit({ status: 0, stdout: "" });
    const res = handleFilesUnstageRoute("/repo", PATHS, git.deps);
    const body = (await res.json()) as { ok: boolean; changed: number };
    expect(res.status).toBe(200);
    expect(git.calls[0]?.args).toEqual(["restore", "--staged", "--", "src/a.ts", "docs/b c.md"]);
    expect(git.calls[0]?.cwd).toBe("/repo");
    expect(body).toEqual({ ok: true, changed: 2 });
  });

  test("non-zero git status: 200, ok:false, first stderr line only", async () => {
    const git = fakeGit({
      status: 1,
      stdout: "",
      stderr: "fatal: pathspec 'nope.ts' did not match any file(s)\nsecond line never leaks",
    });
    const res = handleFilesStageRoute("/repo", ["nope.ts"], git.deps);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("fatal: pathspec 'nope.ts' did not match any file(s)");
    expect(git.calls[0]?.args).toEqual(["add", "--", "nope.ts"]);
  });

  test("runner failure (status null, no stderr) degrades to a stable reason", async () => {
    const git = fakeGit({ status: null, stdout: "" });
    const res = handleFilesUnstageRoute("/repo", ["nope.ts"], git.deps);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: false, reason: "git command failed" });
  });

  test("empty stderr still yields a non-empty reason", async () => {
    const git = fakeGit({ status: 128, stdout: "", stderr: "" });
    const body = (await handleFilesUnstageRoute("/repo", ["nope.ts"], git.deps).json()) as {
      ok: boolean;
      reason: string;
    };
    expect(body).toEqual({ ok: false, reason: "git command failed" });
  });
});

describe("validateGitPaths", () => {
  test("accepts valid lists unchanged, space-bearing paths included", () => {
    expect(validateGitPaths(["src/a b.ts"])).toEqual(["src/a b.ts"]);
    expect(validateGitPaths(PATHS)).toEqual(PATHS);
  });

  test("cap boundary: exactly STAGE_BUTTON_CAP accepted, one more rejected", () => {
    const atCap = Array.from({ length: STAGE_BUTTON_CAP }, (_, index) => `f${index}.ts`);
    expect(validateGitPaths(atCap)).toHaveLength(STAGE_BUTTON_CAP);
    expect(validateGitPaths([...atCap, "one-too-many.ts"])).toBeNull();
  });

  test("rejects every unsafe shape and malformed list", () => {
    const rejected: unknown[] = [
      ...["-A", "--pathspec-from-file=x", "../x", "/abs", "a\u0000b", ""].map((path) => [path]),
      [], // empty list
      "", // non-array
      "not-an-array",
      [1], // non-string member
      ["ok.ts", "../x"], // one bad path rejects the whole list
    ];
    for (const candidate of rejected) {
      expect(validateGitPaths(candidate), JSON.stringify(candidate)).toBeNull();
    }
  });

  test("the guard is the shared unsafeGitPath relocated to the dependency-free contract", () => {
    expect(unsafeGitPath("../x")).toBe(true);
    expect(unsafeGitPath("/abs")).toBe(true);
    expect(unsafeGitPath("src/a b.ts")).toBe(false);
  });
});

describe("handleFilesDiffRoute: exact argv, cap, binary + untracked passthrough", () => {
  interface DiffBody {
    ok: boolean;
    kind?: string;
    text?: string;
    truncated?: boolean;
    binary?: boolean;
    reason?: string;
  }
  const body = async (res: Response) => (await res.json()) as DiffBody;

  test("staged runs exactly `git diff --cached --no-color -- <path>`", async () => {
    const git = fakeGit({ status: 0, stdout: "diff --git a/src/a.ts b/src/a.ts\n" });
    const res = handleFilesDiffRoute("/repo", "src/a.ts", true, false, git.deps);
    expect(res.status).toBe(200);
    expect(git.calls).toHaveLength(1);
    expect(git.calls[0]?.args).toEqual(["diff", "--cached", "--no-color", "--", "src/a.ts"]);
    expect(git.calls[0]?.cwd).toBe("/repo");
    expect(await body(res)).toEqual({
      ok: true,
      kind: "diff",
      text: "diff --git a/src/a.ts b/src/a.ts\n",
      truncated: false,
      binary: false,
    });
  });

  test("unstaged runs exactly `git diff --no-color -- <path>`", async () => {
    const git = fakeGit({ status: 0, stdout: "+line\n" });
    const res = handleFilesDiffRoute("/repo", "docs/b c.md", false, false, git.deps);
    expect(git.calls[0]?.args).toEqual(["diff", "--no-color", "--", "docs/b c.md"]);
    expect(await body(res)).toEqual({
      ok: true,
      kind: "diff",
      text: "+line\n",
      truncated: false,
      binary: false,
    });
  });

  test("untracked flag short-circuits: no git run, kind untracked", async () => {
    const git = fakeGit({ status: 0, stdout: "never read" });
    const res = handleFilesDiffRoute("/repo", "new.ts", false, true, git.deps);
    expect(git.calls).toHaveLength(0);
    expect(await body(res)).toEqual({
      ok: true,
      kind: "untracked",
      text: "",
      truncated: false,
      binary: false,
    });
  });

  test("`Binary files` marker yields binary:true with empty text", async () => {
    const git = fakeGit({ status: 0, stdout: "Binary files a/logo.png and b/logo.png differ\n" });
    const res = handleFilesDiffRoute("/repo", "logo.png", false, false, git.deps);
    expect(await body(res)).toEqual({
      ok: true,
      kind: "diff",
      text: "",
      truncated: false,
      binary: true,
    });
  });

  test("truncation boundary: exactly DIFF_MAX_CHARS kept, one more sliced", async () => {
    const atCap = fakeGit({ status: 0, stdout: "x".repeat(DIFF_MAX_CHARS) });
    const exact = await body(handleFilesDiffRoute("/repo", "big.ts", false, false, atCap.deps));
    expect(exact.truncated).toBe(false);
    expect(exact.text).toHaveLength(DIFF_MAX_CHARS);

    const over = fakeGit({ status: 0, stdout: "x".repeat(DIFF_MAX_CHARS + 1) });
    const sliced = await body(handleFilesDiffRoute("/repo", "big.ts", false, false, over.deps));
    expect(sliced.truncated).toBe(true);
    expect(sliced.text).toHaveLength(DIFF_MAX_CHARS);
  });

  test("empty and whitespace-only stdout are kind empty", async () => {
    for (const stdout of ["", "\n"]) {
      const git = fakeGit({ status: 0, stdout });
      expect(await body(handleFilesDiffRoute("/repo", "src/a.ts", false, false, git.deps))).toEqual(
        {
          ok: true,
          kind: "empty",
          text: "",
          truncated: false,
          binary: false,
        },
      );
    }
  });

  test("non-zero status: 200, ok:false, first stderr line only", async () => {
    const git = fakeGit({
      status: 1,
      stdout: "",
      stderr: "fatal: bad revision\nsecond line never leaks",
    });
    const res = handleFilesDiffRoute("/repo", "src/a.ts", false, false, git.deps);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: false, reason: "fatal: bad revision" });
  });

  test("runner failure (status null) degrades to a stable reason", async () => {
    const git = fakeGit({ status: null, stdout: "" });
    const res = handleFilesDiffRoute("/repo", "src/a.ts", true, false, git.deps);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: false, reason: "git command failed" });
  });

  test("unsafe path: 400 invalid paths, git never runs", async () => {
    for (const path of ["-A", "--pathspec-from-file=x", "../x", "/abs", "a\u0000b", ""]) {
      const git = fakeGit({ status: 0, stdout: "nope" });
      const res = handleFilesDiffRoute("/repo", path, false, false, git.deps);
      expect(res.status, path).toBe(400);
      expect(git.calls).toHaveLength(0);
      expect(await res.json()).toEqual({ error: "invalid paths" });
    }
  });
});
