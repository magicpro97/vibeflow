import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSkillMirrors, verifySkillSync } from "../src/skills/sync";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("syncSkillMirrors pointer mode (default)", () => {
  test("writes a small pointer SKILL.md to every engine mirror", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "project-fit-skill");
    mkdirSync(join(src, "references"), { recursive: true });
    mkdirSync(join(src, "scripts"), { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: project-fit-skill\ndescription: Project-specific workflow skill.\n---\n\n# Project Fit\n\nUse this skill for project-specific workflow guidance.\n",
    );
    writeFileSync(join(src, "references", "domain.md"), "domain notes");
    writeFileSync(join(src, "scripts", "helper.js"), "console.log('ok')\n");

    const result = syncSkillMirrors(repo, { mode: "pointer" });
    expect(result.ok).toBe(true);
    for (const root of [".claude/skills", ".agents/skills", ".github/skills"]) {
      const pointer = readFileSync(join(repo, root, "project-fit-skill", "SKILL.md"), "utf8");
      expect(pointer).toContain(".vibeflow/skills/project-fit-skill/SKILL.md");
      // Pointer mode must NOT copy references/scripts
      expect(existsSync(join(repo, root, "project-fit-skill", "references", "domain.md"))).toBe(
        false,
      );
    }
  });

  test("does not write mirrors if canonical skill fails validation", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-invalid-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "bad-skill");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "---\nname: bad-skill\n---\n\nTODO\n");

    const result = syncSkillMirrors(repo, { mode: "pointer" });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(existsSync(join(repo, ".claude", "skills", "bad-skill"))).toBe(false);
  });
});

describe("syncSkillMirrors full mode", () => {
  test("copies the entire skill directory including references and scripts", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-full-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "project-fit-skill");
    mkdirSync(join(src, "references"), { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: project-fit-skill\ndescription: Project-specific workflow skill.\n---\n\n# Project Fit\n\nUse this skill for project-specific workflow guidance.\n",
    );
    writeFileSync(join(src, "references", "domain.md"), "domain notes");
    const result = syncSkillMirrors(repo, { mode: "full" });
    expect(result.ok).toBe(true);
    expect(
      readFileSync(
        join(repo, ".claude", "skills", "project-fit-skill", "references", "domain.md"),
        "utf8",
      ),
    ).toBe("domain notes");
  });
});

describe("verifySkillSync", () => {
  test("reports missing mirrors per engine", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-missing-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "missing-mirror");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: missing-mirror\ndescription: Missing mirror test skill.\n---\n\n# Missing Mirror\n\nEnough actionable body content for validation.\n",
    );
    const result = verifySkillSync(repo);
    expect(result.ok).toBe(false);
    // Mirror paths are joined with the platform separator; just check the
    // trailing segment to be cross-platform safe.
    expect(result.errors.join("\n")).toMatch(/missing-mirror[\\/]SKILL\.md missing/);
  });

  test("reports ok when all mirrors are present", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-sync-ok-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "all-good");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: all-good\ndescription: All good mirror test skill.\n---\n\n# All Good\n\nEnough actionable body content for validation.\n",
    );
    syncSkillMirrors(repo, { mode: "pointer" });
    const result = verifySkillSync(repo);
    expect(result.ok).toBe(true);
  });

  test("broken symlink under .vibeflow/skills is silently skipped (statSync catch)", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-symlink-"));
    dirs.push(repo);
    const skillsRoot = join(repo, ".vibeflow", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    // A valid skill
    const good = join(skillsRoot, "good-skill");
    mkdirSync(good);
    writeFileSync(
      join(good, "SKILL.md"),
      "---\nname: good-skill\ndescription: Valid skill.\n---\n\n# Good\n\nLong enough body to pass actionable instructions check.\n",
    );
    // A broken symlink: symlink target doesn't exist. statSync will throw
    // ENOENT, caught by the filter in skillNames.
    try {
      symlinkSync("/nonexistent-target-xyzzy", join(skillsRoot, "broken-symlink"));
    } catch {
      // Some FS may not support symlinks; skip the test in that case.
      return;
    }
    // Should not throw, should sync the good skill, skip the broken symlink.
    const r = syncSkillMirrors(repo, { mode: "pointer" });
    expect(r.ok).toBe(true);
  });
});
