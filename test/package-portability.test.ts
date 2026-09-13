import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  bin?: { vf?: string };
  scripts?: Record<string, string>;
};

describe("package portability", () => {
  test("uses a Node-native npm launcher instead of a POSIX shell bin", () => {
    expect(packageJson.bin?.vf).toBe("./bin/vf.mjs");
    const launcher = readFileSync(join(root, "bin", "vf.mjs"), "utf8");
    expect(launcher).not.toContain("#!/bin/sh");
    expect(launcher).toContain("node:child_process");
    expect(launcher).toContain("fileURLToPath");
  });

  test("built launcher runs through Node with argv preserved", () => {
    const node = Bun.which("node");
    if (!node) return;
    const result = execFileSync(node, [join(root, "bin", "vf.mjs"), "--version"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.trim()).toMatch(/^v?\d+\.\d+\.\d+$/);
  });

  test("build and coverage scripts do not depend on POSIX shell operators", () => {
    expect(packageJson.scripts?.build).toBe("node scripts/build.mjs");
    expect(packageJson.scripts?.["coverage:check"]).toBe("node scripts/coverage-check.mjs");
    expect(packageJson.scripts?.build).not.toMatch(/(?:&&|\brm\b|\bmkdir\b|\bcp\b|\bchmod\b)/);
    expect(packageJson.scripts?.["coverage:check"]).not.toMatch(
      /(?:&&|\brm\b|\bmkdir\b|\bcp\b|\bchmod\b)/,
    );
  });

  test("packed artifact contains Node launcher and built CLI", () => {
    const output = mkdtempSync(join(tmpdir(), "vf-package-portability-"));
    try {
      const npm = Bun.which("npm");
      if (!npm) throw new Error("npm is required for package smoke");
      const pack = execFileSync(npm, ["pack", "--pack-destination", output, "--json"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const metadata = JSON.parse(pack) as Array<{ filename?: string }>;
      const filename = metadata[0]?.filename;
      expect(filename).toBeString();
      if (!filename) return;
      const tarball = join(output, filename);
      const prefix = join(output, "prefix");
      execFileSync(npm, ["install", "--global", "--prefix", prefix, tarball, "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const npmRoot = execFileSync(npm, ["root", "--global", "--prefix", prefix], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const installedLauncher = join(npmRoot.trim(), "@magicpro97", "vibeflow", "bin", "vf.mjs");
      const version = execFileSync(process.execPath, [installedLauncher, "--version"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(version.trim()).toMatch(/^v?\d+\.\d+\.\d+$/);
      expect(
        readFileSync(
          join(npmRoot.trim(), "@magicpro97", "vibeflow", "scripts", "create-worktree.mjs"),
          "utf8",
        ),
      ).toContain("git worktree add");

      const repo = join(output, "repo with spaces");
      const worktree = join(output, "worktree with spaces");
      mkdirSync(join(repo, "node_modules"), { recursive: true });
      writeFileSync(join(repo, "README.md"), "base\n");
      for (const args of [
        ["init", "-b", "main"],
        ["config", "user.email", "vf-package-smoke@example.invalid"],
        ["config", "user.name", "vf-package-smoke"],
        ["add", "README.md"],
        ["commit", "-m", "base"],
      ]) {
        execFileSync("git", args, {
          cwd: repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
      execFileSync(
        process.execPath,
        [installedLauncher, "worktree", "create", "smoke", "--path", worktree],
        {
          cwd: repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      expect(existsSync(join(worktree, "README.md"))).toBe(true);
      expect(existsSync(join(worktree, "node_modules"))).toBe(true);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
