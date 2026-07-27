import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import { checkDomainOwnership, parseDomainMeta } from "../src/skills/domain.js";
import { validateSkillDir } from "../src/skills/validator.js";

const CTX_DIR = ".vibeflow";
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-domain-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function scaffold(name: string, lines: string[]): string {
  const dir = join(base, CTX_DIR, "skills", name);
  mkdirSync(dir, { recursive: true });
  const md = join(dir, "SKILL.md");
  writeFileSync(md, lines.join("\n"));
  return dir;
}

const VALID_BODY = [
  "",
  "## When to use",
  "Use when x.",
  "## When NOT to use",
  "Do not use when y.",
  "## Steps",
  "1. Do the task.",
  "## Verification",
  "Check output.",
  "",
];

function fm(lines: string[]): string[] {
  return ["---", ...lines, "---", ...VALID_BODY];
}

function validate(name: string, lines: string[]) {
  const dir = scaffold(name, lines);
  return validateSkillDir(dir, {
    existsSync: (p: string) => p === join(dir, "SKILL.md"),
    readFileSync: (p: string) => {
      const { readFileSync: fs } = require("node:fs");
      return fs(p, "utf8");
    },
    readdirSync: () => [],
    statSync: () => ({ isDirectory: () => false }),
  });
}

// ── validateSkillDir: frontmatter domain validation ─────────────────────
describe("validateSkillDir domain keys", () => {
  test("domain.id valid kebab-case produces no warning", () => {
    const r = validate("good", fm(["name: good", "description: d", "domain.id: my-domain"]));
    expect(r.ok).toBe(true);
    expect(r.warnings.filter((w) => w.includes("domain.id"))).toHaveLength(0);
  });

  test("domain.id malformed produces warning", () => {
    const r = validate("bad-id", fm(["name: bad-id", "description: d", "domain.id: BadID"]));
    expect(r.warnings.some((w) => w.includes("domain.id must be lowercase"))).toBe(true);
  });

  test("domain.id non-string produces warning", () => {
    const r = validate("num-id", fm(["name: num-id", "description: d", "domain.id: 123"]));
    // 123 is a number, non-string — but regex test on number coerces to "123" which passes
    // Actually YAML parses 123 as number, domain.id will be 123 (number) — typeof fails
    expect(r.warnings.some((w) => w.includes("domain.id must be lowercase"))).toBe(true);
  });

  test("domain.role valid canonical produces no warning", () => {
    const r = validate("canon", fm(["name: canon", "description: d", "domain.role: canonical"]));
    expect(r.warnings.filter((w) => w.includes("domain.role"))).toHaveLength(0);
  });

  test("domain.role valid child produces no warning", () => {
    const r = validate("kid", fm(["name: kid", "description: d", "domain.role: child"]));
    expect(r.warnings.filter((w) => w.includes("domain.role"))).toHaveLength(0);
  });

  test("domain.role invalid value produces warning", () => {
    const r = validate("bad-role", fm(["name: bad-role", "description: d", "domain.role: master"]));
    expect(r.warnings.some((w) => w.includes('domain.role must be "canonical" or "child"'))).toBe(
      true,
    );
  });

  test("owns valid array produces no warning", () => {
    const r = validate(
      "owns-ok",
      fm(["name: owns-ok", "description: d", "owns:", "  - fact-1", "  - fact-2"]),
    );
    expect(r.warnings.filter((w) => w.includes("owns"))).toHaveLength(0);
  });

  test("owns non-array produces warning", () => {
    const r = validate("owns-bad", fm(["name: owns-bad", "description: d", "owns: not-an-array"]));
    expect(r.warnings.some((w) => w.includes("owns must be an array"))).toBe(true);
  });

  test("dependsOn valid array produces no warning", () => {
    const r = validate(
      "dep-ok",
      fm(["name: dep-ok", "description: d", "dependsOn:", "  - skill-1"]),
    );
    expect(r.warnings.filter((w) => w.includes("dependsOn"))).toHaveLength(0);
  });

  test("dependsOn non-array produces warning", () => {
    const r = validate("dep-bad", fm(["name: dep-bad", "description: d", "dependsOn: 42"]));
    expect(r.warnings.some((w) => w.includes("dependsOn must be an array"))).toBe(true);
  });

  test("domain keys are not flagged as non-standard frontmatter", () => {
    const r = validate(
      "std",
      fm([
        "name: std",
        "description: d",
        "domain.id: x",
        "domain.role: canonical",
        "owns:",
        "  - f1",
        "dependsOn:",
        "  - s1",
      ]),
    );
    expect(r.warnings.filter((w) => w.includes("non-standard"))).toHaveLength(0);
  });

  test("no domain keys is backward compatible", () => {
    const r = validate("plain", fm(["name: plain", "description: d"]));
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
});

// ── checkDomainOwnership ─────────────────────────────────────────────────
describe("checkDomainOwnership", () => {
  function mkResult(
    name: string,
    lines: string[],
  ): Parameters<typeof checkDomainOwnership>[0][number] {
    const dir = scaffold(name, lines);
    const r = validateSkillDir(dir, {
      existsSync: (p: string) => {
        try {
          require("node:fs").statSync(p);
          return true;
        } catch {
          return false;
        }
      },
      readFileSync: (p: string) => require("node:fs").readFileSync(p, "utf8"),
      readdirSync: () => [],
      statSync: () => ({ isDirectory: () => false }),
    });
    return r;
  }

  test("single canonical per domain passes", () => {
    const s1 = mkResult(
      "canon-a",
      fm(["name: canon-a", "description: d", "domain.id: auth", "domain.role: canonical"]),
    );
    const r = checkDomainOwnership([s1]);
    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  test("duplicate canonical for same domain.id errors", () => {
    const s1 = mkResult(
      "canon-a1",
      fm(["name: canon-a1", "description: d", "domain.id: auth", "domain.role: canonical"]),
    );
    const s2 = mkResult(
      "canon-a2",
      fm(["name: canon-a2", "description: d", "domain.id: auth", "domain.role: canonical"]),
    );
    const r = checkDomainOwnership([s1, s2]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("auth");
    expect(r.errors[0]).toContain("2 canonical");
  });

  test("child with dependsOn referencing missing canonical warns", () => {
    const s1 = mkResult(
      "child-nope",
      fm([
        "name: child-nope",
        "description: d",
        "domain.id: ui",
        "domain.role: child",
        "dependsOn:",
        "  - auth",
      ]),
    );
    const r = checkDomainOwnership([s1]);
    expect(r.warnings.some((w) => w.includes("auth") && w.includes("no canonical owner"))).toBe(
      true,
    );
  });

  test("child with dependsOn referencing existing canonical is clean", () => {
    const s1 = mkResult(
      "canon-core",
      fm(["name: canon-core", "description: d", "domain.id: core", "domain.role: canonical"]),
    );
    const s2 = mkResult(
      "child-ui",
      fm([
        "name: child-ui",
        "description: d",
        "domain.id: ui",
        "domain.role: child",
        "dependsOn:",
        "  - core",
      ]),
    );
    const r = checkDomainOwnership([s1, s2]);
    expect(r.errors).toHaveLength(0);
    expect(r.warnings.filter((w) => w.includes("no canonical owner"))).toHaveLength(0);
  });

  test("child role with empty dependsOn warns", () => {
    const s1 = mkResult(
      "orphan-child",
      fm(["name: orphan-child", "description: d", "domain.id: x", "domain.role: child"]),
    );
    const r = checkDomainOwnership([s1]);
    expect(r.warnings.some((w) => w.includes('role "child"') && w.includes("no dependsOn"))).toBe(
      true,
    );
  });

  test("child role with dependsOn does not warn about empty", () => {
    const s1 = mkResult(
      "canon-p",
      fm(["name: canon-p", "description: d", "domain.id: parent", "domain.role: canonical"]),
    );
    const s2 = mkResult(
      "child-with-dep",
      fm([
        "name: child-with-dep",
        "description: d",
        "domain.id: child",
        "domain.role: child",
        "dependsOn:",
        "  - parent",
      ]),
    );
    const r = checkDomainOwnership([s1, s2]);
    expect(r.warnings.filter((w) => w.includes("no dependsOn"))).toHaveLength(0);
  });

  test("non-ok skills are skipped", () => {
    const r = checkDomainOwnership([
      { ok: false, dir: "/nope", errors: ["missing"], warnings: [] },
    ]);
    expect(r.errors).toHaveLength(0);
  });

  test("no domain keys at all passes cleanly", () => {
    const s1 = mkResult("plain", fm(["name: plain", "description: d"]));
    const r = checkDomainOwnership([s1]);
    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });
});

// ── vf skills domain list (CLI) ──────────────────────────────────────────
describe("vf skills domain list", () => {
  function run(rest: string[]): number {
    const orig = process.cwd();
    const origHome = process.env.VF_SKILLS_HOME;
    process.env.VF_SKILLS_HOME = base;
    process.chdir(base);
    try {
      return skills("domain", rest);
    } finally {
      process.chdir(orig);
      if (origHome === undefined) process.env.VF_SKILLS_HOME = undefined;
      else process.env.VF_SKILLS_HOME = origHome;
    }
  }

  function mkSkill(name: string, lines: string[]) {
    scaffold(name, fm(lines));
  }

  test("no skills discovered returns 0", () => {
    expect(run(["list"])).toBe(0);
  });

  test("no domain.id skills returns 0", () => {
    mkSkill("plain", ["name: plain", "description: d"]);
    expect(run(["list"])).toBe(0);
  });

  test("prints hierarchy for canonical + child", () => {
    mkSkill("canon-auth", [
      "name: canon-auth",
      "description: d",
      "domain.id: auth",
      "domain.role: canonical",
      "owns:",
      "  - login",
      "  - sso",
    ]);
    mkSkill("child-login", [
      "name: child-login",
      "description: d",
      "domain.id: auth",
      "domain.role: child",
      "dependsOn:",
      "  - auth",
    ]);
    expect(run(["list"])).toBe(0);
  });

  test("duplicate canonical returns 1", () => {
    mkSkill("canon-a1", [
      "name: canon-a1",
      "description: d",
      "domain.id: dup",
      "domain.role: canonical",
    ]);
    mkSkill("canon-a2", [
      "name: canon-a2",
      "description: d",
      "domain.id: dup",
      "domain.role: canonical",
    ]);
    expect(run(["list"])).toBe(1);
  });

  test("missing subcommand returns 2", () => {
    expect(run([])).toBe(2);
  });

  test("unknown subsubcommand returns 2", () => {
    expect(run(["unknown"])).toBe(2);
  });

  test("prints noDomain footer when mixing domain and plain skills", () => {
    mkSkill("canon-auth", [
      "name: canon-auth",
      "description: d",
      "domain.id: auth",
      "domain.role: canonical",
    ]);
    mkSkill("plain-one", ["name: plain-one", "description: d"]);
    expect(run(["list"])).toBe(0);
  });
});

// ── parseDomainMeta (nested object form) ─────────────────────────────────
describe("parseDomainMeta", () => {
  test("nested domain object with id + role", () => {
    const r = parseDomainMeta({ domain: { id: "auth", role: "canonical" } });
    expect(r.domain?.id).toBe("auth");
    expect(r.domain?.role).toBe("canonical");
  });

  test("nested domain object with invalid role coerces role to undefined", () => {
    const r = parseDomainMeta({ domain: { id: "auth", role: "master" } });
    expect(r.domain?.id).toBe("auth");
    expect(r.domain?.role).toBeUndefined();
  });

  test("nested domain object with non-string id coerces id to undefined", () => {
    const r = parseDomainMeta({ domain: { id: 123, role: "child" } });
    expect(r.domain?.id).toBeUndefined();
    expect(r.domain?.role).toBe("child");
  });

  test("dot-notation fallback when domain is not an object", () => {
    const r = parseDomainMeta({ "domain.id": "ui", "domain.role": "child" });
    expect(r.domain?.id).toBe("ui");
    expect(r.domain?.role).toBe("child");
  });

  test("owns and dependsOn arrays are parsed", () => {
    const r = parseDomainMeta({ owns: ["f1", "f2"], dependsOn: ["s1"] });
    expect(r.owns).toEqual(["f1", "f2"]);
    expect(r.dependsOn).toEqual(["s1"]);
  });

  test("no domain metadata yields undefined domain", () => {
    const r = parseDomainMeta({ name: "x" });
    expect(r.domain).toBeUndefined();
  });
});
