import { describe, expect, test } from "bun:test";
import type { WorkUnit } from "../../src/core.js";
import {
  type SecurityCheckpointResult,
  defaultRunSkillFn,
  defaultSecurityAskFn,
  parseSecurityVerdict,
  runSecurityCheckpoint,
} from "../../src/orchestrator/security-checkpoint.js";

const baseUnit: WorkUnit = {
  name: "test-unit",
  status: "running",
  confidence: 0.9,
  gates: { build: "pass", lint: "pass", test: "pass", review: "pending" },
  resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  evidence: ["src/foo.ts"],
};

describe("parseSecurityVerdict", () => {
  test("parses a pass block", () => {
    const raw = `
analysis text here
SECURITY_CHECK_RESULT
unit: u1
items_checked: 30/30
items_failed: none
high_risk_findings: none
evidence: none
verdict: pass
`;
    const v = parseSecurityVerdict(raw);
    expect(v.verdict).toBe("pass");
    expect(v.items_checked).toBe(30);
    expect(v.items_failed).toBeUndefined();
  });

  test("parses a fail block with failed item numbers", () => {
    const raw = `
SECURITY_CHECK_RESULT
unit: u1
items_checked: 28/30
items_failed: 1,3
high_risk_findings: ["hardcoded secret", "unsafe eval"]
evidence: src/foo.ts:42
verdict: fail
`;
    const v = parseSecurityVerdict(raw);
    expect(v.verdict).toBe("fail");
    expect(v.items_checked).toBe(28);
    expect(v.items_failed).toEqual([1, 3]);
    expect(v.notes).toContain("src/foo.ts:42");
  });

  test("returns error when block is missing", () => {
    const v = parseSecurityVerdict("no result here");
    expect(v.verdict).toBe("error");
    expect(v.notes).toContain("no SECURITY_CHECK_RESULT block");
  });
});

describe("defaultAskFn", () => {
  test("returns a function that maps y → run", async () => {
    const ask = defaultSecurityAskFn();
    // Cannot easily simulate readline input; just check shape.
    expect(typeof ask).toBe("function");
  });
});

describe("defaultRunSkillFn", () => {
  test("returns empty string when skill file is missing", async () => {
    const text = await defaultRunSkillFn(baseUnit, "/nonexistent/path");
    expect(text).toBe("");
  });
});

describe("runSecurityCheckpoint", () => {
  test("skips when user picks skip", async () => {
    const ask = () => async () => "skip" as const;
    const r = await runSecurityCheckpoint(baseUnit, "/nonexistent", {
      askFn: ask,
      runSkillFn: async () => "should not be called",
    });
    expect(r.consent).toBe("skip");
    expect(r.verdict).toBe("skipped");
  });

  test("abstains (no) means user declined but not silently skipped", async () => {
    const ask = () => async () => "abstain" as const;
    const r = await runSecurityCheckpoint(baseUnit, "/nonexistent", {
      askFn: ask,
      runSkillFn: async () => "should not be called",
    });
    expect(r.consent).toBe("abstain");
    expect(r.verdict).toBe("skipped");
  });

  test("runs the skill and parses a pass verdict on user consent", async () => {
    const ask = () => async () => "run" as const;
    const runSkill = async () =>
      "SECURITY_CHECK_RESULT\nunit: u\nitems_checked: 30/30\nitems_failed: none\nverdict: pass";
    const r = await runSecurityCheckpoint(baseUnit, "/nonexistent", {
      askFn: ask,
      runSkillFn: runSkill,
    });
    expect(r.consent).toBe("run");
    expect(r.verdict).toBe("pass");
    expect(r.items_checked).toBe(30);
  });

  test("records fail verdict on hard-risk findings", async () => {
    const ask = () => async () => "run" as const;
    const runSkill = async () =>
      "SECURITY_CHECK_RESULT\nitems_checked: 25/30\nitems_failed: 1,2\nverdict: fail";
    const r: SecurityCheckpointResult = await runSecurityCheckpoint(baseUnit, "/nonexistent", {
      askFn: ask,
      runSkillFn: runSkill,
    });
    expect(r.verdict).toBe("fail");
    expect(r.items_failed).toEqual([1, 2]);
  });

  test("error when skill path missing", async () => {
    const ask = () => async () => "run" as const;
    const r = await runSecurityCheckpoint(baseUnit, "/no/such/dir", {
      askFn: ask,
      runSkillFn: defaultRunSkillFn,
    });
    expect(r.verdict).toBe("error");
    expect(r.notes).toContain("not found");
  });
});
