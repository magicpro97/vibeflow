import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import { analyzeSkillImpact, handleImpactSubcommand } from "../src/skills/impact.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-impact-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function skill(name: string, extra = ""): void {
  const dir = join(base, ".vibeflow", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\n\n## Steps\n`,
  );
}

function facts(raw: string): void {
  const dir = join(base, ".vibeflow");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "DOMAIN_FACTS.json"), raw);
}

function run(rest: string[]): number {
  const cwd = process.cwd();
  const oldHome = process.env.VF_SKILLS_HOME;
  process.env.VF_SKILLS_HOME = base;
  process.chdir(base);
  try {
    return skills("impact", rest);
  } finally {
    process.chdir(cwd);
    process.env.VF_SKILLS_HOME = oldHome;
  }
}

const FACTS = JSON.stringify({
  schemaVersion: 1,
  facts: [
    {
      key: "src/domain/ctc/",
      owner: "neomatch-ctc-convention",
      version: "1",
      statement: "CTC domain source files",
      dependents: ["ctc-child-1", "ctc-child-2", "ctc-child-3", "ctc-child-4"],
    },
  ],
});

function fixture(): void {
  facts(FACTS);
  skill("neomatch-ctc-convention");
  skill("ctc-child-1", "dependsOn:\n  - neomatch-ctc-convention\n");
  skill("ctc-child-2");
  skill("ctc-child-3");
  skill("ctc-child-4");
}

describe("analyzeSkillImpact", () => {
  test("exact fact lists owner and all children", () => {
    fixture();
    const result = analyzeSkillImpact(base, "src/domain/ctc/");
    expect(result.facts).toEqual(["src/domain/ctc/"]);
    expect(result.skills).toEqual([
      "ctc-child-1",
      "ctc-child-2",
      "ctc-child-3",
      "ctc-child-4",
      "neomatch-ctc-convention",
    ]);
  });

  test("path substring matches fact", () => {
    fixture();
    expect(analyzeSkillImpact(base, "src/domain/ctc").facts).toEqual(["src/domain/ctc/"]);
  });

  test("statement substring matches fact", () => {
    fixture();
    expect(analyzeSkillImpact(base, "source files").facts).toEqual(["src/domain/ctc/"]);
  });

  test("reports required eval command per affected skill", () => {
    fixture();
    expect(analyzeSkillImpact(base, "ctc").evalCommands).toContain(
      "vf skills eval neomatch-ctc-convention",
    );
  });

  test("adds skills whose owns overlap matching fact", () => {
    facts(FACTS);
    skill("neomatch-ctc-convention");
    skill("fact-owner", "owns:\n  - src/domain/ctc/\n");
    const result = analyzeSkillImpact(base, "ctc");
    expect(result.skills).toContain("fact-owner");
  });

  test("recursively adds skills depending on an affected owner", () => {
    facts(FACTS);
    skill("neomatch-ctc-convention");
    skill("dependent", "dependsOn:\n  - neomatch-ctc-convention\n");
    const result = analyzeSkillImpact(base, "ctc");
    expect(result.skills).toContain("dependent");
  });

  test("missing facts file returns empty result", () => {
    expect(analyzeSkillImpact(base, "anything")).toEqual({
      facts: [],
      skills: [],
      evalCommands: [],
    });
  });

  test("malformed facts file returns empty result", () => {
    facts("{");
    expect(analyzeSkillImpact(base, "anything")).toEqual({
      facts: [],
      skills: [],
      evalCommands: [],
    });
  });

  test("no fact match returns empty result", () => {
    fixture();
    expect(analyzeSkillImpact(base, "other")).toEqual({ facts: [], skills: [], evalCommands: [] });
  });
});

describe("vf skills impact", () => {
  test("missing query returns usage error", () => {
    expect(run([])).toBe(2);
  });

  test("no match returns success", () => {
    fixture();
    expect(run(["other"])).toBe(0);
  });

  test("matched path returns success", () => {
    fixture();
    expect(run(["src/domain/ctc/"])).toBe(0);
  });

  test("direct handler returns success", () => {
    fixture();
    expect(handleImpactSubcommand(base, ["ctc"])).toBe(0);
  });
});
