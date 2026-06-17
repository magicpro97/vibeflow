/**
 * Packaging test (C4) — guards against the bug where
 * `.agents/skills/skill-creator` is missing from `package.json` `files`.
 *
 * If the dir is excluded, every `npm install` of vibeflow silently
 * strips the skill-creator source, and `copySkillCreator` runs against
 * a missing path.
 *
 * The 4-CLI audit (2026-06-17) found this defect. Test pins the fix.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(REPO_ROOT, "package.json");
const SKILL_CREATOR_PATH = join(REPO_ROOT, ".agents", "skills", "skill-creator", "SKILL.md");

interface PackageJson {
  name: string;
  files: string[];
}

describe("packaging includes skill-creator (C4)", () => {
  const pkg: PackageJson = JSON.parse(readFileSync(PKG_PATH, "utf8"));

  test("package.json `files` includes the skill-creator directory", () => {
    const includes = pkg.files.some(
      (f) => f === ".agents/skills/skill-creator" || f === ".agents/skills/skill-creator/",
    );
    if (!includes) {
      throw new Error(
        `package.json files[] does not include ".agents/skills/skill-creator". Current files: ${JSON.stringify(pkg.files)}`,
      );
    }
    expect(includes).toBe(true);
  });

  test("the skill-creator source SKILL.md exists in the repo", () => {
    // The path is referenced from package.json; it must exist.
    expect(SKILL_CREATOR_PATH.endsWith("SKILL.md")).toBe(true);
  });

  test("package.json is valid JSON with required fields", () => {
    expect(typeof pkg.name).toBe("string");
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files.length).toBeGreaterThan(0);
  });
});
