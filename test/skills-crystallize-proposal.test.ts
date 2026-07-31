// test/skills-crystallize-proposal.test.ts
//
// #664: proposeCrystallizeUpdate — conservative pattern matching against
// existing skills. When patterns match a known skill by name, domain.id,
// or owned fact, emit a patch proposal (stdout only, no draft file).
// When no match, fall through to existing draft behavior.

import { describe, expect, test } from "bun:test";
import type { Skill } from "../src/core/types.js";
import {
  type CrystallizedPattern,
  buildProposal,
  proposeCrystallizeUpdate,
} from "../src/skills/crystallize.js";

function makeSkill(over: Partial<Skill> & { name: string }): Skill {
  return {
    description: `desc for ${over.name}`,
    status: "verified",
    dir: `/skills/${over.name}`,
    path: `/skills/${over.name}/SKILL.md`,
    ...over,
  };
}

const stubPatterns: CrystallizedPattern[] = [
  { kind: "command", value: "vf verify", count: 5 },
  { kind: "skill", value: "test-runner", count: 3 },
];

describe("proposeCrystallizeUpdate", () => {
  test("patterns match skill by name → proposal with diff and affected files", () => {
    const skills = [makeSkill({ name: "vf verify" })];
    const result = proposeCrystallizeUpdate("/repo", stubPatterns, "run-1", {
      discoverSkills: () => skills,
    });
    expect(result.hasProposal).toBe(true);
    expect(result.proposal).toBeDefined();
    expect(result.proposal?.targetSkill).toBe("vf verify");
    expect(result.proposal?.diff).toContain("Crystallized patterns");
    expect(result.proposal?.diff).toContain("--- a/");
    expect(result.proposal?.diff).toContain("+++ b/");
    expect(result.proposal?.affectedFiles).toEqual(["/skills/vf verify/SKILL.md"]);
    expect(result.proposal?.evalCommands).toContain("vf skills eval vf verify");
  });

  test("patterns match skill by domain.id", () => {
    const skills = [makeSkill({ name: "rust-linter", domain: { id: "rust", role: "canonical" } })];
    const pats: CrystallizedPattern[] = [{ kind: "command", value: "rust", count: 5 }];
    const result = proposeCrystallizeUpdate("/repo", pats, "run-2", {
      discoverSkills: () => skills,
    });
    expect(result.hasProposal).toBe(true);
    expect(result.proposal?.targetSkill).toBe("rust-linter");
  });

  test("patterns match skill by owned fact key", () => {
    const skills = [makeSkill({ name: "db-migrator", owns: ["migrate-db"] })];
    const pats: CrystallizedPattern[] = [{ kind: "command", value: "migrate-db", count: 5 }];
    const result = proposeCrystallizeUpdate("/repo", pats, "run-3", {
      discoverSkills: () => skills,
    });
    expect(result.hasProposal).toBe(true);
    expect(result.proposal?.targetSkill).toBe("db-migrator");
  });

  test("no patterns (empty array) → no-proposal, no error", () => {
    const result = proposeCrystallizeUpdate("/repo", [], "run-4", {
      discoverSkills: () => [makeSkill({ name: "anything" })],
    });
    expect(result.hasProposal).toBe(false);
    expect(result.reason).toBe("no-proposal");
  });

  test("no skills discovered → no-skills reason", () => {
    const result = proposeCrystallizeUpdate("/repo", stubPatterns, "run-5", {
      discoverSkills: () => [],
    });
    expect(result.hasProposal).toBe(false);
    expect(result.reason).toBe("no-skills");
  });

  test("patterns don't match any skill → no-match reason", () => {
    const skills = [makeSkill({ name: "java-compiler" })];
    const pats: CrystallizedPattern[] = [{ kind: "command", value: "bun test", count: 5 }];
    const result = proposeCrystallizeUpdate("/repo", pats, "run-6", {
      discoverSkills: () => skills,
    });
    expect(result.hasProposal).toBe(false);
    expect(result.reason).toBe("no-match");
  });

  test("generic terms (bun test, ls, git status) never match", () => {
    const skills = [makeSkill({ name: "bun test" })];
    // Even though there's a skill named "bun test", generic terms are
    // rejected at the matchPatternToSkill level.
    const pats: CrystallizedPattern[] = [{ kind: "command", value: "bun test", count: 10 }];
    const result = proposeCrystallizeUpdate("/repo", pats, "run-7", {
      discoverSkills: () => skills,
    });
    expect(result.hasProposal).toBe(false);
    expect(result.reason).toBe("no-match");
  });

  test("failure patterns alone never match (no proposal)", () => {
    const skills = [makeSkill({ name: "error-handler" })];
    const pats: CrystallizedPattern[] = [
      { kind: "failure", value: "connection timeout", count: 3 },
    ];
    const result = proposeCrystallizeUpdate("/repo", pats, "run-8", {
      discoverSkills: () => skills,
    });
    expect(result.hasProposal).toBe(false);
  });

  test("generic failure patterns (command not found) never match", () => {
    const pats: CrystallizedPattern[] = [
      { kind: "failure", value: "command not found: bun", count: 3 },
    ];
    const result = proposeCrystallizeUpdate("/repo", pats, "run-9", {
      discoverSkills: () => [makeSkill({ name: "error-handler" })],
    });
    expect(result.hasProposal).toBe(false);
  });

  test("proposal includes diff containing all pattern kinds", () => {
    const skills = [makeSkill({ name: "full-stack" })];
    const pats: CrystallizedPattern[] = [
      { kind: "command", value: "full-stack", count: 4 },
      { kind: "skill", value: "react-dev", count: 6 },
      { kind: "failure", value: "out of memory in heap", count: 2 },
    ];
    const result = proposeCrystallizeUpdate("/repo", pats, "run-10", {
      discoverSkills: () => skills,
    });
    expect(result.hasProposal).toBe(true);
    expect(result.proposal?.diff).toContain("Repeated commands");
    expect(result.proposal?.diff).toContain("Skills referenced");
    expect(result.proposal?.diff).toContain("Failure modes observed");
  });
});

