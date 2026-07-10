import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPrompt } from "../src/adapters/dispatch-prompt.js";
import { makeDispatcher } from "../src/commands.js";
import { CTX_DIR, type Skill, writeState } from "../src/core.js";
import { parseSkill, repoSkills, selectDispatchSkills } from "../src/skills/registry.js";
import { validateSkillDir } from "../src/skills/validator.js";

function writeSkill(root: string, name: string, frontmatter: string[]): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    ["---", ...frontmatter, "---", "", `# ${name}`, "", "Steps."].join("\n"),
  );
  return dir;
}

function skill(over: Partial<Skill>): Skill {
  return {
    name: "s",
    description: "d",
    status: "verified",
    dir: "/x",
    path: "/x/SKILL.md",
    ...over,
  };
}

describe("#543 parseSkill type field", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-543-parse-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  test("type: repo → repo", () => {
    const dir = writeSkill(root, "law", ["name: law", "description: project law", "type: repo"]);
    expect(parseSkill(join(dir, "SKILL.md"), dir)?.type).toBe("repo");
  });
  test("type: knowledge → knowledge", () => {
    const dir = writeSkill(root, "know", ["name: know", "description: gated", "type: knowledge"]);
    expect(parseSkill(join(dir, "SKILL.md"), dir)?.type).toBe("knowledge");
  });
  test("absent → undefined", () => {
    const dir = writeSkill(root, "plain", ["name: plain", "description: no type"]);
    expect(parseSkill(join(dir, "SKILL.md"), dir)?.type).toBeUndefined();
  });
  test("garbage string → undefined", () => {
    const dir = writeSkill(root, "garbage", ["name: garbage", "description: bad", 'type: "foo"']);
    expect(parseSkill(join(dir, "SKILL.md"), dir)?.type).toBeUndefined();
  });
  test("garbage number → undefined", () => {
    const dir = writeSkill(root, "numbertype", [
      "name: numbertype",
      "description: bad",
      "type: 123",
    ]);
    expect(parseSkill(join(dir, "SKILL.md"), dir)?.type).toBeUndefined();
  });
});

describe("#543 repoSkills()", () => {
  test("filters type===repo only", () => {
    const out = repoSkills([
      skill({ name: "a", type: "repo" }),
      skill({ name: "b", type: "knowledge" }),
      skill({ name: "c" }),
    ]);
    expect(out.map((s) => s.name)).toEqual(["a"]);
  });
  test("excludes deprecated repo skills", () => {
    const out = repoSkills([skill({ name: "a", type: "repo", status: "deprecated" })]);
    expect(out).toEqual([]);
  });
  test("sorts by STATUS_RANK descending", () => {
    const out = repoSkills([
      skill({ name: "low", type: "repo", status: "draft" }),
      skill({ name: "high", type: "repo", status: "verified" }),
    ]);
    expect(out.map((s) => s.name)).toEqual(["high", "low"]);
  });
  test("empty input → []", () => {
    expect(repoSkills([])).toEqual([]);
  });
});

describe("#543 selectDispatchSkills", () => {
  test("a repo skill with matching triggers does NOT count as a knowledge match", () => {
    // The repo skill declares a trigger that hits unitText, so matchSkillsForTask
    // returns it — but it must be excluded from matchedNames (always-on law, not a
    // knowledge match), else it would falsely suppress the knowledge-gap flag.
    const skills = [skill({ name: "law", type: "repo", status: "verified", triggers: ["widget"] })];
    const r = selectDispatchSkills(skills, "build the widget");
    expect(r.alwaysNames).toEqual(["law"]); // injected as project law
    expect(r.skillNames).toEqual(["law"]); // in the union
    expect(r.matchedNames).toEqual([]); // NOT a knowledge match → gap flag stays truthful
    expect(r.skillsRequired).toEqual(["law"]); // verified subset of the union
  });

  test("a knowledge skill with matching triggers is a knowledge match", () => {
    const skills = [
      skill({ name: "kb", type: "knowledge", status: "verified", triggers: ["widget"] }),
    ];
    const r = selectDispatchSkills(skills, "build the widget");
    expect(r.matchedNames).toEqual(["kb"]);
    expect(r.alwaysNames).toEqual([]);
  });
});

