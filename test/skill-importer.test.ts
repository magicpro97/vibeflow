import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSkillFromDir, importSkillsFromParent } from "../src/skills/importer";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("importSkillFromDir - error paths", () => {
  test("rejects source dir missing SKILL.md", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-imp-err-"));
    dirs.push(repo);
    const src = mkdtempSync(join(tmpdir(), "vf-imp-src-"));
    dirs.push(src);
    mkdirSync(join(src, "no-skill"), { recursive: true });
    const r = importSkillFromDir(repo, join(src, "no-skill"));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("missing SKILL.md"))).toBe(true);
  });

  test("rejects source dir with invalid skill (validation fails)", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-imp-err-"));
    dirs.push(repo);
    const src = mkdtempSync(join(tmpdir(), "vf-imp-src-"));
    dirs.push(src);
    mkdirSync(join(src, "bad"), { recursive: true });
    writeFileSync(
      join(src, "bad", "SKILL.md"),
      "---\nname: Bad-Name\ndescription: x\n---\n\n# Body\n\nLong enough body to pass actionable instructions check.\n",
    );
    const r = importSkillFromDir(repo, join(src, "bad"));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("kebab-case"))).toBe(true);
  });

  test("warns when source dir has unsupported top-level children", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-imp-warn-"));
    dirs.push(repo);
    const src = mkdtempSync(join(tmpdir(), "vf-imp-src-"));
    dirs.push(src);
    mkdirSync(join(src, "weird-skill"), { recursive: true });
    writeFileSync(
      join(src, "weird-skill", "SKILL.md"),
      "---\nname: weird-skill\ndescription: A skill with unsupported child dir.\n---\n\n# Body\n\nLong enough body to pass actionable instructions check.\n",
    );
    writeFileSync(join(src, "weird-skill", "unsupported"), "x");
    const r = importSkillFromDir(repo, join(src, "weird-skill"));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("unsupported"))).toBe(true);
  });
});

describe("importSkillsFromParent - error paths", () => {
  test("rejects when source parent dir does not exist", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-imp-err-"));
    dirs.push(repo);
    const r = importSkillsFromParent(repo, "/nonexistent-parent-dir-xyz");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("not found"))).toBe(true);
  });

  test("imports multiple valid skills from a parent dir", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-imp-"));
    dirs.push(repo);
    const src = mkdtempSync(join(tmpdir(), "vf-imp-src-"));
    dirs.push(src);
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(src, name), { recursive: true });
      writeFileSync(
        join(src, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Skill ${name} body.\n---\n\n# ${name}\n\nLong enough body to pass actionable instructions check.\n`,
      );
    }
    const r = importSkillsFromParent(repo, src);
    expect(r.ok).toBe(true);
    expect(r.imported).toContain("alpha");
    expect(r.imported).toContain("beta");
  });
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

    const result = importSkillFromDir(repo, join(src, "my-skill"));
    expect(result.ok).toBe(true);
    expect(existsSync(join(repo, ".vibeflow", "skills", "my-skill", "SKILL.md"))).toBe(true);
    expect(
      existsSync(join(repo, ".vibeflow", "skills", "my-skill", "references", "notes.md")),
    ).toBe(true);
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

describe("importSkillFromDir - additional branches", () => {
  // Covers backupIfExists body (lines 36-41) by pre-creating the destination
  // so the backup path is taken when a second import happens at the same name.
  test("backs up an existing skill before overwriting", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-imp-bk-"));
    dirs.push(repo);
    const src = mkdtempSync(join(tmpdir(), "vf-imp-bk-src-"));
    dirs.push(src);
    mkdirSync(join(src, "my-skill"), { recursive: true });
    writeFileSync(
      join(src, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: Original version of the skill.\n---\n\n# My Skill\n\nOriginal body content that passes the actionable-instructions threshold.\n",
    );

    // First import — creates the destination.
    const first = importSkillFromDir(repo, join(src, "my-skill"));
    expect(first.ok).toBe(true);
    expect(existsSync(join(repo, ".vibeflow", "skills", "my-skill", "SKILL.md"))).toBe(true);

    // Overwrite source content so we can verify the swap actually happened.
    writeFileSync(
      join(src, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: Updated version of the skill.\n---\n\n# My Skill\n\nUpdated body content that passes the actionable-instructions threshold.\n",
    );

    // Second import — destination exists, so backupIfExists must run.
    const second = importSkillFromDir(repo, join(src, "my-skill"));
    expect(second.ok).toBe(true);
    // The backup directory should now contain a timestamped snapshot of the
    // original SKILL.md.
    const backupRoot = join(repo, ".vibeflow", "skills", ".backup");
    expect(existsSync(backupRoot)).toBe(true);
    const tsDirs = require("node:fs").readdirSync(backupRoot);
    expect(tsDirs.length).toBeGreaterThan(0);
    const backupContents = require("node:fs").readdirSync(join(backupRoot, tsDirs[0]));
    expect(backupContents).toContain("my-skill");
    // And the live copy should now reflect the updated source.
    const live = require("node:fs").readFileSync(
      join(repo, ".vibeflow", "skills", "my-skill", "SKILL.md"),
      "utf8",
    );
    expect(live).toContain("Updated version");
  });

  // Covers the catch in importSkillFromDir (line 73) by making
  // cpSync throw via a source child with no read permissions. The
  // validator passes (SKILL.md is readable), but the recursive copy
  // walks the whole tree and errors out on the locked sibling.
  test("returns error when source copy fails", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-imp-err2-"));
    dirs.push(repo);
    const src = mkdtempSync(join(tmpdir(), "vf-imp-err2-src-"));
    dirs.push(src);
    mkdirSync(join(src, "good-skill"), { recursive: true });
    writeFileSync(
      join(src, "good-skill", "SKILL.md"),
      "---\nname: good-skill\ndescription: Valid skill used to trip the cpSync path.\n---\n\n# Good\n\nLong enough body to pass skill validation thresholds for the actionable check.\n",
    );
    // Add a sibling that the recursive cpSync cannot read. The chmod
    // must be reverted in afterEach via the dirs cleanup, but to keep
    // rmSync happy we restore read perms before the test exits.
    const locked = join(src, "good-skill", "locked.txt");
    writeFileSync(locked, "x");
    chmodSync(locked, 0o000);
    try {
      const r = importSkillFromDir(repo, join(src, "good-skill"));
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBe(1);
      expect(typeof r.errors[0]).toBe("string");
    } finally {
      // Restore perms so rmSync can delete the temp dir in afterEach.
      chmodSync(locked, 0o644);
    }
  });
});

