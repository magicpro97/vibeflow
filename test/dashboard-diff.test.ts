import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DiffFileEntry,
  type DiffRequest,
  type WorkUnitDiffResult,
  type WorkflowDiffSummary,
  buildDiffResponse,
  buildUnitDiff,
  buildWorkflowDiffSummary,
  resolveBaseline,
} from "../src/server/dashboard-diff.js";
import type { WorkflowDashboardItem } from "../src/server/dashboard.js";

function fakeGit(
  baseBaseline: string | null,
  numstat: string,
  nameStatus: string,
  porcelain: string,
  diff: string,
  headSha = "abc1234",
) {
  return (args: string[]): { status: number; stdout: string; stderr: string } => {
    const cmd = args.join(" ");
    if (cmd === "rev-parse --verify HEAD") {
      return baseBaseline
        ? { status: 0, stdout: `${headSha}\n`, stderr: "" }
        : { status: 128, stdout: "", stderr: "fatal: not a git repository" };
    }
    if (cmd.startsWith("log --oneline --grep=vibeflow WIP")) {
      return { status: 128, stdout: "", stderr: "" };
    }
    if (cmd.startsWith("stash list --grep=vibeflow WIP")) {
      return { status: 128, stdout: "", stderr: "" };
    }
    if (cmd.includes("--numstat")) return { status: 0, stdout: numstat, stderr: "" };
    if (cmd.includes("--name-status")) return { status: 0, stdout: nameStatus, stderr: "" };
    if (cmd.startsWith("status --porcelain")) return { status: 0, stdout: porcelain, stderr: "" };
    if (cmd.includes("diff")) return { status: 0, stdout: diff, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
}

const emptyItem = (overrides: Partial<WorkflowDashboardItem> = {}): WorkflowDashboardItem => ({
  key: "/repo\0TASK",
  repoPath: "/repo",
  repoName: "repo",
  taskId: "TASK",
  goal: "test",
  updatedAt: 100,
  workUnits: [
    {
      name: "u1",
      status: "pending",
      confidence: 0,
      gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      scope: ["src/"],
    },
    {
      name: "u2",
      status: "done",
      confidence: 1,
      gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      scope: ["tests/"],
    },
  ],
  totals: { units: 2, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  status: "pending",
  waves: [["u1"], ["u2"]],
  ...overrides,
});

describe("resolveBaseline with real git", () => {
  const tmpRepos: string[] = [];

  afterAll(() => {
    for (const d of tmpRepos) rmSync(d, { recursive: true, force: true });
  });

  test("default git arg works against real repo", () => {
    const dir = join(tmpdir(), `vf-diff-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    execSync("git init", { cwd: dir });
    execSync('git config user.email "test@test"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
    writeFileSync(join(dir, "a.ts"), "hello\n");
    execSync("git add -A && git commit -m init", { cwd: dir });
    tmpRepos.push(dir);
    const r = resolveBaseline(dir);
    expect(r.baseline).toBeTruthy();
    expect(r.label).toContain("HEAD");
  });
});

describe("resolveBaseline", () => {
  test("returns HEAD label when repo has commits and no WIP", () => {
    const g = (_a: string[]) => {
      const cmd = _a.join(" ");
      if (cmd === "rev-parse --verify HEAD") return { status: 0, stdout: "deadbeef\n", stderr: "" };
      if (cmd.startsWith("log --oneline --grep=vibeflow WIP"))
        return { status: 128, stdout: "", stderr: "" };
      if (cmd.startsWith("stash list --grep=vibeflow WIP"))
        return { status: 128, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = resolveBaseline("/repo", g);
    expect(r.baseline).toBe("deadbeef");
    expect(r.label).toContain("HEAD");
  });

  test("returns unborn when no HEAD", () => {
    const g = (_a: string[]) => ({ status: 128, stdout: "", stderr: "fatal" });
    const r = resolveBaseline("/repo", g);
    expect(r.baseline).toBeNull();
    expect(r.label).toBe("unborn repository");
  });

  test("returns WIP parent when WIP commit exists", () => {
    const g = (_a: string[]) => {
      const cmd = _a.join(" ");
      if (cmd === "rev-parse --verify HEAD") return { status: 0, stdout: "wip1234\n", stderr: "" };
      if (cmd.startsWith("log --oneline --grep=vibeflow WIP"))
        return { status: 0, stdout: "wip1234\n", stderr: "" };
      if (cmd.startsWith("rev-parse wip1234^"))
        return { status: 0, stdout: "base5678\n", stderr: "" };
      if (cmd.startsWith("stash list --grep=vibeflow WIP"))
        return { status: 128, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = resolveBaseline("/repo", g);
    expect(r.baseline).toBe("base5678");
    expect(r.label).toContain("checkpoint");
    expect(r.label).toContain("base5678");
  });

  test("falls back to WIP sha when parent rev-parse fails (orphan)", () => {
    const g = (_a: string[]) => {
      const cmd = _a.join(" ");
      if (cmd === "rev-parse --verify HEAD") return { status: 0, stdout: "wip1234\n", stderr: "" };
      if (cmd.startsWith("log --oneline --grep=vibeflow WIP"))
        return { status: 0, stdout: "wip1234\n", stderr: "" };
      if (cmd.startsWith("rev-parse wip1234^"))
        return { status: 128, stdout: "", stderr: "fatal: ambiguous" };
      if (cmd.startsWith("stash list --grep=vibeflow WIP"))
        return { status: 128, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = resolveBaseline("/repo", g);
    expect(r.baseline).toBe("wip1234");
    expect(r.label).toContain("checkpoint (WIP");
  });

  test("returns HEAD when WIP stash exists (stash fallback)", () => {
    const g = (_a: string[]) => {
      const cmd = _a.join(" ");
      if (cmd === "rev-parse --verify HEAD") return { status: 0, stdout: "dead0000\n", stderr: "" };
      if (cmd.startsWith("log --oneline --grep=vibeflow WIP"))
        return { status: 128, stdout: "", stderr: "" };
      if (cmd.startsWith("stash list --grep=vibeflow WIP"))
        return { status: 0, stdout: "stash1234\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = resolveBaseline("/repo", g);
    expect(r.baseline).toBe("dead0000");
    expect(r.label).toContain("HEAD");
  });
});

describe("buildWorkflowDiffSummary", () => {
  test("parses numstat and name-status correctly", () => {
    const g = fakeGit(
      "abc1234",
      "10\t2\tsrc/main.ts\n-\t-\timage.png\n",
      "M\tsrc/main.ts\nA\timage.png\n",
      "",
      "",
    );
    const r = buildWorkflowDiffSummary("/repo", g);
    expect(r.files).toHaveLength(2);
    expect(r.files[0]?.path).toBe("src/main.ts");
    expect(r.files[0]?.added).toBe(10);
    expect(r.files[0]?.deleted).toBe(2);
    expect(r.files[0]?.isBinary).toBe(false);
    expect(r.files[0]?.status).toBe("modified");
    expect(r.files[1]?.path).toBe("image.png");
    expect(r.files[1]?.isBinary).toBe(true);
    expect(r.files[1]?.status).toBe("added");
    expect(r.totalAdded).toBe(10);
    expect(r.totalDeleted).toBe(2);
  });

  test("parses untracked files from porcelain", () => {
    const g = fakeGit("abc1234", "", "", "?? new-file.ts\n?? build/output.js\n", "");
    const r = buildWorkflowDiffSummary("/repo", g);
    expect(r.untracked).toHaveLength(2);
    expect(r.untracked).toContain("new-file.ts");
    expect(r.untracked).toContain("build/output.js");
  });

  test("returns empty for unborn repo", () => {
    const g = (_a: string[]) => ({ status: 128, stdout: "", stderr: "" });
    const r = buildWorkflowDiffSummary("/repo", g);
    expect(r.baseline).toBeNull();
    expect(r.files).toHaveLength(0);
  });

  test("truncates to 500 entries and sets truncated flag when 501 numstat entries", () => {
    const lines501 = Array.from({ length: 501 }, (_, i) => `1\t1\tfile${i}.ts`).join("\n");
    const g = fakeGit("abc1234", lines501, lines501.replace(/\t\d+\t\d+\t/g, "\tM\t"), "", "");
    const r = buildWorkflowDiffSummary("/repo", g);
    expect(r.files).toHaveLength(500);
    expect(r.truncated).toBe(true);
    expect(r.totalAdded).toBe(501);
    expect(r.totalDeleted).toBe(501);
  });
});

describe("buildUnitDiff", () => {
  test("scope-filtered diff for unit with defined scope", () => {
    const g = fakeGit(
      "abc1234",
      "5\t1\tsrc/feature.ts\n",
      "M\tsrc/feature.ts\n",
      "",
      "diff --git a/src/feature.ts b/src/feature.ts\nindex abc..def 100644\n--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -1 +1 @@\n-old\n+new\n",
    );
    const r = buildUnitDiff("u1", ["src/"], "/repo", "abc1234", g);
    expect(r.hasDiff).toBe(true);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.path).toBe("src/feature.ts");
    expect(r.diff).toContain("diff --git");
  });

  test("no-diff when scope has no changes", () => {
    const g = fakeGit("abc1234", "", "", "", "");
    const r = buildUnitDiff("u1", ["unused/"], "/repo", "abc1234", g);
    expect(r.hasDiff).toBe(false);
    expect(r.reason).toBe("no-diff");
  });

  test("all-binary returns metadata only", () => {
    const g = fakeGit(
      "abc1234",
      "-\t-\timage.png\n",
      "A\timage.png\n",
      "",
      "diff --git a/image.png b/image.png\nnew file mode 100644\nindex 0000000..abc1234\nBinary files /dev/null and b/image.png differ\n",
    );
    const r = buildUnitDiff("u1", ["."], "/repo", "abc1234", g);
    expect(r.hasDiff).toBe(true);
    expect(r.reason).toBe("binary");
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.isBinary).toBe(true);
    expect(r.diff).toBe("");
  });

  test("no baseline returns reason no baseline", () => {
    const r = buildUnitDiff("u1", ["src/"], "/repo", null, () => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    expect(r.hasDiff).toBe(false);
    expect(r.reason).toBe("no baseline");
  });

  test("scope traversal rejected — returns error no-diff", () => {
    const g = fakeGit("abc1234", "1\t1\tetc/passwd\n", "M\tetc/passwd\n", "", "diff\n");
    const r = buildUnitDiff("u1", ["../etc/passwd"], "/repo", "abc1234", g);
    expect(r.hasDiff).toBe(false);
    expect(r.reason).toContain("invalid scope");
  });

  test("truncated when diff exceeds line cap (2000 lines)", () => {
    const manyLines = Array.from(
      { length: 2500 },
      (_, i) => `@@ -${i},1 +${i},1 @@\n line${i}`,
    ).join("\n");
    const g = fakeGit("abc1234", "2500\t0\tbig.ts\n", "A\tbig.ts\n", "", manyLines);
    const r = buildUnitDiff("u1", ["."], "/repo", "abc1234", g);
    expect(r.truncated).toBe(true);
    expect(r.diff.split("\n").length).toBeLessThanOrEqual(2000);
  });

  test("truncated when diff exceeds byte cap", () => {
    const largeDiff = "a".repeat(201 * 1024);
    const g = fakeGit("abc1234", "10000\t0\tbig.ts\n", "A\tbig.ts\n", "", largeDiff);
    const r = buildUnitDiff("u1", ["."], "/repo", "abc1234", g);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.diff, "utf8")).toBeLessThanOrEqual(200 * 1024);
  });
});

describe("parseNameStatusLine coverage", () => {
  test("handles renamed file (R status)", () => {
    const g = fakeGit("abc1234", "1\t1\tnew.ts\n", "R100\told.ts\tnew.ts\n", "", "");
    const r = buildWorkflowDiffSummary("/repo", g);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.path).toBe("new.ts");
    expect(r.files[0]?.status).toBe("renamed");
  });

  test("handles git diff empty — no files", () => {
    const g = fakeGit("abc1234", "", "", "", "");
    const r = buildWorkflowDiffSummary("/repo", g);
    expect(r.files).toHaveLength(0);
  });
});

describe("buildUnitDiff edge cases", () => {
  test("default git arg works (real repo)", () => {
    const dir = join(tmpdir(), `vf-diff-unit-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    execSync("git init", { cwd: dir });
    execSync('git config user.email "test@test"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
    writeFileSync(join(dir, "b.ts"), "original\n");
    execSync("git add -A && git commit -m init", { cwd: dir });
    writeFileSync(join(dir, "b.ts"), "modified\n");
    const r = buildUnitDiff("u1", ["."], dir, "HEAD");
    expect(r.hasDiff).toBe(true);
    expect(r.files.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("any invalid scope entry rejects entire diff", () => {
    const g = fakeGit("abc1234", "1\t1\tsrc/main.ts\n", "M\tsrc/main.ts\n", "", "diff content\n");
    const r = buildUnitDiff("u1", ["../etc/passwd", "src/"], "/repo", "abc1234", g);
    expect(r.hasDiff).toBe(false);
    expect(r.reason).toContain("invalid scope");
  });

  test("empty scope uses full repo", () => {
    const g = fakeGit("abc1234", "1\t1\tfile.ts\n", "M\tfile.ts\n", "", "diff text\n");
    const r = buildUnitDiff("u1", [], "/repo", "abc1234", g);
    expect(r.hasDiff).toBe(true);
    expect(r.files).toHaveLength(1);
  });

  test("multi-scope args produce single -- separator", () => {
    const calls: string[][] = [];
    const g = (args: string[]): { status: number; stdout: string; stderr: string } => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };
    buildUnitDiff("u1", ["src/", "lib/"], "/repo", "abc1234", g);
    const diffCall = calls.find((a) => a.includes("--numstat"));
    expect(diffCall).toBeDefined();
    if (!diffCall) return;
    const dashIdx = diffCall.lastIndexOf("--");
    expect(dashIdx).toBeGreaterThan(0);
    expect(diffCall.indexOf("--")).toBe(diffCall.lastIndexOf("--"));
    expect(diffCall.slice(dashIdx)).toEqual(["--", "src/", "lib/"]);
  });

  test("absolute path in scope rejected", () => {
    const g = fakeGit("abc1234", "1\t1\tfile.ts\n", "M\tfile.ts\n", "", "diff\n");
    const r = buildUnitDiff("u1", ["/etc/passwd"], "/repo", "abc1234", g);
    expect(r.hasDiff).toBe(false);
    expect(r.reason).toContain("invalid scope");
  });

  test("NUL byte in scope rejected", () => {
    const g = fakeGit("abc1234", "1\t1\tfile.ts\n", "M\tfile.ts\n", "", "diff\n");
    const r = buildUnitDiff("u1", ["bad\0file"], "/repo", "abc1234", g);
    expect(r.hasDiff).toBe(false);
    expect(r.reason).toContain("invalid scope");
  });

  test("all-invalid scope cannot fall through to full repo diff", () => {
    const g = fakeGit("abc1234", "9999\t0\tfull.ts\n", "A\tfull.ts\n", "", "full repo diff\n");
    const r = buildUnitDiff("u1", ["../escape", "/etc/passwd"], "/repo", "abc1234", g);
    expect(r.hasDiff).toBe(false);
    expect(r.reason).toContain("invalid scope");
  });

  test("byte cap preserves UTF-8 multi-byte characters", () => {
    const snowman = "\u2603";
    const multiByteChars = Array.from({ length: 100_000 }, () => snowman).join("");
    const g = fakeGit("abc1234", "10000\t0\tutf8.ts\n", "A\tutf8.ts\n", "", multiByteChars);
    const r = buildUnitDiff("u1", ["."], "/repo", "abc1234", g);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.diff, "utf8")).toBeLessThanOrEqual(200 * 1024);
    const reEncoded = Buffer.from(r.diff, "utf8").toString("utf8");
    expect(reEncoded).toBe(r.diff);
    expect(r.diff).not.toContain("\uFFFD");
  });

  test("byte cap handles 4-byte UTF-8 sequence boundary", () => {
    const emoji = "\u{1F600}";
    const multiByteChars = Array.from({ length: 100_000 }, () => emoji).join("");
    const g = fakeGit("abc1234", "100000\t0\temoji.ts\n", "A\temoji.ts\n", "", multiByteChars);
    const r = buildUnitDiff("u1", ["."], "/repo", "abc1234", g);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.diff, "utf8")).toBeLessThanOrEqual(200 * 1024);
    const reEncoded = Buffer.from(r.diff, "utf8").toString("utf8");
    expect(reEncoded).toBe(r.diff);
    expect(r.diff).not.toContain("\uFFFD");
  });
});

describe("buildDiffResponse", () => {
  test("returns diff for valid selection", () => {
    const items = [emptyItem()];
    const req: DiffRequest = { repoPath: "/repo", workflowId: "TASK", unit: "u1" };
    const g = fakeGit("abc1234", "1\t1\tfile.ts\n", "M\tfile.ts\n", "", "diff content\n");
    // Override buildWorkflowDiffSummary's internal git call by using a setup that returns valid data
    const result = buildDiffResponse(items, req);
    expect("summary" in result).toBe(true);
    if ("summary" in result) {
      expect(result.summary.files).toBeDefined();
      expect(result.unitDiff).toBeDefined();
    }
  });

  test("returns error for unknown repo", () => {
    const items: WorkflowDashboardItem[] = [];
    const req: DiffRequest = { repoPath: "/nonexistent", workflowId: "TASK" };
    const result = buildDiffResponse(items, req);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.status).toBe(400);
  });

  test("returns error for unknown workflow", () => {
    const items = [emptyItem()];
    const req: DiffRequest = { repoPath: "/repo", workflowId: "WRONG" };
    const result = buildDiffResponse(items, req);
    expect("error" in result).toBe(true);
  });

  test("returns error for unknown unit", () => {
    const items = [emptyItem()];
    const req: DiffRequest = { repoPath: "/repo", workflowId: "TASK", unit: "nonexistent" };
    const result = buildDiffResponse(items, req);
    expect("error" in result).toBe(true);
  });

  test("returns summary when no unit specified", () => {
    const items = [emptyItem()];
    const req: DiffRequest = { repoPath: "/repo", workflowId: "TASK" };
    const result = buildDiffResponse(items, req);
    expect("summary" in result).toBe(true);
    if ("summary" in result) {
      expect(result.unitDiff).toBeUndefined();
    }
  });
});
