// size-waiver: #655 — scope test file, one file keeps coverage cohesive

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../src/frontmatter.js";
import { toSafeSkills } from "../src/skills/api-types.js";
import { checkPublishGate } from "../src/skills/publish-gate.js";
import { parseSkill } from "../src/skills/registry.js";
import { draftSkillTemplate, skillTemplate } from "../src/skills/templates.js";
import { validateSkillDir } from "../src/skills/validator.js";

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vf-scope-"));
  return d;
}

function writeSkill(dir: string, fm: string, body?: string): void {
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\n${fm}---\n\n${body ?? "# Body\n\nFollow these reusable, actionable instructions carefully for reliable outcomes.\n"}`,
  );
}

describe("frontmatter: scope parsing", () => {
  test("parses scope scalar", () => {
    const { data } = parseFrontmatter("---\nname: x\nscope: project\n---");
    expect(data.scope).toBe("project");
  });

  test("parses all valid scope values", () => {
    for (const s of ["common", "organization", "project", "adapter"]) {
      const { data } = parseFrontmatter(`---\nname: x\nscope: ${s}\n---`);
      expect(data.scope).toBe(s);
    }
  });

  test("parses project.id", () => {
    const { data } = parseFrontmatter(
      "---\nname: x\nproject.id: my-org/my-repo\nscope: project\n---",
    );
    expect(data["project.id"]).toBe("my-org/my-repo");
  });

  test("parses extends as inline list", () => {
    const { data } = parseFrontmatter("---\nname: x\nextends: [base-skill, common-test]\n---");
    expect(data.extends).toEqual(["base-skill", "common-test"]);
  });

  test("parses extends as block list", () => {
    const { data } = parseFrontmatter(
      "---\nname: x\nextends:\n  - base-skill\n  - common-test\n---",
    );
    expect(data.extends).toEqual(["base-skill", "common-test"]);
  });
});

describe("parseSkill: scope extraction", () => {
  test("extracts scope from frontmatter", () => {
    const d = tmpDir();
    writeSkill(d, "name: scope-test\ndescription: test\nscope: project\n");
    const s = parseSkill(join(d, "SKILL.md"), d);
    expect(s?.scope).toBe("project");
    rmSync(d, { recursive: true, force: true });
  });

  test("extracts project.id", () => {
    const d = tmpDir();
    writeSkill(
      d,
      "name: proj-skill\ndescription: test\nscope: project\nproject.id: my-org/my-repo\n",
    );
    const s = parseSkill(join(d, "SKILL.md"), d);
    expect(s?.projectId).toBe("my-org/my-repo");
    rmSync(d, { recursive: true, force: true });
  });

  test("extracts extends array", () => {
    const d = tmpDir();
    writeSkill(d, "name: ext-skill\ndescription: test\nextends: [base-a, base-b]\n");
    const s = parseSkill(join(d, "SKILL.md"), d);
    expect(s?.extends).toEqual(["base-a", "base-b"]);
    rmSync(d, { recursive: true, force: true });
  });

  test("invalid scope value is silently dropped (back-compat)", () => {
    const d = tmpDir();
    writeSkill(d, "name: bad-scope\ndescription: test\nscope: global\n");
    const s = parseSkill(join(d, "SKILL.md"), d);
    expect(s?.scope).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });

  test("absent scope is undefined (back-compat)", () => {
    const d = tmpDir();
    writeSkill(d, "name: no-scope\ndescription: test\n");
    const s = parseSkill(join(d, "SKILL.md"), d);
    expect(s?.scope).toBeUndefined();
    expect(s?.projectId).toBeUndefined();
    expect(s?.extends).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });
});

describe("validateSkillDir: scope validation", () => {
  test("accepts valid scope values", () => {
    for (const s of ["common", "organization", "project", "adapter"]) {
      const d = tmpDir();
      writeSkill(d, `name: v-${s}\ndescription: test\nscope: ${s}\n`);
      const r = validateSkillDir(d);
      expect(r.ok).toBe(true);
      expect(r.warnings.filter((w) => w.includes("frontmatter.scope"))).toEqual([]);
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("warns on invalid scope value", () => {
    const d = tmpDir();
    writeSkill(d, "name: bad-scope\ndescription: test\nscope: global\n");
    const r = validateSkillDir(d);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("scope"))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  test("warns on project.id without scope=project|adapter", () => {
    const d = tmpDir();
    writeSkill(d, "name: pid-warn\ndescription: test\nproject.id: my-org/repo\n");
    const r = validateSkillDir(d);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("project.id"))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  test("no warning for project.id with scope=project", () => {
    const d = tmpDir();
    writeSkill(d, "name: pid-ok\ndescription: test\nscope: project\nproject.id: my-org/repo\n");
    const r = validateSkillDir(d);
    expect(r.warnings.filter((w) => w.includes("project.id"))).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });

  test("warns on hardcoded path in common-scoped skill body", () => {
    const d = tmpDir();
    writeSkill(
      d,
      "name: hc-path\ndescription: test\nscope: common\n",
      "Check /Users/alice/code/project for config",
    );
    const r = validateSkillDir(d);
    expect(r.warnings.some((w) => w.includes("hardcoded"))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  test("no hardcoded-path warning for non-common scope", () => {
    const d = tmpDir();
    writeSkill(
      d,
      "name: no-warn\ndescription: test\nscope: project\n",
      "Check /Users/alice/code/project for config",
    );
    const r = validateSkillDir(d);
    expect(r.warnings.filter((w) => w.includes("hardcoded"))).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("checkPublishGate", () => {
  test("rejects project-scoped skill → common channel", () => {
    const d = tmpDir();
    writeSkill(d, "name: my-proj\ndescription: test\nscope: project\nproject.id: my-org/repo\n");
    const r = checkPublishGate(d, "common");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("cannot publish to common"))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  test("rejects adapter-scoped skill → common channel", () => {
    const d = tmpDir();
    writeSkill(d, "name: my-adapter\ndescription: test\nscope: adapter\n");
    const r = checkPublishGate(d, "common");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("cannot publish to common"))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  test("allows project-scoped skill → project channel", () => {
    const d = tmpDir();
    writeSkill(d, "name: my-proj\ndescription: test\nscope: project\nproject.id: my-org/repo\n");
    const r = checkPublishGate(d, "project");
    expect(r.ok).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  test("warns on organization-scoped skill → common channel", () => {
    const d = tmpDir();
    writeSkill(d, "name: org-skill\ndescription: test\nscope: organization\n");
    const r = checkPublishGate(d, "common");
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("organization"))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  test("blocks hardcoded path in common channel even without scope field", () => {
    const d = tmpDir();
    writeSkill(d, "name: path-leak\ndescription: test\n", "Uses /Users/foo/proj/config");
    const r = checkPublishGate(d, "common");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("hardcoded"))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  test("allows common-scoped skill on common channel (no path leak)", () => {
    const d = tmpDir();
    writeSkill(
      d,
      "name: clean\ndescription: test\nscope: common\n",
      "Reads xlsx files using the standard library.",
    );
    const r = checkPublishGate(d, "common");
    expect(r.ok).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  test("returns error for missing SKILL.md", () => {
    const d = tmpDir();
    const r = checkPublishGate(join(d, "nonexistent"), "common");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("missing SKILL.md"))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  test("returns error when SKILL.md cannot be read", () => {
    const d = tmpDir();
    writeSkill(d, "name: unreadable\ndescription: test\nscope: common\n");
    const r = checkPublishGate(d, "common", {
      readFileSync: () => {
        throw new Error("permission denied");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("cannot read SKILL.md"))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  test("exposes parsed scope in result", () => {
    const d = tmpDir();
    writeSkill(d, "name: expose\ndescription: test\nscope: adapter\n");
    const r = checkPublishGate(d, "adapter");
    expect(r.scope).toBe("adapter");
    rmSync(d, { recursive: true, force: true });
  });

  test("handles missing scope field gracefully (undefined scope)", () => {
    const d = tmpDir();
    writeSkill(d, "name: no-scope\ndescription: test\n", "Uses /Users/foo/proj/config");
    const r = checkPublishGate(d, "common");
    // No scope → no scope-based block for project/adapter gate, but
    // hardcoded path detection on body still catches it
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("hardcoded"))).toBe(true);
    expect(r.scope).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });
});

describe("skillTemplate with scope", () => {
  test("skillTemplate includes scope: common by default", () => {
    const t = skillTemplate("my-skill");
    expect(t).toContain("scope: common");
  });

  test("skillTemplate accepts custom scope", () => {
    const t = skillTemplate("my-skill", { scope: "project" });
    expect(t).toContain("scope: project");
  });

  test("draftSkillTemplate includes scope: common by default", () => {
    const t = draftSkillTemplate("my-draft");
    expect(t).toContain("scope: common");
  });

  test("draftSkillTemplate accepts custom scope", () => {
    const t = draftSkillTemplate("my-draft", { scope: "adapter" });
    expect(t).toContain("scope: adapter");
  });
});

describe("toSafeSkills with scope fields", () => {
  test("includes scope, projectId, extends in output", () => {
    const skills = [
      {
        name: "scoped",
        description: "test",
        status: "verified" as const,
        scope: "project" as const,
        projectId: "my-org/repo",
        extends: ["base"],
        dir: "/shared/scoped",
        path: "/shared/scoped/SKILL.md",
      },
    ];
    const safe = toSafeSkills(skills, "/shared");
    expect(safe[0]?.scope).toBe("project");
    expect(safe[0]?.projectId).toBe("my-org/repo");
    expect(safe[0]?.extends).toEqual(["base"]);
  });

  test("omits extends when empty", () => {
    const skills = [
      {
        name: "no-ext",
        description: "test",
        status: "verified" as const,
        dir: "/shared/no-ext",
        path: "/shared/no-ext/SKILL.md",
      },
    ];
    const safe = toSafeSkills(skills, "/shared");
    expect(safe[0]?.extends).toBeUndefined();
  });
});