describe("#543 dispatchPrompt repo vs matched", () => {
  const ctx = { goal: "g", settings: {} } as never;
  test("renders Project law line when repoSkills present", () => {
    const out = dispatchPrompt("claude", ctx, [
      { name: "u1", spec: "x", skills: ["law", "xlsx"], repoSkills: ["law"] },
    ]);
    expect(out).toContain("Project law (always apply, every unit): law.");
    expect(out).toContain("Follow these verified skills before improvising: xlsx.");
  });
  test("back-compat: identical output when no repoSkills", () => {
    const withUndef = dispatchPrompt("claude", ctx, [{ name: "u1", spec: "x", skills: ["xlsx"] }]);
    expect(withUndef).not.toContain("Project law");
    expect(withUndef).toContain("Follow these verified skills before improvising: xlsx.");
  });
});

describe("#543 validator type checks", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-543-valid-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  test("type is a standard field (no non-standard warning)", () => {
    const dir = writeSkill(root, "ok", ["name: ok", "description: fine", "type: repo"]);
    const r = validateSkillDir(dir);
    expect(r.warnings.some((w) => w.includes("type") && w.includes("non-standard"))).toBe(false);
  });
  test("invalid type value emits warning", () => {
    const dir = writeSkill(root, "bad", ["name: bad", "description: fine", "type: nope"]);
    const r = validateSkillDir(dir);
    expect(r.warnings).toContain('frontmatter.type must be "repo" or "knowledge"');
  });
  test("valid type value → no type warning", () => {
    const dir = writeSkill(root, "good", ["name: good", "description: fine", "type: knowledge"]);
    const r = validateSkillDir(dir);
    expect(r.warnings).not.toContain('frontmatter.type must be "repo" or "knowledge"');
  });
});

describe("#543 dispatch injection (dry run)", () => {
  function setup(): string {
    const dir = mkdtempSync(join(tmpdir(), "vf-543-dispatch-"));
    const skillsRoot = join(dir, CTX_DIR, "skills");
    mkdirSync(skillsRoot, { recursive: true });
    // repo skill, no keyword match to the unit text
    writeSkill(skillsRoot, "project-law", [
      "name: project-law",
      "description: always on law",
      "status: verified",
      "type: repo",
    ]);
    // knowledge skill matched by keyword "xlsxthing"
    writeSkill(skillsRoot, "xlsxthing", [
      "name: xlsxthing",
      "description: gated skill",
      "status: verified",
      "triggers: [xlsxthing]",
    ]);
    // knowledge skill NOT matched
    writeSkill(skillsRoot, "nevermatch", [
      "name: nevermatch",
      "description: unmatched",
      "status: verified",
      "triggers: [zzzznomatch]",
    ]);
    writeState(dir, {
      task_id: "T1",
      goal: "do thing",
      success_criteria: [],
      work_units: [
        {
          name: "u1",
          status: "pending",
          confidence: 0,
          gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    });
    return dir;
  }

  test("repo skill injected without match; knowledge needs a match; dedup", async () => {
    const dir = setup();
    try {
      const dispatcher = makeDispatcher("claude", {} as never, dir, "dry", "feature");
      await dispatcher({
        name: "u1",
        spec: "please handle xlsxthing here",
        status: "pending",
        confidence: 0,
        gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      });
      const ctx = readFileSync(join(dir, CTX_DIR, "workunits", "u1", "CONTEXT.md"), "utf8");
      expect(ctx).toContain("project-law");
      expect(ctx).toContain("xlsxthing");
      expect(ctx).not.toContain("nevermatch");
      // dedup: project-law only appears in the "Project law" line, not duplicated as matched
      expect(ctx).toContain("Project law (always apply, every unit): project-law.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
