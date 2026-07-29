import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installLogbus, setLogbusForTests } from "../src/logbus.js";
import {
  handleCiDomainIntegrity,
  handleCiSecurity,
  handleCiValidation,
  handleSkillCiGate,
  runDomainIntegrityGate,
  runSkillCiGate,
  runSkillSecurityGate,
  runSkillValidationGate,
} from "../src/skills/ci-gate.js";
import type { CiGateDeps } from "../src/skills/ci-gate.js";
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
  if (duplicateOwner)
    facts.push({ key: "fact-a", owner: "otherskill", version: "1.0", statement: "dup" });
  if (unknownOwner)
    facts.push({ key: "fact-z", owner: "bogus", version: "1.0", statement: "orphan" });
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

function highScanDeps(): CiGateDeps {
  return {
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
  };
}

// ── Individual gate isolation ──────────────────────────────────────────────

describe("runSkillValidationGate", () => {
  test("no skills → pass", () => {
    expect(runSkillValidationGate(base).ok).toBe(true);
  });
  test("malformed frontmatter → fail", () => {
    const dir = join(base, ".vibeflow", "skills", "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: bad\ndescription: [\n---\n");
    expect(runSkillValidationGate(base).ok).toBe(false);
  });
  test("malformed policy → fail", () => {
    scaffoldSkill("myskill");
    scaffoldPolicy(true);
    expect(runSkillValidationGate(base).ok).toBe(false);
  });
  test("malformed registry lock → fail", () => {
    scaffoldLock(true);
    expect(runSkillValidationGate(base).ok).toBe(false);
  });
  test("eval mismatch → fail", () => {
    scaffoldSkill("myskill");
    scaffoldEval("myskill", "wrongname", true);
    expect(runSkillValidationGate(base).ok).toBe(false);
  });
  test("eval trigger failure → fail", () => {
    scaffoldSkill("myskill", "triggers:\n  - myskill");
    scaffoldEval("myskill", "myskill", false);
    expect(runSkillValidationGate(base).ok).toBe(false);
  });
  test("malformed eval → fail", () => {
    scaffoldSkill("myskill");
    scaffoldMalformedEval("myskill");
    expect(runSkillValidationGate(base).ok).toBe(false);
  });
  test("passes with no eval file", () => {
    scaffoldSkill("myskill");
    expect(runSkillValidationGate(base).ok).toBe(true);
  });
});

describe("runSkillSecurityGate", () => {
  test("no skills → pass", () => {
    expect(runSkillSecurityGate(base).ok).toBe(true);
  });
  test("missing scanner → warning / pass", () => {
    scaffoldSkill("ss");
    const r = runSkillSecurityGate(base);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/not available/i);
  });
  test("injected HIGH finding → fail", () => {
    scaffoldSkill("ss");
    expect(runSkillSecurityGate(base, highScanDeps()).ok).toBe(false);
  });
});

describe("runDomainIntegrityGate", () => {
  test("no skills / no facts → pass", () => {
    expect(runDomainIntegrityGate(base).ok).toBe(true);
  });
  test("malformed facts JSON → fail", () => {
    mkdirSync(join(base, ".vibeflow"), { recursive: true });
    writeFileSync(join(base, ".vibeflow", "DOMAIN_FACTS.json"), "not valid json");
    expect(runDomainIntegrityGate(base).ok).toBe(false);
  });
  test("duplicate facts + unknown owner → fail", () => {
    scaffoldSkill("myskill");
    scaffoldFacts(true, true);
    expect(runDomainIntegrityGate(base).ok).toBe(false);
  });
  test("clean facts + matching skills → pass", () => {
    scaffoldSkill("myskill");
    scaffoldFacts(false, false);
    expect(runDomainIntegrityGate(base).ok).toBe(true);
  });
});

// ── Aggregate compatibility (ci-gate === sum of three gates) ───────────────

describe("runSkillCiGate aggregate", () => {
  test("empty repo — all gates agree", () => {
    const full = runSkillCiGate(base);
    expect(full.ok).toBe(true);
    expect(runSkillValidationGate(base).ok).toBe(true);
    expect(runSkillSecurityGate(base).ok).toBe(true);
    expect(runDomainIntegrityGate(base).ok).toBe(true);
  });
  test("malformed policy — validation gate catches it", () => {
    scaffoldSkill("myskill");
    scaffoldPolicy(true);
    expect(runSkillCiGate(base).ok).toBe(false);
    expect(runSkillValidationGate(base).ok).toBe(false);
    expect(runSkillSecurityGate(base).ok).toBe(true);
    expect(runDomainIntegrityGate(base).ok).toBe(true);
  });
  test("security failure isolated to security gate", () => {
    scaffoldSkill("ss");
    expect(runSkillCiGate(base, highScanDeps()).ok).toBe(false);
    expect(runSkillValidationGate(base).ok).toBe(true);
    expect(runSkillSecurityGate(base, highScanDeps()).ok).toBe(false);
    expect(runDomainIntegrityGate(base).ok).toBe(true);
  });
  test("domain failure isolated to domain gate", () => {
    scaffoldSkill("myskill");
    scaffoldFacts(true, true);
    expect(runSkillCiGate(base).ok).toBe(false);
    expect(runSkillValidationGate(base).ok).toBe(true);
    expect(runSkillSecurityGate(base).ok).toBe(true);
    expect(runDomainIntegrityGate(base).ok).toBe(false);
  });
});

// ── CLI handlers — invalid args ───────────────────────────────────────────

describe("CLI handlers", () => {
  test.each([
    ["ci-validation", handleCiValidation],
    ["ci-security", handleCiSecurity],
    ["ci-domain-integrity", handleCiDomainIntegrity],
    ["ci-gate", handleSkillCiGate],
  ] as const)("%s: no args → exits 0 when clean", (_, fn) => {
    expect(fn(base, [])).toBe(0);
  });
  test.each([
    ["ci-validation", handleCiValidation],
    ["ci-security", handleCiSecurity],
    ["ci-domain-integrity", handleCiDomainIntegrity],
    ["ci-gate", handleSkillCiGate],
  ] as const)("%s: extra args → exits 2", (_, fn) => {
    expect(fn(base, ["x"])).toBe(2);
  });
  test("ci-gate errors → exits 1", () => {
    scaffoldPolicy(true);
    expect(handleSkillCiGate(base, [])).toBe(1);
  });
  test("ci-validation errors → exits 1 via printCiGateResult", () => {
    scaffoldPolicy(true);
    expect(handleCiValidation(base, [])).toBe(1);
  });
  test("ci-security no scanner → exits 0 (warning only)", () => {
    scaffoldSkill("ss");
    expect(handleCiSecurity(base, [])).toBe(0);
  });
  test("ci-domain-integrity malformed facts → exits 1", () => {
    mkdirSync(join(base, ".vibeflow"), { recursive: true });
    writeFileSync(join(base, ".vibeflow", "DOMAIN_FACTS.json"), "not valid json");
    expect(handleCiDomainIntegrity(base, [])).toBe(1);
  });
});
