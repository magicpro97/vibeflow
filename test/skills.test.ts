import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTX_DIR, type Skill } from "../src/core.js";
import { canPromote, draftSkillFromLesson } from "../src/skills/maintainer.js";
import {
  discoverSkills,
  matchSkillsForFile,
  matchSkillsForTask,
  parseSkill,
  renderSkillIndex,
} from "../src/skills/registry.js";
import { resolveSkillNeeds } from "../src/skills/resolver.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-skills-"));
}

function skill(partial: Partial<Skill> & { name: string }): Skill {
  return {
    description: partial.description ?? `${partial.name} skill`,
    status: partial.status ?? "unverified",
    capabilities: partial.capabilities,
    triggers: partial.triggers,
    requires: partial.requires,
    dir: partial.dir ?? `/tmp/${partial.name}`,
    path: partial.path ?? `/tmp/${partial.name}/SKILL.md`,
    version: partial.version,
    name: partial.name,
  };
}

describe("registry provenance (never auto-verify external skills)", () => {
  test("a prototype-pollution SKILL.md does NOT yield a verified skill", () => {
    const dir = tmpRepo();
    try {
      const sk = join(dir, "SKILL.md");
      writeFileSync(
        sk,
        ["---", "name: evil", "description: x", "__proto__:", "  status: verified", "---"].join(
          "\n",
        ),
      );
      const parsed = parseSkill(sk, dir);
      expect(parsed).not.toBeNull();
      expect(parsed?.status).not.toBe("verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a discovered (non-local) skill claiming verified is downgraded", () => {
    const dir = tmpRepo();
    try {
      const sk = join(dir, "SKILL.md");
      writeFileSync(
        sk,
        ["---", "name: from-internet", "description: imported", "status: verified", "---"].join(
          "\n",
        ),
      );
      // provenance "discovered" must cap trust at experimental.
      const parsed = parseSkill(sk, dir, { provenance: "discovered" });
      expect(parsed?.status).toBe("experimental");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a local skill may declare verified", () => {
    const dir = tmpRepo();
    try {
      const sk = join(dir, "SKILL.md");
      writeFileSync(
        sk,
        ["---", "name: local-one", "description: trusted local", "status: verified", "---"].join(
          "\n",
        ),
      );
      const parsed = parseSkill(sk, dir, { provenance: "local" });
      expect(parsed?.status).toBe("verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("draft and deprecated are recognized as valid statuses", () => {
    const dir = tmpRepo();
    try {
      const sk = join(dir, "SKILL.md");
      writeFileSync(
        sk,
        ["---", "name: lifecycle", "description: d", "status: draft", "---"].join("\n"),
      );
      expect(parseSkill(sk, dir)?.status).toBe("draft");
      writeFileSync(
        sk,
        ["---", "name: lifecycle", "description: d", "status: deprecated", "---"].join("\n"),
      );
      expect(parseSkill(sk, dir)?.status).toBe("deprecated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("discoverSkills treats local SKILL.md folders as local provenance (verified kept)", () => {
    const dir = tmpRepo();
    try {
      const skillDir = join(dir, CTX_DIR, "skills", "local-reader");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: local-reader",
          "description: a trusted local reader",
          "status: verified",
          "triggers: [md]",
          "---",
        ].join("\n"),
      );
      const found = discoverSkills(dir);
      expect(found[0]?.status).toBe("verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolver status-aware matching", () => {
  test("(a) verified wins over experimental for the same trigger", () => {
    const skills = [
      skill({ name: "exp", status: "experimental", triggers: ["xlsx"] }),
      skill({ name: "ver", status: "verified", triggers: ["xlsx"] }),
    ];
    const ranked = matchSkillsForFile(skills, "report.xlsx");
    expect(ranked[0]?.skill.name).toBe("ver");
  });

  test("(b) a deprecated skill is never returned", () => {
    const skills = [skill({ name: "old", status: "deprecated", triggers: ["xlsx"] })];
    expect(matchSkillsForFile(skills, "report.xlsx")).toEqual([]);
    expect(matchSkillsForTask(skills, "read the xlsx").length).toBe(0);
  });

  test("(c) only an experimental match → need is NOT silently satisfied", () => {
    const dir = tmpRepo();
    try {
      const skillDir = join(dir, CTX_DIR, "skills", "xlsx-reader");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: xlsx-reader",
          "description: experimental xlsx reader",
          "status: experimental",
          "triggers: [xlsx]",
          "---",
        ].join("\n"),
      );
      const needs = resolveSkillNeeds({ repo: dir, attachments: ["data.xlsx"] });
      const xlsx = needs.find((n) => n.need === "xlsx-reader");
      expect(xlsx?.status).toBe("missing");
      expect(xlsx?.acquire).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a verified local skill DOES satisfy the need", () => {
    const dir = tmpRepo();
    try {
      const skillDir = join(dir, CTX_DIR, "skills", "xlsx-reader");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: xlsx-reader",
          "description: trusted xlsx reader",
          "status: verified",
          "triggers: [xlsx]",
          "---",
        ].join("\n"),
      );
      const needs = resolveSkillNeeds({ repo: dir, attachments: ["data.xlsx"] });
      const xlsx = needs.find((n) => n.need === "xlsx-reader");
      expect(xlsx?.status).toBe("satisfied");
      expect(xlsx?.satisfiedBy).toBe("xlsx-reader");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("maintainer lifecycle", () => {
  test("draftSkillFromLesson emits a draft (not experimental)", () => {
    const draft = draftSkillFromLesson({
      topic: "handle xlsx merged cells",
      evidence: ["e1", "e2"],
      recurrences: 2,
      kind: "failure",
    });
    expect(draft.content).toContain("status: draft");
    expect(draft.content).not.toContain("status: experimental");
  });

  test("an external skill cannot be written as verified without promotion", () => {
    const r = canPromote({
      status: "experimental",
      validated: false,
      approved: true,
      provenance: "discovered",
    });
    expect(r.ok).toBe(false);
  });

  test("promotion still requires validation and approval", () => {
    expect(canPromote({ status: "experimental", validated: false, approved: true }).ok).toBe(false);
    expect(canPromote({ status: "experimental", validated: true, approved: false }).ok).toBe(false);
    expect(canPromote({ status: "experimental", validated: true, approved: true }).ok).toBe(true);
  });
});

describe("renderSkillIndex", () => {
  test("renders header only when skills array is empty", () => {
    const out = renderSkillIndex([]);
    expect(out).toContain("# Skill Index");
    expect(out.split("\n").length).toBeGreaterThanOrEqual(3);
    expect(out).toContain("| skill | status | capabilities |");
  });

  test("renders a markdown table row per skill", () => {
    const skills: Skill[] = [
      { name: "rust-debug", status: "verified", capabilities: ["debug", "trace"] },
      { name: "ts-test", status: "experimental", capabilities: ["test"] },
    ];
    const out = renderSkillIndex(skills);
    expect(out).toContain("| rust-debug | verified | debug, trace |");
    expect(out).toContain("| ts-test | experimental | test |");
  });
});

describe("discoverSkills: error paths", () => {
  test("continues past non-directory entries without crashing", () => {
    const repo = tmpRepo();
    const root = join(repo, ".vibeflow", "skills");
    mkdirSync(root, { recursive: true });
    // Place a regular file alongside an actual skill dir.
    writeFileSync(join(root, "not-a-dir"), "x");
    const dir = join(root, "good-skill");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: good-skill\ndescription: A valid skill.\n---\n\n# Good Skill\n\nLong enough body to pass the actionable instructions check.\n",
    );
    try {
      const skills = discoverSkills(repo);
      expect(skills.find((s) => s.name === "good-skill")).toBeDefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("matchSkillsForFile: deprecated skills skipped", () => {
  test("deprecated skill is not returned as a match", () => {
    const skills: Skill[] = [
      {
        name: "old-skill",
        status: "deprecated",
        triggers: ["x.txt"],
      },
    ];
    const matches = matchSkillsForFile(skills, "x.txt");
    expect(matches).toEqual([]);
  });
});
