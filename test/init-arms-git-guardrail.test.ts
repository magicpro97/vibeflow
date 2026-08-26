import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIntake } from "../src/commands/init-apply.js";

function freshGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-gitguard-"));
  execSync("git init -q && git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", {
    cwd: dir,
    stdio: "ignore",
  });
  return dir;
}

function gitHooksPath(dir: string): string {
  const r = execSync("git config --get core.hooksPath", { cwd: dir, encoding: "utf8" });
  return r.trim();
}

describe("init arms git guardrail (Task 2 #624)", () => {
  test("fresh temp git repo → applyIntake → .githooks/pre-commit + pre-push exist + hooksPath set", async () => {
    const dir = freshGitDir();
    try {
      await applyIntake({ engines: ["claude"] }, { useAi: false, base: dir });
      expect(existsSync(join(dir, ".githooks", "pre-commit"))).toBe(true);
      expect(existsSync(join(dir, ".githooks", "pre-push"))).toBe(true);
      expect(gitHooksPath(dir)).toBe(".githooks");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("existing .githooks/pre-commit with sentinel → applyIntake → file UNCHANGED (non-clobber)", async () => {
    const dir = freshGitDir();
    const sentinel = "# vibeflow sentinel — do not clobber";
    try {
      const hooksDir = join(dir, ".githooks");
      execSync("mkdir -p .githooks", { cwd: dir, stdio: "ignore" });
      writeFileSync(join(dir, ".githooks", "pre-commit"), sentinel);
      await applyIntake({ engines: ["claude"] }, { useAi: false, base: dir });
      const content = readFileSync(join(dir, ".githooks", "pre-commit"), "utf8");
      expect(content).toBe(sentinel);
      expect(existsSync(join(dir, ".githooks", "pre-push"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("existing user .githooks/pre-push → applyIntake → file UNCHANGED (non-clobber, #748)", async () => {
    const dir = freshGitDir();
    const sentinel = "#!/bin/sh\n# my custom pre-push\nexit 0\n";
    try {
      execSync("mkdir -p .githooks", { cwd: dir, stdio: "ignore" });
      writeFileSync(join(dir, ".githooks", "pre-push"), sentinel);
      await applyIntake({ engines: ["claude"] }, { useAi: false, base: dir });
      expect(readFileSync(join(dir, ".githooks", "pre-push"), "utf8")).toBe(sentinel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("NON-git dir → applyIntake → no .githooks/ created", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-nongit-"));
    try {
      await applyIntake({ engines: ["claude"] }, { useAi: false, base: dir });
      expect(existsSync(join(dir, ".githooks"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dry:true → no .githooks/ written", async () => {
    const dir = freshGitDir();
    try {
      await applyIntake({ engines: ["claude"] }, { useAi: false, base: dir, dry: true });
      expect(existsSync(join(dir, ".githooks"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
