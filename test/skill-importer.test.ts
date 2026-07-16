import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSkillFromDir, importSkillsFromParent } from "../src/skills/importer";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("importSkillFromDir", () => {
  test("imports a single skill dir into .vibeflow/skills", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-import-"));
    dirs.push(repo);
    const src = mkdtempSync(join(tmpdir(), "vf-import-src-"));
    dirs.push(src);
    mkdirSync(join(src, "my-skill", "references"), { recursive: true });
    writeFileSync(
      join(src, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: Imported skill with references.\n---\n\n# My Skill\n\nImported test body that passes skill validation thresholds.\n",
    );
    writeFileSync(join(src, "my-skill", "references", "notes.md"), "domain notes");

    const catalogDir = join(repo, ".vibeflow", "skills");
    const result = importSkillFromDir(repo, join(src, "my-skill"), { catalogDir });
    expect(result.ok).toBe(true);
    expect(existsSync(join(catalogDir, "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(catalogDir, "my-skill", "references", "notes.md"))).toBe(true);
  });

  test("rejects invalid skill (placeholder body)", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-import-bad-"));
    dirs.push(repo);
    const src = mkdtempSync(join(tmpdir(), "vf-import-bad-src-"));
    dirs.push(src);
    mkdirSync(join(src, "bad"));
    writeFileSync(join(src, "bad", "SKILL.md"), "---\nname: bad\n---\n\nTODO\n");
    const result = importSkillFromDir(repo, join(src, "bad"));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("body"))).toBe(true);
    expect(existsSync(join(repo, ".vibeflow", "skills", "bad"))).toBe(false);
  });

  test("backs up an existing skill to .backup/<timestamp>/<name> before overwrite", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-import-backup-"));
    dirs.push(repo);
    const src1 = mkdtempSync(join(tmpdir(), "vf-import-backup-src1-"));
    const src2 = mkdtempSync(join(tmpdir(), "vf-import-backup-src2-"));
    dirs.push(src1, src2);
    // First import
    mkdirSync(join(src1, "my-skill"));
    writeFileSync(
      join(src1, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: First version of the skill body for import backup test.\n---\n\n# v1\n\nFirst version body text that is long enough to pass the placeholder check.\n",
    );
    const catalogDir = join(repo, ".vibeflow", "skills");
    const r1 = importSkillFromDir(repo, join(src1, "my-skill"), { catalogDir });
    expect(r1.ok).toBe(true);
    // Second import — should backup the first before overwriting
    mkdirSync(join(src2, "my-skill"));
    writeFileSync(
      join(src2, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: Second version of the skill body for import backup test.\n---\n\n# v2\n\nSecond version body text that is long enough to pass the placeholder check.\n",
    );
    const r2 = importSkillFromDir(repo, join(src2, "my-skill"), { catalogDir });
    expect(r2.ok).toBe(true);
    // Verify backup exists under .vibeflow/skills/.backup/<ts>/my-skill
    const backupRoot = join(catalogDir, ".backup");
    expect(existsSync(backupRoot)).toBe(true);
  });

  test("returns error when source SKILL.md is missing", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-import-nosrc-"));
    dirs.push(repo);
    const src = mkdtempSync(join(tmpdir(), "vf-import-nosrc-src-"));
    dirs.push(src);
    // Empty dir, no SKILL.md
    const result = importSkillFromDir(repo, src);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("missing SKILL.md");
  });
});

describe("importSkillsFromParent", () => {
  test("imports all child skills from a parent dir", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-import-multi-"));
    dirs.push(repo);
    const src = mkdtempSync(join(tmpdir(), "vf-import-multi-src-"));
    dirs.push(src);
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(src, name));
      const skillText = [
        "---",
        `name: ${name}`,
        `description: Test skill ${name} for parent import.`,
        "---",
        "",
        `# ${name}`,
        "",
        "Enough body content to pass skill validation thresholds.",
        "",
      ].join("\n");
      writeFileSync(join(src, name, "SKILL.md"), skillText);
    }
    const result = importSkillsFromParent(repo, src);
    expect(result.ok).toBe(true);
    expect(result.imported).toContain("alpha");
    expect(result.imported).toContain("beta");
  });
});
