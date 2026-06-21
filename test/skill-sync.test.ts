import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSkillMirrors, verifySkillSync } from "../src/skills/sync";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("syncSkillMirrors pointer mode (default)", () => {
  test("writes a small pointer SKILL.md to the default engine mirror (copilot)", () => {
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
    // Default is copilot only — must NOT touch .claude/ or .agents/ skill dirs.
    const pointer = readFileSync(
      join(repo, ".github", "skills", "project-fit-skill", "SKILL.md"),
      "utf8",
    );
    expect(pointer).toContain(".vibeflow/skills/project-fit-skill/SKILL.md");
    expect(
      existsSync(join(repo, ".github", "skills", "project-fit-skill", "references", "domain.md")),
    ).toBe(false);
    expect(existsSync(join(repo, ".claude", "skills", "project-fit-skill"))).toBe(false);
    expect(existsSync(join(repo, ".agents", "skills", "project-fit-skill"))).toBe(false);
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

  test("syncs only the specified engine mirrors when engines= is passed", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-engines-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "picked-engine-skill");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: picked-engine-skill\ndescription: Only one engine mirror.\n---\n\n# Picked\n\nActionable body content for validation. This is more than fifty characters long.\n",
    );
    const result = syncSkillMirrors(repo, {
      mode: "pointer",
      engines: ["claude"],
    });
    writeFileSync("/tmp/picked-debug.json", JSON.stringify(result, null, 2));
    expect(result.ok).toBe(true);
    // Only the claude mirror should exist; the others must be absent.
    expect(existsSync(join(repo, ".claude", "skills", "picked-engine-skill"))).toBe(true);
    expect(existsSync(join(repo, ".agents", "skills", "picked-engine-skill"))).toBe(false);
    expect(existsSync(join(repo, ".github", "skills", "picked-engine-skill"))).toBe(false);
  });

  test("ignores unknown engine names in the engines= array", () => {
    const repo = mkdtempSync(join(tmpdir(), "vf-skill-bad-engine-"));
    dirs.push(repo);
    const src = join(repo, ".vibeflow", "skills", "ok-skill");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: ok-skill\ndescription: An ok skill.\n---\n\n# Ok\n\nActionable body content for validation. This is more than fifty characters long so it passes the body check.\n",
    );
    const result = syncSkillMirrors(repo, {
      mode: "pointer",
      // Force a non-engine value to exercise the filter branch.
      engines: ["not-a-real-engine" as unknown as "claude"],
    });
    expect(result.ok).toBe(true);
    // Unknown engine filtered out → no mirrors written.
    expect(result.synced).toEqual([]);
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
    // Default is copilot mirror only
    expect(
      readFileSync(
        join(repo, ".github", "skills", "project-fit-skill", "references", "domain.md"),
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
});

// Documented limitation: skillNames's statSync catch (line 36-37) cannot
// be exercised in unit tests without mocking node:fs. The branch
// fires only on race conditions (file deleted between readdirSync and
// statSync) or symlink loops, neither of which we can reliably trigger.
