import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import { analyzeSkillImpact, handleImpactSubcommand } from "../src/skills/impact.js";
import { matchPolicyPaths, readSkillPolicy } from "../src/skills/policy.js";

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

function policy(raw: string): void {
  const dir = join(base, ".vibeflow");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL_POLICY.json"), raw);
}

async function run(rest: string[]): Promise<number> {
  const cwd = process.cwd();
  const oldHome = process.env.VF_SKILLS_HOME;
  process.env.VF_SKILLS_HOME = base;
  process.chdir(base);
  try {
    return await skills("impact", rest);
  } finally {
    process.chdir(cwd);
    process.env.VF_SKILLS_HOME = oldHome;
  }
}

const BASE_FACTS = {
  schemaVersion: 1,
  facts: [
    {
      key: "ctc-domain",
      owner: "neomatch-ctc-convention",
      version: "1",
      statement: "CTC domain ownership",
      dependents: ["ctc-child-1"],
    },
    {
      key: "auth-domain",
      owner: "auth-skill",
      version: "1",
      statement: "Authentication domain",
      paths: ["src/auth/"],
    },
    {
      key: "ui-domain",
      owner: "ui-skill",
      version: "1",
      statement: "UI component domain",
      paths: ["src/ui/"],
    },
  ],
};

const BASE_FACTS_RAW = JSON.stringify(BASE_FACTS);

function fixture(): void {
  facts(BASE_FACTS_RAW);
  skill("neomatch-ctc-convention");
  skill("ctc-child-1", "dependsOn:\n  - neomatch-ctc-convention\n");
  skill("auth-skill");
  skill("ui-skill");
}

// ── analyzeSkillImpact ──────────────────────────────────────────────────

describe("analyzeSkillImpact — exact fact key", () => {
  test("matches fact key exactly", () => {
    fixture();
    const r = analyzeSkillImpact(base, "ctc-domain");
    expect(r.facts).toEqual(["ctc-domain"]);
    expect(r.skills).toContain("neomatch-ctc-convention");
  });

  test("no substring match on fact key", () => {
    fixture();
    const r = analyzeSkillImpact(base, "ctc");
    expect(r.facts).toEqual([]);
  });
});

describe("analyzeSkillImpact — path prefix", () => {
  test("matches via fact key path prefix", () => {
    facts(BASE_FACTS_RAW);
    skill("auth-skill");
    const r = analyzeSkillImpact(base, "src/auth/login.ts");
    expect(r.facts).toEqual(["auth-domain"]);
  });

  test("matches via declared paths[] prefix", () => {
    facts(
      JSON.stringify({
        schemaVersion: 1,
        facts: [
          {
            key: "db-domain",
            owner: "db-skill",
            version: "1",
            statement: "Database domain",
            paths: ["src/db/"],
          },
        ],
      }),
    );
    skill("db-skill");
    const r = analyzeSkillImpact(base, "src/db/migrations/001.sql");
    expect(r.facts).toEqual(["db-domain"]);
  });

  test("path with dot treated as path", () => {
    fixture();
    const r = analyzeSkillImpact(base, "src/auth/login.ts");
    expect(r.facts).toEqual(["auth-domain"]);
  });

  test("forward slash treated as path", () => {
    fixture();
    const r = analyzeSkillImpact(base, "src/ui/components/Button.tsx");
    expect(r.facts).toEqual(["ui-domain"]);
  });
});

describe("analyzeSkillImpact — domain match", () => {
  test("matches by owner name", () => {
    fixture();
    const r = analyzeSkillImpact(base, "neomatch-ctc-convention");
    expect(r.facts).toEqual(["ctc-domain"]);
  });

  test("falls back to key match on domain query", () => {
    fixture();
    const r = analyzeSkillImpact(base, "ctc-domain");
    expect(r.facts).toEqual(["ctc-domain"]);
  });
});

describe("analyzeSkillImpact — dependents and owns graph", () => {
  test("includes dependent skills", () => {
    facts(BASE_FACTS_RAW);
    skill("neomatch-ctc-convention");
    skill("ctc-child-1", "dependsOn:\n  - neomatch-ctc-convention\n");
    const r = analyzeSkillImpact(base, "ctc-domain");
    expect(r.skills).toContain("ctc-child-1");
    expect(r.skills).toContain("neomatch-ctc-convention");
  });

  test("includes skills whose owns overlaps matched fact", () => {
    facts(BASE_FACTS_RAW);
    skill("neomatch-ctc-convention");
    skill("extra-owner", "owns:\n  - ctc-domain\n");
    const r = analyzeSkillImpact(base, "ctc-domain");
    expect(r.skills).toContain("extra-owner");
  });

  test("recursive dependents", () => {
    facts(BASE_FACTS_RAW);
    skill("neomatch-ctc-convention");
    skill("middle", "dependsOn:\n  - neomatch-ctc-convention\n");
    skill("leaf", "dependsOn:\n  - middle\n");
    const r = analyzeSkillImpact(base, "ctc-domain");
    expect(r.skills).toContain("middle");
    expect(r.skills).toContain("leaf");
  });
});

