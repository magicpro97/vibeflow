import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SkillPolicy,
  conservativeDefaultPolicy,
  matchPolicyPaths,
  readSkillPolicy,
  validateSkillPolicy,
} from "../src/skills/policy";

function policy(overrides?: Partial<SkillPolicy>): SkillPolicy {
  return {
    schemaVersion: 1,
    domains: {},
    protectedPaths: [],
    enforcementLevel: "warn",
    ...overrides,
  };
}

function fakeExists(v: boolean) {
  return ((_p: string) => v) as typeof existsSync;
}

function fakeRead(v: string) {
  return ((_p: string, _e: unknown) => v) as typeof readFileSync;
}

describe("conservativeDefaultPolicy", () => {
  test("returns safe defaults", () => {
    const p = conservativeDefaultPolicy();
    expect(p.schemaVersion).toBe(1);
    expect(p.domains).toEqual({});
    expect(p.protectedPaths).toEqual([]);
    expect(p.enforcementLevel).toBe("warn");
  });
});

describe("validateSkillPolicy", () => {
  test("rejects non-object", () => {
    const r = validateSkillPolicy(null);
    expect(r.errors).toContain("policy must be a JSON object");
    expect(r.policy.enforcementLevel).toBe("warn");
  });

  test("rejects missing schemaVersion", () => {
    const r = validateSkillPolicy({ enforcementLevel: "warn" });
    expect(r.errors).toContain('missing required field "schemaVersion"');
  });

  test("rejects wrong schemaVersion", () => {
    const r = validateSkillPolicy({ schemaVersion: 2, enforcementLevel: "warn" });
    expect(r.errors).toContain('"schemaVersion" must be 1');
  });

  test("rejects missing enforcementLevel", () => {
    const r = validateSkillPolicy({ schemaVersion: 1 });
    expect(r.errors).toContain('missing required field "enforcementLevel"');
  });

  test("rejects bad enforcementLevel", () => {
    const r = validateSkillPolicy({ schemaVersion: 1, enforcementLevel: "strict" });
    expect(r.errors).toContain('"enforcementLevel" must be one of: warn, require_approval, block');
  });

  test("rejects domains non-object", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      domains: "str",
    });
    expect(r.errors).toContain('"domains" must be an object');
  });

  test("domain key not kebab-case warns", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      domains: { BadKey: {} },
    });
    expect(r.warnings).toContain('domain key "BadKey" is not kebab-case');
  });

  test("rejects domain value non-object", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      domains: { ctc: 42 },
    });
    expect(r.errors).toContain('domain "ctc" value must be an object');
  });

  test("rejects domain owners non-array", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      domains: { ctc: { owners: "not-array" } },
    });
    expect(r.errors).toContain('domain "ctc".owners must be a string array');
  });

  test("rejects domain requiredChecks non-array", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      domains: { ctc: { requiredChecks: 42 } },
    });
    expect(r.errors).toContain('domain "ctc".requiredChecks must be a string array');
  });

  test("rejects protectedPaths non-array", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      protectedPaths: "not-array",
    });
    expect(r.errors).toContain('"protectedPaths" must be an array');
  });

  test("rejects protectedPaths element non-object", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      protectedPaths: [42],
    });
    expect(r.errors).toContain("protectedPaths[0] must be an object");
  });

  test("rejects pattern non-string", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      protectedPaths: [{ pattern: 42 }],
    });
    expect(r.errors).toContain("protectedPaths[0].pattern must be a string");
  });

  test("rejects empty pattern", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      protectedPaths: [{ pattern: "" }],
    });
    expect(r.errors[0]).toContain("pattern must not be empty");
  });

  test("rejects absolute pattern", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      protectedPaths: [{ pattern: "/etc/passwd" }],
    });
    expect(r.errors[0]).toContain("pattern must not be absolute");
  });

  test("rejects path traversal pattern", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      protectedPaths: [{ pattern: "../foo" }],
    });
    expect(r.errors[0]).toContain('pattern must not contain ".."');
  });

  test("rejects NUL byte in pattern", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      protectedPaths: [{ pattern: "foo\0bar" }],
    });
    expect(r.errors[0]).toContain("pattern must not contain NUL byte");
  });

  test("rejects backslash in pattern", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      protectedPaths: [{ pattern: "foo\\bar" }],
    });
    expect(r.errors[0]).toContain("pattern must not contain backslash");
  });

  test("rejects rule.domain non-string", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      protectedPaths: [{ pattern: "src/**", domain: 42 }],
    });
    expect(r.errors).toContain("protectedPaths[0].domain must be a string");
  });

  test("rejects rule.requiredChecks non-array", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
      protectedPaths: [{ pattern: "src/**", requiredChecks: "check" }],
    });
    expect(r.errors).toContain("protectedPaths[0].requiredChecks must be a string array");
  });

  test("valid minimal policy", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "warn",
    });
    expect(r.errors).toEqual([]);
    expect(r.policy.enforcementLevel).toBe("warn");
  });

  test("valid policy with all fields", () => {
    const r = validateSkillPolicy({
      schemaVersion: 1,
      enforcementLevel: "block",
      domains: {
        ctc: { owners: ["neomatch-ctc-convention"], requiredChecks: ["vf skills facts check"] },
      },
      protectedPaths: [
        {
          pattern: "src/domain/ctc/**",
          domain: "ctc",
          requiredChecks: ["vf skills impact src/domain/ctc/"],
        },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.policy.domains.ctc?.owners).toEqual(["neomatch-ctc-convention"]);
    expect(r.policy.protectedPaths[0]?.pattern).toBe("src/domain/ctc/**");
    expect(r.policy.enforcementLevel).toBe("block");
  });

  test("accepts all enforcement levels", () => {
    for (const level of ["warn", "require_approval", "block"] as const) {
      const r = validateSkillPolicy({ schemaVersion: 1, enforcementLevel: level });
      expect(r.errors).toEqual([]);
      expect(r.policy.enforcementLevel).toBe(level);
    }
  });
});

