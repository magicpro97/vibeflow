import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePortableProjectIdentityTracked } from "../../src/commands/init.js";

function gitStatus(cwd: string, args: string[]): number {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

describe("project Capability Fabric identity tracking", () => {
  test("upgrades an existing broad context ignore without clobbering it", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-project-identity-tracking-"));
    try {
      const context = join(root, ".vibeflow");
      mkdirSync(context, { recursive: true });
      const ignorePath = join(context, ".gitignore");
      const original = "# user policy\n*\n!.gitignore\n!SETTINGS.json\n";
      writeFileSync(ignorePath, original);
      writeFileSync(join(context, "PROJECT_ID.json"), "{}\n");
      expect(gitStatus(root, ["init", "-q"])).toBe(0);
      expect(gitStatus(root, ["check-ignore", "-q", ".vibeflow/PROJECT_ID.json"])).toBe(0);

      ensurePortableProjectIdentityTracked(root);
      ensurePortableProjectIdentityTracked(root);

      const upgraded = readFileSync(ignorePath, "utf8");
      expect(upgraded.startsWith(original)).toBe(true);
      expect(upgraded.match(/^!PROJECT_ID\.json$/gmu)).toHaveLength(1);
      expect(gitStatus(root, ["check-ignore", "-q", ".vibeflow/PROJECT_ID.json"])).toBe(1);
      expect(
        execFileSync("git", ["status", "--short", "--untracked-files=all"], {
          cwd: root,
          encoding: "utf8",
        }),
      ).toContain(".vibeflow/PROJECT_ID.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("creates a minimal policy when the context ignore is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-project-identity-create-"));
    try {
      ensurePortableProjectIdentityTracked(root);
      expect(readFileSync(join(root, ".vibeflow", ".gitignore"), "utf8")).toBe(
        "# Portable Capability Fabric authority identity.\n!PROJECT_ID.json\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