describe("analyzeSkillImpact — edge cases", () => {
  test("missing facts file returns empty", () => {
    expect(analyzeSkillImpact(base, "anything")).toEqual({
      facts: [],
      skills: [],
      evalCommands: [],
    });
  });

  test("malformed facts returns empty", () => {
    facts("{");
    expect(analyzeSkillImpact(base, "x")).toEqual({ facts: [], skills: [], evalCommands: [] });
  });

  test("no match returns empty", () => {
    fixture();
    expect(analyzeSkillImpact(base, "no-such-thing")).toEqual({
      facts: [],
      skills: [],
      evalCommands: [],
    });
  });

  test("unsafe path input returns empty (absolute)", () => {
    fixture();
    expect(analyzeSkillImpact(base, "/etc/passwd")).toEqual({
      facts: [],
      skills: [],
      evalCommands: [],
    });
  });

  test("unsafe path input returns empty (traversal)", () => {
    fixture();
    expect(analyzeSkillImpact(base, "../../etc/passwd")).toEqual({
      facts: [],
      skills: [],
      evalCommands: [],
    });
  });

  test("unsafe path input returns empty (backslash)", () => {
    fixture();
    expect(analyzeSkillImpact(base, "src\\auth\\login.ts")).toEqual({
      facts: [],
      skills: [],
      evalCommands: [],
    });
  });
});

describe("analyzeSkillImpact — policy domain fallback", () => {
  test("matches fact via policy protected path domain", () => {
    facts(BASE_FACTS_RAW);
    skill("neomatch-ctc-convention");
    skill("ctc-child-1", "dependsOn:\n  - neomatch-ctc-convention\n");
    policy(
      JSON.stringify({
        schemaVersion: 1,
        enforcementLevel: "warn",
        domains: { "neomatch-ctc-convention": { requiredChecks: ["ctc-impact"] } },
        protectedPaths: [{ pattern: "**/*", domain: "neomatch-ctc-convention" }],
      }),
    );
    const r = analyzeSkillImpact(base, "src/domain/ctc/x.ts", {
      readSkillPolicy,
      matchPolicyPaths,
    });
    expect(r.facts).toEqual(["ctc-domain"]);
  });
});

describe("analyzeSkillImpact — eval commands", () => {
  test("produces sorted eval commands per affected skill", () => {
    facts(BASE_FACTS_RAW);
    skill("auth-skill");
    skill("auth-child", "dependsOn:\n  - auth-skill\n");
    const r = analyzeSkillImpact(base, "auth-domain");
    expect(r.evalCommands).toEqual(["vf skills eval auth-child", "vf skills eval auth-skill"]);
  });
});

// ── handleImpactSubcommand ──────────────────────────────────────────────

describe("handleImpactSubcommand", () => {
  test("missing query returns 2", () => {
    expect(handleImpactSubcommand(base, [])).toBe(2);
  });

  test("no match returns 3 (nonzero)", () => {
    fixture();
    expect(handleImpactSubcommand(base, ["no-such-thing"])).toBe(3);
  });

  test("matched fact returns 0", () => {
    fixture();
    expect(handleImpactSubcommand(base, ["ctc-domain"])).toBe(0);
  });

  test("matched path returns 0", () => {
    fixture();
    expect(handleImpactSubcommand(base, ["src/auth/login.ts"])).toBe(0);
  });

  test("matched domain returns 0", () => {
    fixture();
    expect(handleImpactSubcommand(base, ["neomatch-ctc-convention"])).toBe(0);
  });

  test("unsafe path input returns 3", () => {
    fixture();
    expect(handleImpactSubcommand(base, ["/etc/passwd"])).toBe(3);
  });
});

// ── CLI integration ─────────────────────────────────────────────────────

describe("vf skills impact CLI", () => {
  test("missing query returns 2", async () => {
    expect(await run([])).toBe(2);
  });

  test("no match returns 3", async () => {
    fixture();
    expect(await run(["no-such-thing"])).toBe(3);
  });

  test("matched fact key returns 0", async () => {
    fixture();
    expect(await run(["ctc-domain"])).toBe(0);
  });

  test("matched path returns 0", async () => {
    fixture();
    expect(await run(["src/auth/login.ts"])).toBe(0);
  });
});