describe("readSkillPolicy", () => {
  test("returns conservative default when no file (injected)", () => {
    const r = readSkillPolicy("/tmp/nonexistent", { existsSync: fakeExists(false) });
    expect(r.policy.enforcementLevel).toBe("warn");
    expect(r.warnings).toEqual([]);
  });

  test("returns conservative default with warning on malformed JSON (injected)", () => {
    const r = readSkillPolicy("/tmp/fake", {
      existsSync: fakeExists(true),
      readFileSync: (() => {
        throw new SyntaxError("Unexpected token");
      }) as typeof readFileSync,
    });
    expect(r.policy.enforcementLevel).toBe("warn");
    expect(r.warnings).toContain("SKILL_POLICY.json: malformed JSON, using conservative default");
  });

  test("propagates validation warnings (injected)", () => {
    const r = readSkillPolicy("/tmp/fake", {
      existsSync: fakeExists(true),
      readFileSync: fakeRead(JSON.stringify({ schemaVersion: 1, enforcementLevel: "invalid" })),
    });
    expect(r.policy.enforcementLevel).toBe("warn");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test("returns valid policy from injected read", () => {
    const r = readSkillPolicy("/tmp/fake", {
      existsSync: fakeExists(true),
      readFileSync: fakeRead(
        JSON.stringify({ schemaVersion: 1, enforcementLevel: "require_approval" }),
      ),
    });
    expect(r.policy.enforcementLevel).toBe("require_approval");
    expect(r.warnings).toEqual([]);
  });

  test("returns conservative default when no file (real filesystem)", () => {
    const r = readSkillPolicy(process.cwd());
    expect(r.policy.enforcementLevel).toBe("warn");
    expect(r.warnings).toEqual([]);
  });

  test("reads valid file from temp directory", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "policy-test-"));
    try {
      mkdirSync(join(tmpDir, ".vibeflow"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".vibeflow", "SKILL_POLICY.json"),
        JSON.stringify({ schemaVersion: 1, enforcementLevel: "block" }),
      );
      const r = readSkillPolicy(tmpDir);
      expect(r.policy.enforcementLevel).toBe("block");
      expect(r.warnings).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("handles malformed JSON from real filesystem", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "policy-test-"));
    try {
      mkdirSync(join(tmpDir, ".vibeflow"), { recursive: true });
      writeFileSync(join(tmpDir, ".vibeflow", "SKILL_POLICY.json"), "{invalid}");
      const r = readSkillPolicy(tmpDir);
      expect(r.policy.enforcementLevel).toBe("warn");
      expect(r.warnings).toContain("SKILL_POLICY.json: malformed JSON, using conservative default");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("matchPolicyPaths", () => {
  const ctcRule = {
    pattern: "src/domain/ctc/**",
    domain: "ctc",
    requiredChecks: ["vf skills impact src/domain/ctc/"],
  };
  const p = policy({
    domains: { ctc: { requiredChecks: ["vf skills facts check"] } },
    protectedPaths: [ctcRule],
  });

  test("empty changed paths returns nothing", () => {
    const r = matchPolicyPaths(p, []);
    expect(r.rules).toEqual([]);
    expect(r.requiredChecks).toEqual([]);
  });

  test("matches ** glob", () => {
    const r = matchPolicyPaths(p, ["src/domain/ctc/x.ts"]);
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]?.pattern).toBe("src/domain/ctc/**");
  });

  test("* does not cross slash boundary", () => {
    const starPolicy = policy({
      protectedPaths: [{ pattern: "src/*/file.ts" }],
    });
    const r = matchPolicyPaths(starPolicy, ["src/domain/file.ts"]);
    expect(r.rules).toHaveLength(1);
  });

  test("* rejects cross-slash match", () => {
    const starPolicy = policy({
      protectedPaths: [{ pattern: "src/*.ts" }],
    });
    const r = matchPolicyPaths(starPolicy, ["src/domain/file.ts"]);
    expect(r.rules).toEqual([]);
  });

  test("** matches across nested paths", () => {
    const r = matchPolicyPaths(p, ["src/domain/ctc/a/b/c.ts"]);
    expect(r.rules).toHaveLength(1);
  });

  test("skips absolute path", () => {
    const r = matchPolicyPaths(p, ["/etc/passwd"]);
    expect(r.rules).toEqual([]);
  });

  test("skips backslash path", () => {
    const r = matchPolicyPaths(p, ["src\\domain\\ctc\\x.ts"]);
    expect(r.rules).toEqual([]);
  });

  test("skips path with ..", () => {
    const r = matchPolicyPaths(p, ["src/domain/ctc/../../x.ts"]);
    expect(r.rules).toEqual([]);
  });

  test("skips NUL byte path", () => {
    const r = matchPolicyPaths(p, ["src/domain/ctc/x\0.ts"]);
    expect(r.rules).toEqual([]);
  });

  test("deduplicates same rule matched by multiple paths", () => {
    const r = matchPolicyPaths(p, ["src/domain/ctc/a.ts", "src/domain/ctc/b.ts"]);
    expect(r.rules).toHaveLength(1);
  });

  test("includes domain-level required checks", () => {
    const r = matchPolicyPaths(p, ["src/domain/ctc/x.ts"]);
    expect(r.requiredChecks).toContain("vf skills facts check");
    expect(r.requiredChecks).toContain("vf skills impact src/domain/ctc/");
  });

  test("deduplicates and sorts required checks", () => {
    const dupPolicy = policy({
      domains: { ctc: { requiredChecks: ["b", "a"] } },
      protectedPaths: [
        { pattern: "src/a/**", requiredChecks: ["b", "a", "b"] },
        { pattern: "src/b/**", requiredChecks: ["c"] },
      ],
    });
    const r = matchPolicyPaths(dupPolicy, ["src/a/x.ts", "src/b/y.ts"]);
    expect(r.requiredChecks).toEqual(["a", "b", "c"]);
  });

  test("unrelated path returns no rules or checks", () => {
    const r = matchPolicyPaths(p, ["src/unrelated/file.ts"]);
    expect(r.rules).toEqual([]);
    expect(r.requiredChecks).toEqual([]);
  });

  test("handles special regex chars in pattern", () => {
    const specialPolicy = policy({
      protectedPaths: [{ pattern: "src/foo+.ts" }],
    });
    const r = matchPolicyPaths(specialPolicy, ["src/foo+.ts"]);
    expect(r.rules).toHaveLength(1);
  });

  test("normalises backslashes in changed paths", () => {
    const r = matchPolicyPaths(p, ["src/domain/ctc/x.ts"]);
    expect(r.rules).toHaveLength(1);
  });

  test("unrelated path with backslash normalisation", () => {
    const r = matchPolicyPaths(p, ["src/domain/ctc/x.ts"]);
    const r2 = matchPolicyPaths(p, ["src/domain/ctc/x.ts"]);
    expect(r).toEqual(r2);
  });
});
