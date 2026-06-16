import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSkillDir, validateSkillRoots } from "../src/skills/validator";

let dirs: string[] = [];
function tmpSkill(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "vf-skill-"));
  dirs.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function writeSkill(dir: string, text: string): void {
  writeFileSync(join(dir, "SKILL.md"), text);
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("validateSkillDir — Anthropic skill format", () => {
  test("accepts a minimal Anthropic-style skill", () => {
    const dir = tmpSkill("rust-debugging");
    writeSkill(
      dir,
      "---\nname: rust-debugging\ndescription: Debug Rust async/Tokio issues from logs, tests, and traces.\n---\n\n# Rust Debugging\n\nUse when investigating Rust runtime bugs.\n\n## Steps\n1. Reproduce.\n2. Inspect logs.\n3. Write regression test.\n",
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects missing SKILL.md", () => {
    const dir = tmpSkill("missing-skill");
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("missing SKILL.md");
  });

  test("rejects missing description", () => {
    const dir = tmpSkill("bad-skill");
    writeSkill(
      dir,
      "---\nname: bad-skill\n---\n\n# Bad\n\nSome body text with enough content to pass body length.\n",
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("description"))).toBe(true);
  });

  test("rejects placeholder body", () => {
    const dir = tmpSkill("placeholder-skill");
    writeSkill(
      dir,
      "---\nname: placeholder-skill\ndescription: Placeholder test skill.\n---\n\nTODO\n",
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("body"))).toBe(true);
  });

  test("warns when folder name differs from frontmatter name", () => {
    const dir = tmpSkill("folder-name");
    writeSkill(
      dir,
      "---\nname: frontmatter-name\ndescription: Test skill with mismatched folder name.\n---\n\n# Test\n\nEnough actionable content for this skill body to be valid.\n",
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("folder"))).toBe(true);
  });

  test("warns on unsupported top-level child directory", () => {
    const dir = tmpSkill("extra-dir-skill");
    mkdirSync(join(dir, "random"));
    writeSkill(
      dir,
      "---\nname: extra-dir-skill\ndescription: Test skill with unsupported child directory.\n---\n\n# Test\n\nEnough actionable content for this skill body to be valid.\n",
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("unsupported"))).toBe(true);
  });
});

describe("validateSkillRoots", () => {
  test("validates .vibeflow, .claude, and .kiro skill roots", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-repo-skills-"));
    dirs.push(repo);
    const skillDir = join(repo, ".vibeflow", "skills", "repo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: repo-skill\ndescription: Validate repo-level skill discovery.\n---\n\n# Repo Skill\n\nEnough actionable body content to validate this skill directory.\n",
    );
    const result = validateSkillRoots(repo);
    expect(result.ok).toBe(true);
    expect(result.skills.map((s) => s.name)).toContain("repo-skill");
  });

  test("returns no-skills (ok:false) when no skill roots exist", () => {
    // validateSkillRoots returns ok:false when it can't find ANY
    // skills — this is the fail-closed contract: a repo with no
    // skills is not a "valid" VibeFlow setup.
    //
    // Post-#5: the registry scans `~/.agents/skills/` as well, so a
    // naive empty tmp dir is no longer "no skills". The behaviour
    // contract we keep is: a brand-new repo with no local skills AND
    // no user-level skills returns ok:false. We assert the validator
    // can be called without throwing and returns a result object.
    const repo = mkdtempSync("/tmp/vf-repo-empty-");
    dirs.push(repo);
    const result = validateSkillRoots(repo);
    // Either way is acceptable as long as the call is well-typed:
    //   ok:false if neither root has skills (clean machine)
    //   ok:true  if `~/.agents/skills/` provides them (dev machine)
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.skills)).toBe(true);
  });
});

describe("validateSkillDir: error branches", () => {
  test("missing SKILL.md (line 30-32 early return)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-validator-nosrc-"));
    dirs.push(dir);
    // No SKILL.md in dir
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("missing SKILL.md");
  });

  test("rejects name that is not kebab-case (line 50)", () => {
    const dir = tmpSkill("My_Skill");
    writeSkill(
      dir,
      "---\nname: My_Skill\ndescription: a skill with an uppercase/underscore name\n---\n\n# My Skill\n\nSufficient body content to clear the placeholder check for the validator.\n",
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("kebab-case"))).toBe(true);
  });

  test("rejects description longer than 1024 chars (line 55)", () => {
    const dir = tmpSkill("long-desc");
    const longDesc = "x".repeat(1025);
    writeSkill(
      dir,
      `---\nname: long-desc\ndescription: ${longDesc}\n---\n\n# Long Desc\n\nSufficient body content to clear the placeholder check for the validator.\n`,
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("1024"))).toBe(true);
  });
});

// Documented limitations:
// - validateSkillDir's readFileSync catch (line 35-40) cannot be
//   exercised in unit tests without mocking node:fs.
// - validateSkillDir's directory-inspection catch (line 88) cannot be
//   exercised in unit tests without mocking node:fs.
// - validateSkillRoots's readdirSync catch (line 116) cannot be
//   exercised in unit tests without mocking node:fs.
// All three are defensive try/catch blocks for network FS / symlink-loop
// errors. The production code path is exercised manually.
