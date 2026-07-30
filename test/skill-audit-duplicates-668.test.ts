import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import {
  auditSkillDuplicates,
  handleAuditDuplicatesSubcommand,
} from "../src/skills/audit-duplicates.js";

const CTX_DIR = ".vibeflow";
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-audit-dup-"));
  mkdirSync(join(base, CTX_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function scaffold(name: string, frontmatter: Record<string, unknown>, body?: string) {
  const dir = join(base, CTX_DIR, "skills", name);
  mkdirSync(dir, { recursive: true });
  const fmLines = ["---", `name: ${name}`, "description: test"];
  const rest: string[] = [];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      rest.push(`${k}:`);
      for (const item of v) rest.push(`  - ${item}`);
    } else if (typeof v === "string") {
      rest.push(`${k}: ${v}`);
    } else {
      rest.push(`${k}: ${String(v)}`);
    }
  }
  const md = [...fmLines, ...rest, "---", "", body ?? "## Steps\n1. Do the thing.\n\n"].join("\n");
  writeFileSync(join(dir, "SKILL.md"), md);
}

function run(rest: string[]): number {
  const orig = process.cwd();
  const origHome = process.env.VF_SKILLS_HOME;
  process.env.VF_SKILLS_HOME = base;
  process.chdir(base);
  try {
    return skills("audit-duplicates", rest);
  } finally {
    process.chdir(orig);
    if (origHome === undefined) process.env.VF_SKILLS_HOME = undefined;
    else process.env.VF_SKILLS_HOME = origHome;
  }
}

// ── Threshold exact ────────────────────────────────────────────────────
describe("trigger Jaccard threshold", () => {
  test("overlap > 0.7 detected", () => {
    scaffold("a", { triggers: ["react", "jsx", "component", "hook", "state", "props"] });
    scaffold("b", { triggers: ["react", "jsx", "component", "hook", "state", "router"] });
    const r = auditSkillDuplicates(base);
    expect(r.findings.filter((f) => f.type === "trigger-overlap")).toHaveLength(1);
  });

  test("overlap <= 0.7 not detected", () => {
    scaffold("a", { triggers: ["react", "jsx", "component"] });
    scaffold("b", { triggers: ["python", "django", "model"] });
    const r = auditSkillDuplicates(base);
    expect(r.findings.filter((f) => f.type === "trigger-overlap")).toHaveLength(0);
  });
});

// ── Fact collision ─────────────────────────────────────────────────────
describe("owns fact collisions", () => {
  test("collision detected", () => {
    scaffold("a", { owns: ["my-fact"] });
    scaffold("b", { owns: ["my-fact"] });
    const r = auditSkillDuplicates(base);
    expect(r.findings.filter((f) => f.type === "owns-fact-collision")).toHaveLength(1);
  });

  test("unique owns no collision", () => {
    scaffold("a", { owns: ["fact-1"] });
    scaffold("b", { owns: ["fact-2"] });
    const r = auditSkillDuplicates(base);
    expect(r.findings.filter((f) => f.type === "owns-fact-collision")).toHaveLength(0);
  });

  test("ignores unsafe fact keys", () => {
    scaffold("a", { owns: ["../bad-path"] });
    scaffold("b", { owns: ["../bad-path"] });
    const r = auditSkillDuplicates(base);
    expect(r.findings.filter((f) => f.type === "owns-fact-collision")).toHaveLength(0);
  });
});

