import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installLogbus, setLogbusForTests } from "../src/logbus.js";
import { handleSkillCiGate, runSkillCiGate } from "../src/skills/ci-gate.js";
import type { ScanDeps } from "../src/skills/security-scan.js";

type FakeSpawn = ScanDeps["spawnSync"];

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-cigate-"));
  setLogbusForTests(installLogbus({ dir: join(tmpdir(), `vf-cigate-log-${Date.now()}`) }));
});

afterEach(() => {
  setLogbusForTests(null);
  rmSync(base, { recursive: true, force: true });
});

function scaffoldSkill(name: string, extraFm?: string): void {
  const dir = join(base, ".vibeflow", "skills", name);
  mkdirSync(dir, { recursive: true });
  const fm = ["---", `name: ${name}`, "description: a test skill"];
  if (extraFm) fm.push(extraFm);
  fm.push(
    "---",
    "",
    "# Skill",
    "",
    "## When to use",
    "Use for X.",
    "## When NOT to use",
    "Not for Y.",
    "## Steps",
    "1. Do thing.",
    "## Verification",
    "Check output.",
  );
  writeFileSync(join(dir, "SKILL.md"), fm.join("\n"));
}

function scaffoldFacts(duplicateOwner = false, unknownOwner = false): void {
  const facts: { key: string; owner: string; version: string; statement: string }[] = [
    { key: "fact-a", owner: "myskill", version: "1.0", statement: "Fact A" },
  ];
  if (duplicateOwner) {
    facts.push({ key: "fact-a", owner: "otherskill", version: "1.0", statement: "dup" });
  }
  if (unknownOwner) {
    facts.push({ key: "fact-z", owner: "bogus", version: "1.0", statement: "orphan" });
  }
  writeFileSync(
    join(base, ".vibeflow", "DOMAIN_FACTS.json"),
    JSON.stringify({ schemaVersion: 1, facts }),
  );
}

function scaffoldEval(name: string, skillName: string, pass: boolean): void {
  const dir = join(base, ".vibeflow", "skills", name, "evals");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "evals.json"),
    JSON.stringify({
      schemaVersion: 1,
      skill: skillName,
      cases: [{ id: "tc1", type: "positive", prompt: pass ? skillName : "zzzzzznomatch99999" }],
    }),
  );
}

function scaffoldMalformedEval(name: string): void {
  const dir = join(base, ".vibeflow", "skills", name, "evals");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "evals.json"), "not valid json");
}

function scaffoldPolicy(malformed: boolean): void {
  const path = join(base, ".vibeflow", "SKILL_POLICY.json");
  mkdirSync(dirname(path), { recursive: true });
  if (malformed) {
    writeFileSync(path, "not valid json");
  } else {
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        domains: {},
        protectedPaths: [],
        enforcementLevel: "block",
      }),
    );
  }
}

function scaffoldLock(malformed: boolean): void {
  const path = join(base, ".vibeflow", "SKILL_REGISTRY.lock.json");
  mkdirSync(dirname(path), { recursive: true });
  if (malformed) {
    writeFileSync(path, "not valid json");
  } else {
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "test",
            url: "https://x.com/r",
            ref: "main",
            commitOID: "abc123def456abc123def456abc123def456abc1",
            installed: [],
          },
        ],
      }),
    );
  }
}

// ── runSkillCiGate ──────────────────────────────────────────────────────────

describe("runSkillCiGate", () => {
  test("no skills / no facts / no policy → pass", () => {
    const r = runSkillCiGate(base);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  test("malformed frontmatter → fail", () => {
    const dir = join(base, ".vibeflow", "skills", "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: bad\ndescription: [\n---\n");
    const r = runSkillCiGate(base);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test("malformed facts JSON → fail", () => {
    mkdirSync(join(base, ".vibeflow"), { recursive: true });
    writeFileSync(join(base, ".vibeflow", "DOMAIN_FACTS.json"), "not valid json");
    const r = runSkillCiGate(base);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/DOMAIN_FACTS/i);
  });

  test("invalid local skill discovery → fail", () => {
    scaffoldSkill("BadName");
    const r = runSkillCiGate(base);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/lowercase kebab-case/i);
  });

  test("duplicate facts + unknown owner → fail", () => {
    scaffoldSkill("myskill");
    scaffoldFacts(true, true);
    const r = runSkillCiGate(base);
    expect(r.ok).toBe(false);
    const joined = r.errors.join(" ");
    expect(joined).toMatch(/duplicate/i);
    expect(joined).toMatch(/bogus/i);
  });

  test("eval mismatch → fail", () => {
    scaffoldSkill("myskill");
    scaffoldEval("myskill", "wrongname", true);
    const r = runSkillCiGate(base);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/wrongname/i);
  });

  test("eval trigger failure → fail", () => {
    scaffoldSkill("myskill", "triggers:\n  - myskill");
    scaffoldEval("myskill", "myskill", false);
    const r = runSkillCiGate(base);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/triggerAccuracy/i);
  });

  test("no eval file allowed → pass (no required-eval policy)", () => {
    scaffoldSkill("myskill");
    const r = runSkillCiGate(base);
    expect(r.ok).toBe(true);
  });

  test("malformed eval → fail", () => {
    scaffoldSkill("myskill");
    scaffoldMalformedEval("myskill");
    const r = runSkillCiGate(base);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/eval error/i);
  });

  test("injected HIGH finding → fail", () => {
    scaffoldSkill("ss");
    const r = runSkillCiGate(base, {
      scanDeps: {
        hasCommand: () => true,
        homedir: () => base,
        spawnSync: (() => ({
          stdout: JSON.stringify({
            risk_severity: "HIGH",
            filtered_findings: [{ rule_id: "R1", message: "danger" }],
          }),
          stderr: "",
          status: 1,
        })) as unknown as FakeSpawn,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/HIGH/i);
    expect(r.scanned).toBe(true);
  });

  test("missing scanner → warning / pass (not-scanned)", () => {
    scaffoldSkill("ss");
    const r = runSkillCiGate(base);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/not available/i);
    expect(r.scanned).toBe(false);
  });

  test("malformed policy → fail in ci-gate", () => {
    scaffoldSkill("myskill");
    scaffoldPolicy(true);
    const r = runSkillCiGate(base);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/policy/i);
  });

  test("malformed registry lock → fail", () => {
    scaffoldLock(true);
    const r = runSkillCiGate(base);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/malformed/i);
  });
});

// ── handleSkillCiGate (command routing) ────────────────────────────────────

describe("handleSkillCiGate", () => {
  test("no extra args → exits 0 when clean", () => {
    expect(handleSkillCiGate(base, [])).toBe(0);
  });

  test("gate errors → exits 1", () => {
    scaffoldPolicy(true);
    expect(handleSkillCiGate(base, [])).toBe(1);
  });

  test("extra args → exits 2", () => {
    const code = handleSkillCiGate(base, ["extra"]);
    expect(code).toBe(2);
  });
});