describe("importSkillsFromParent - additional branches", () => {
  // Covers the readdirSync catch (line 93) by passing a path that exists
  // (so the existsSync check at line 87 passes) but is a regular file, not
  // a directory — readdirSync then throws ENOTDIR.
  test("returns error when source parent is a file, not a directory", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-imp-pf-"));
    dirs.push(repo);
    const fileAsParent = join(repo, "not-a-dir");
    writeFileSync(fileAsParent, "i am a file");

    const r = importSkillsFromParent(repo, fileAsParent);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBe(1);
    expect(r.imported).toEqual([]);
  });

  // Covers the non-directory branch at line 100 (statSync(...).isDirectory()
  // returns false) and the result.ok=false branch at line 107 by mixing
  // a regular file and an invalid skill sibling alongside a valid one.
  test("skips non-directory entries and reports failed siblings", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-imp-mix-"));
    dirs.push(repo);
    const src = mkdtempSync(join(tmpdir(), "vf-imp-mix-src-"));
    dirs.push(src);

    // Valid skill — should be imported.
    mkdirSync(join(src, "good-skill"), { recursive: true });
    writeFileSync(
      join(src, "good-skill", "SKILL.md"),
      "---\nname: good-skill\ndescription: A perfectly valid skill for the parent import test.\n---\n\n# Good\n\nLong enough body content to pass skill validation thresholds for sure.\n",
    );

    // Invalid skill — fails validation, exercises the result.ok=false
    // branch at line 107.
    mkdirSync(join(src, "bad-skill"), { recursive: true });
    writeFileSync(
      join(src, "bad-skill", "SKILL.md"),
      "---\nname: bad-skill\n---\n\nTODO\n",
    );

    // Regular file at top level — exercises the !isDirectory() branch
    // at line 100 (continue).
    writeFileSync(join(src, "stray-file.txt"), "i am not a directory");

    const r = importSkillsFromParent(repo, src);
    expect(r.imported).toContain("good-skill");
    expect(r.imported).not.toContain("bad-skill");
    expect(r.imported).not.toContain("stray-file.txt");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.ok).toBe(false);
  });

  // Covers the statSync catch (line 102) by placing a broken symlink in
  // the parent dir — statSync on a dangling symlink throws.
  test("skips entries whose statSync throws (broken symlink)", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-imp-sym-"));
    dirs.push(repo);
    const src = mkdtempSync(join(tmpdir(), "vf-imp-sym-src-"));
    dirs.push(src);

    // Valid skill so we have a positive control.
    mkdirSync(join(src, "good-skill"), { recursive: true });
    writeFileSync(
      join(src, "good-skill", "SKILL.md"),
      "---\nname: good-skill\ndescription: A valid skill alongside a broken symlink sibling.\n---\n\n# Good\n\nLong enough body content to pass skill validation thresholds for sure.\n",
    );

    // Broken symlink: link target is created and then deleted, leaving a
    // dangling symlink. statSync on a dangling symlink throws.
    const linkPath = join(src, "dangling-link");
    const linkTarget = join(src, "does-not-exist-target");
    writeFileSync(linkTarget, "x");
    symlinkSync(linkTarget, linkPath);
    unlinkSync(linkTarget);

    const r = importSkillsFromParent(repo, src);
    expect(r.imported).toContain("good-skill");
    expect(r.imported).not.toContain("dangling-link");
    // No error from the dangling symlink itself — the catch at line 102
    // swallows it via `continue`. Validation errors on bad siblings would
    // still surface, but we have none here.
    expect(r.ok).toBe(true);
  });
});
