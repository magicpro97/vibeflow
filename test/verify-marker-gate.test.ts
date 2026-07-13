import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVerifyGate } from "../src/commands/hooks.js";
import { readLastVerify } from "../src/commands/tools-detect.js";

function freshGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-verifymarker-"));
  execSync("git init -q && git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", {
    cwd: dir,
    stdio: "ignore",
  });
  return dir;
}
function headSha(dir: string): string {
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
}
function writeMarker(dir: string, o: object): void {
  execSync("mkdir -p .vibeflow", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, ".vibeflow", "last-verify.json"), JSON.stringify(o));
}

describe("readLastVerify (#624 Task 3a)", () => {
  test("absent → null", () => {
    const dir = freshGitDir();
    try {
      expect(readLastVerify(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("valid marker → parsed", () => {
    const dir = freshGitDir();
    try {
      writeMarker(dir, { sha: "abc", passed: true, at: "2026-01-01T00:00:00Z" });
      expect(readLastVerify(dir)).toEqual({ sha: "abc", passed: true, at: "2026-01-01T00:00:00Z" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("garbage → null", () => {
    const dir = freshGitDir();
    try {
      writeMarker(dir, { sha: 1, passed: "yes" });
      expect(readLastVerify(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildVerifyGate (#624 Task 3)", () => {
  const stop = { event: "stop" as const };

  test("clean tree → null (nothing to verify)", () => {
    const dir = freshGitDir();
    try {
      expect(buildVerifyGate(dir)(stop)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dirty code + no marker → block reason", () => {
    const dir = freshGitDir();
    try {
      writeFileSync(join(dir, "app.ts"), "export const x = 1\n");
      const reason = buildVerifyGate(dir)(stop);
      expect(reason).toContain("vf verify");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dirty code + passing marker for current HEAD → null (allowed)", () => {
    const dir = freshGitDir();
    try {
      writeFileSync(join(dir, "app.ts"), "export const x = 1\n");
      writeMarker(dir, { sha: headSha(dir), passed: true, at: "now" });
      // marker file lives under .vibeflow/ which the gate ignores as code change,
      // and it matches HEAD → allowed.
      expect(buildVerifyGate(dir)(stop)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dirty code + marker for a DIFFERENT sha → block", () => {
    const dir = freshGitDir();
    try {
      writeFileSync(join(dir, "app.ts"), "export const x = 1\n");
      writeMarker(dir, { sha: "stale-sha", passed: true, at: "now" });
      expect(buildVerifyGate(dir)(stop)).toContain("vf verify");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dirty code + FAILED marker for HEAD → block", () => {
    const dir = freshGitDir();
    try {
      writeFileSync(join(dir, "app.ts"), "export const x = 1\n");
      writeMarker(dir, { sha: headSha(dir), passed: false, at: "now" });
      expect(buildVerifyGate(dir)(stop)).toContain("vf verify");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("only .vibeflow/ churn → null (not counted as code change)", () => {
    const dir = freshGitDir();
    try {
      writeMarker(dir, { sha: "x", passed: true, at: "now" });
      expect(buildVerifyGate(dir)(stop)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-git dir → null (fail open)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-nogit-"));
    try {
      writeFileSync(join(dir, "app.ts"), "x\n");
      expect(buildVerifyGate(dir)(stop)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spawn throws (invalid cwd with NUL) → null (fail open catch)", () => {
    // A NUL byte in the path makes spawnSync throw synchronously, exercising the
    // outer catch → fail-open branch.
    expect(buildVerifyGate("/no\0such")(stop)).toBeNull();
  });
});
