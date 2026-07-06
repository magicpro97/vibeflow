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

  test("does not warn on an extra top-level child directory (spec allows any dir)", () => {
    const dir = tmpSkill("extra-dir-skill");
    mkdirSync(join(dir, "random"));
    writeSkill(
      dir,
      "---\nname: extra-dir-skill\ndescription: Test skill with an extra child directory.\n---\n\n# Test\n\nEnough actionable content for this skill body to be valid.\n",
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(true);
    // Spec allows "any additional files or directories" — an extra dir is NOT flagged.
    expect(result.warnings.some((w) => w.includes("unsupported"))).toBe(false);
  });

  test("accepts an Anthropic-style skill with extra top-level dirs (agents/, eval-viewer/)", () => {
    const dir = tmpSkill("skill-creator");
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "agents", "analyzer.md"), "agent");
    mkdirSync(join(dir, "eval-viewer"));
    writeFileSync(join(dir, "eval-viewer", "viewer.html"), "<html></html>");
    writeSkill(
      dir,
      "---\nname: skill-creator\ndescription: Create and improve skills.\n---\n\n# Skill Creator\n\nActionable content that makes this skill body long enough to validate.\n",
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("agents"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("eval-viewer"))).toBe(false);
  });

  test("rejects name longer than 64 chars (spec MAX 64)", () => {
    const longName = "a".repeat(65);
    const dir = tmpSkill(longName);
    writeSkill(
      dir,
      `---\nname: ${longName}\ndescription: Name is one char over the spec limit.\n---\n\n# Long Name\n\nEnough actionable content for this skill body to be valid here.\n`,
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("64"))).toBe(true);
  });

  test("rejects description containing angle brackets", () => {
    const dir = tmpSkill("angle-desc");
    writeSkill(
      dir,
      "---\nname: angle-desc\ndescription: Use the <tag> element when parsing.\n---\n\n# Angle\n\nEnough actionable content for this skill body to be valid here.\n",
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("angle brackets"))).toBe(true);
  });

  test("rejects compatibility longer than 500 chars", () => {
    const dir = tmpSkill("long-compat");
    const longCompat = "x".repeat(501);
    writeSkill(
      dir,
      `---\nname: long-compat\ndescription: Compatibility field is over the spec limit.\ncompatibility: ${longCompat}\n---\n\n# Compat\n\nEnough actionable content for this skill body to be valid here.\n`,
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("compatibility"))).toBe(true);
  });

  test("accepts all six standard frontmatter fields without warning", () => {
    const dir = tmpSkill("full-frontmatter");
    writeSkill(
      dir,
      "---\nname: full-frontmatter\ndescription: A skill using every standard field.\nlicense: Apache-2.0\nallowed-tools: bash python\ncompatibility: node>=18\nmetadata:\n  author: example\n---\n\n# Full\n\nEnough actionable content for this skill body to be valid here.\n",
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("non-standard frontmatter key"))).toBe(false);
  });

  test("warns (not errors) on a non-standard frontmatter key", () => {
    const dir = tmpSkill("legacy-keys");
    writeSkill(
      dir,
      "---\nname: legacy-keys\ndescription: A skill carrying a legacy non-spec key.\nstatus: draft\n---\n\n# Legacy\n\nEnough actionable content for this skill body to be valid here.\n",
    );
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("non-standard frontmatter key: status"))).toBe(
      true,
    );
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
    const repo = mkdtempSync(join(tmpdir(), "vf-repo-empty-"));
    dirs.push(repo);
    const result = validateSkillRoots(repo);
    expect(result.ok).toBe(false);
    expect(result.skills).toHaveLength(0);
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

  test("returns cannot-read error when readFileSync throws (line 51-56)", () => {
    const dir = tmpSkill("broken-read");
    writeSkill(dir, "irrelevant");
    const inject = {
      readFileSync: () => {
        throw new Error("permission denied");
      },
    };
    const result = validateSkillDir(dir, inject);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("cannot read SKILL.md");
    expect(result.errors[0]).toContain("permission denied");
  });

  test("warns when readdirSync throws during dir inspection (line 125)", () => {
    const dir = tmpSkill("unreadable-dir");
    writeSkill(
      dir,
      "---\nname: unreadable-dir\ndescription: Test catch of dir-inspection error.\n---\n\n# Test\n\nEnough actionable content for this skill body.\n",
    );
    const inject = {
      readdirSync(path: string) {
        if (path.endsWith("unreadable-dir")) throw new Error("access denied");
        return require("node:fs").readdirSync(path);
      },
    };
    const result = validateSkillDir(dir, inject);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("could not inspect skill directory"))).toBe(true);
  });
});

describe("validateSkillDir: task-ID leak detection", () => {
  test("warns when body contains BR-1234 style requirement IDs", () => {
    const dir = tmpSkill("with-task-ids");
    writeSkill(
      dir,
      [
        "---",
        "name: plan-skill",
        "description: plans work",
        "---",
        "# Plan",
        "This skill fulfills BR-122 and FR-3456 requirements.",
        "It also handles AC-789.",
      ].join("\n"),
    );
    mkdirSync(join(dir, "references"), { recursive: true });
    const result = validateSkillDir(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("BR-122"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("task-specific content leak"))).toBe(true);
  });
});