describe("buildProposal", () => {
  test("includes target skill, diff, affected files, eval commands", () => {
    const skill = makeSkill({ name: "my-skill" });
    const pats: CrystallizedPattern[] = [{ kind: "command", value: "my-skill", count: 3 }];
    const p = buildProposal(skill, pats, "r1");
    expect(p.targetSkill).toBe("my-skill");
    expect(p.diff).toContain("--- a/");
    expect(p.diff).toContain("+++ b/");
    expect(p.affectedFiles).toEqual(["/skills/my-skill/SKILL.md"]);
    expect(p.evalCommands).toEqual(["vf skills eval my-skill"]);
    expect(p.matchedPatterns).toEqual(pats);
  });

  test("diff contains the pattern content", () => {
    const skill = makeSkill({ name: "data-pipeline" });
    const pats: CrystallizedPattern[] = [{ kind: "command", value: "data-pipeline run", count: 4 }];
    const p = buildProposal(skill, pats, "r2");
    expect(p.diff).toContain("Crystallized patterns");
    expect(p.diff).toContain("data-pipeline run");
  });

  test("deterministic ordering: same input → same output", () => {
    const skill = makeSkill({ name: "stable" });
    const pats: CrystallizedPattern[] = [{ kind: "command", value: "stable", count: 3 }];
    const a = buildProposal(skill, pats, "r3");
    const b = buildProposal(skill, pats, "r3");
    expect(a.diff).toBe(b.diff);
    expect(a.targetSkill).toBe(b.targetSkill);
    expect(a.evalCommands).toEqual(b.evalCommands);
  });
});

describe("proposeCrystallizeUpdate — deterministic ordering", () => {
  test("same patterns, same skills, same repo → same result", () => {
    const skills = [makeSkill({ name: "alpha" })];
    const pats: CrystallizedPattern[] = [{ kind: "command", value: "alpha", count: 3 }];
    const a = proposeCrystallizeUpdate("/x", pats, "r1", { discoverSkills: () => skills });
    const b = proposeCrystallizeUpdate("/x", pats, "r1", { discoverSkills: () => skills });
    expect(a.hasProposal).toBe(b.hasProposal);
    expect(a.proposal?.diff).toBe(b.proposal?.diff);
  });
});

describe("proposeCrystallizeUpdate — no source write (safety)", () => {
  test("never modifies skills, never creates files (pure function)", () => {
    const skills = [makeSkill({ name: "immutable" })];
    const origLen = skills.length;
    const origName = skills[0]?.name;
    const pats: CrystallizedPattern[] = [{ kind: "command", value: "immutable", count: 3 }];
    const result = proposeCrystallizeUpdate("/repo", pats, "run-safe", {
      discoverSkills: () => skills,
    });
    // Skills array unchanged
    expect(skills.length).toBe(origLen);
    expect(skills[0]?.name).toBe(origName);
    // Result is a value, not a file write
    expect(result.hasProposal).toBe(true);
    expect(result.proposal?.diff.length).toBeGreaterThan(0);
  });
});

describe("matchPatternToSkill — malformed/missing input safety", () => {
  test("empty string value never matches", () => {
    const skills = [makeSkill({ name: "real-skill" })];
    const pats: CrystallizedPattern[] = [{ kind: "command", value: "", count: 3 }];
    const result = proposeCrystallizeUpdate("/repo", pats, "run-safe", {
      discoverSkills: () => skills,
    });
    expect(result.hasProposal).toBe(false);
    expect(result.reason).toBe("no-match");
  });
});