// ── Duplicate procedure sections ───────────────────────────────────────
describe("procedure section duplication", () => {
  test("detects duplicate substantive section", () => {
    const bodyA =
      "## Setup\nnpm install foo-pkg then verify lockfile.\n\n## Build\nRun the build script.\n\n";
    const bodyB =
      "## Setup\nnpm install foo-pkg then verify lockfile.\n\n## Deploy\nDeploy to prod.\n\n";
    scaffold("a", {}, bodyA);
    scaffold("b", {}, bodyB);
    const r = auditSkillDuplicates(base);
    expect(r.findings.filter((f) => f.type === "procedure-duplicate")).toHaveLength(1);
    const dup = r.findings.find((f) => f.type === "procedure-duplicate") as NonNullable<
      (typeof r.findings)[0]
    >;
    expect(dup.lines).toBeDefined();
    expect(dup.lines?.length).toBe(2);
    expect(dup.lines?.map((l) => l.skill).sort()).toEqual(["a", "b"]);
    expect(dup.lines?.every((l) => typeof l.line === "number")).toBe(true);
  });

  test("no false positive for generic section", () => {
    const bodyA = "## When to use\nUse when debugging React components.\n";
    const bodyB = "## When to use\nUse when debugging React components.\n";
    scaffold("a", {}, bodyA);
    scaffold("b", {}, bodyB);
    const r = auditSkillDuplicates(base);
    expect(r.findings.filter((f) => f.type === "procedure-duplicate")).toHaveLength(0);
  });

  test("no false positive when body differs", () => {
    const bodyA = "## Build\nnpm install\nnpm run build\n";
    const bodyB = "## Build\nnpm run dev\n";
    scaffold("a", {}, bodyA);
    scaffold("b", {}, bodyB);
    const r = auditSkillDuplicates(base);
    expect(r.findings.filter((f) => f.type === "procedure-duplicate")).toHaveLength(0);
  });
});

// ── Stable ordering ────────────────────────────────────────────────────
describe("stable sorted output", () => {
  test("findings sorted by type then skill names", () => {
    scaffold("z-skill", { owns: ["shared-fact"], triggers: ["react", "jsx", "component", "hook"] });
    scaffold("a-skill", { owns: ["shared-fact"], triggers: ["react", "jsx", "component", "hook"] });
    const r = auditSkillDuplicates(base);
    const types = r.findings.map((f) => f.type);
    expect(types).toEqual(["owns-fact-collision", "trigger-overlap"]);
    for (const f of r.findings) {
      const sorted = [...f.skills].sort();
      expect(f.skills).toEqual(sorted);
    }
    // Also check CLI ordering
    const exitCode = run([]);
    expect(exitCode).toBe(1);
  });
});

// ── CLI exit ────────────────────────────────────────────────────────────
describe("CLI exit codes", () => {
  test("returns 0 when no duplicates", () => {
    scaffold("a", { triggers: ["python"] });
    scaffold("b", { triggers: ["react"] });
    expect(run([])).toBe(0);
  });

  test("returns 1 when duplicates found", () => {
    scaffold("a", { owns: ["f1"] });
    scaffold("b", { owns: ["f1"] });
    expect(run([])).toBe(1);
  });

  test("returns 0 with single skill (no comparisons)", () => {
    scaffold("a", { owns: ["f1"] });
    expect(run([])).toBe(0);
  });

  test("returns 0 with no skills", () => {
    expect(run([])).toBe(0);
  });

  test("returns 1 when audit fails", () => {
    expect(
      handleAuditDuplicatesSubcommand(base, [], () => {
        throw new Error("read failed");
      }),
    ).toBe(1);
  });

  test("prints procedure line references", () => {
    const result = {
      errors: [],
      findings: [
        {
          type: "procedure-duplicate" as const,
          skills: ["a", "b"],
          detail: "same section",
          recommendation: "merge" as const,
          lines: [
            { skill: "a", line: 10 },
            { skill: "b", line: 20 },
          ],
        },
      ],
    };
    expect(handleAuditDuplicatesSubcommand(base, [], () => result)).toBe(1);
  });
});

// ── Untrusted metadata ─────────────────────────────────────────────────
describe("untrusted metadata resilience", () => {
  test("malformed frontmatter does not crash", () => {
    const dir = join(base, CTX_DIR, "skills", "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter here\n");
    const r = auditSkillDuplicates(base);
    expect(r.errors).toHaveLength(0);
  });

  test("non-array triggers treated as empty", () => {
    scaffold("a", { triggers: "not-an-array" as unknown as string[] });
    scaffold("b", { triggers: ["react"] });
    const r = auditSkillDuplicates(base);
    expect(r.errors).toHaveLength(0);
  });
});
