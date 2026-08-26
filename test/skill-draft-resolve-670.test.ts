import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync as fsExistsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import { matchPolicyPaths, readSkillPolicy } from "../src/skills/policy.js";
import { resolveDraftDomain } from "../src/skills/resolve-draft.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-draft-resolve-"));
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

// ── resolveDraftDomain ────────────────────────────────────────────────

describe("resolveDraftDomain — exact domain", () => {
  test("returns use-existing when domain.id matches name", () => {
    skill("auth-skill", "domain:\n  id: auth-domain\n  role: canonical\n");
    facts(
      JSON.stringify({
        schemaVersion: 1,
        facts: [{ key: "auth-domain", owner: "auth-skill", version: "1", statement: "auth" }],
      }),
    );
    const r = resolveDraftDomain(base, "auth-domain");
    expect(r.kind).toBe("use-existing");
    expect(r.existingSkill).toBe("auth-skill");
  });

  test("returns update-existing when fact owner matches", () => {
    skill("auth-skill");
    facts(
      JSON.stringify({
        schemaVersion: 1,
        facts: [{ key: "auth-login", owner: "auth-skill", version: "1", statement: "auth login" }],
      }),
    );
    const r = resolveDraftDomain(base, "auth-login");
    expect(r.kind).toBe("update-existing");
    expect(r.existingSkill).toBe("auth-skill");
  });

  test("returns update-existing when impact names a skill", () => {
    skill("existing");
    facts(
      JSON.stringify({
        schemaVersion: 1,
        facts: [{ key: "new-domain", owner: "existing", version: "1", statement: "new" }],
      }),
    );
    const r = resolveDraftDomain(base, "new-domain");
    expect(r.kind).toBe("update-existing");
    expect(r.existingSkill).toBe("existing");
  });
});

describe("resolveDraftDomain — path policy fallback", () => {
  test("returns update-existing via policy path domain", () => {
    skill("db-skill");
    facts(
      JSON.stringify({
        schemaVersion: 1,
        facts: [{ key: "db-migrate", owner: "db-skill", version: "1", statement: "db" }],
      }),
    );
    policy(
      JSON.stringify({
        schemaVersion: 1,
        enforcementLevel: "warn",
        domains: { "db-skill": { requiredChecks: ["db-check"] } },
        protectedPaths: [{ pattern: "db/**", domain: "db-skill" }],
      }),
    );
    const r = resolveDraftDomain(base, "db/migrations/001.sql", {
      readSkillPolicy,
      matchPolicyPaths,
    });
    expect(r.kind).toBe("update-existing");
    expect(r.existingSkill).toBe("db-skill");
  });
});

describe("resolveDraftDomain — unmatched create", () => {
  test("returns create-new for empty repo", () => {
    const r = resolveDraftDomain(base, "anything");
    expect(r.kind).toBe("create-new");
  });

  test("returns create-new when facts exist but no match", () => {
    skill("ui-skill");
    facts(
      JSON.stringify({
        schemaVersion: 1,
        facts: [{ key: "ui-domain", owner: "ui-skill", version: "1", statement: "ui" }],
      }),
    );
    const r = resolveDraftDomain(base, "backend");
    expect(r.kind).toBe("create-new");
  });
});

describe("resolveDraftDomain — stable order", () => {
  test("returns deterministic kind for same input", () => {
    const r1 = resolveDraftDomain(base, "no-such-thing");
    const r2 = resolveDraftDomain(base, "no-such-thing");
    expect(r1.kind).toBe(r2.kind);
  });
});

// ── CLI integration ───────────────────────────────────────────────────

async function run(rest: string[]): Promise<number> {
  const orig = process.cwd();
  const origHome = process.env.VF_SKILLS_HOME;
  process.env.VF_SKILLS_HOME = base;
  process.chdir(base);
  try {
    return await skills("draft", rest);
  } finally {
    process.chdir(orig);
    if (origHome === undefined) process.env.VF_SKILLS_HOME = undefined;
    else process.env.VF_SKILLS_HOME = origHome;
  }
}

describe("vf skills draft CLI — domain resolution", () => {
  test("blocks draft when domain exists", async () => {
    skill("auth-skill", "domain:\n  id: auth-domain\n  role: canonical\n");
    facts(
      JSON.stringify({
        schemaVersion: 1,
        facts: [{ key: "auth-domain", owner: "auth-skill", version: "1", statement: "auth" }],
      }),
    );
    expect(await run(["auth-domain"])).toBe(0);
    // Should not have created the file
    const target = join(base, ".vibeflow", "skills", "auth-domain", "SKILL.md");
    expect(fsExistsSync(target)).toBe(false);
  });

  test("--new bypasses resolution", async () => {
    skill("auth-skill", "domain:\n  id: auth-domain\n  role: canonical\n");
    facts(
      JSON.stringify({
        schemaVersion: 1,
        facts: [{ key: "auth-domain", owner: "auth-skill", version: "1", statement: "auth" }],
      }),
    );
    expect(await run(["--new", "auth-domain"])).toBe(0);
    const target = join(base, ".vibeflow", "skills", "auth-domain", "SKILL.md");
    expect(fsExistsSync(target)).toBe(true);
  });

  test("creates draft when no domain match", async () => {
    expect(await run(["brand-new"])).toBe(0);
    const target = join(base, ".vibeflow", "skills", "brand-new", "SKILL.md");
    expect(fsExistsSync(target)).toBe(true);
  });

  test("missing name returns 2", async () => {
    expect(await run([])).toBe(2);
  });

  test("invalid name returns 2", async () => {
    expect(await run(["BAD_NAME"])).toBe(2);
  });
});
