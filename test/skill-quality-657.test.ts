import { describe, expect, test } from "bun:test";
import { checkPublishGate } from "../src/skills/publish-gate.js";
import {
  REQUIRED_SECTIONS,
  checkQualityContract,
  validateSkillDir,
} from "../src/skills/validator.js";

// ── checkQualityContract (pure) ────────────────────────────────────────────

function bodyWithSections(extra = ""): string {
  return [
    "## When to use",
    "Use for x.",
    "## When NOT to use",
    "Not for y.",
    "## Steps",
    "1. Do thing.",
    "## Verification",
    "Check output.",
    extra,
  ]
    .filter(Boolean)
    .join("\n");
}

describe("checkQualityContract", () => {
  test("passes clean body under 200 lines with all sections", () => {
    const r = checkQualityContract(bodyWithSections());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test("warns on body > 200 lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 210; i++) lines.push(`line ${i}`);
    const r = checkQualityContract(lines.join("\n"));
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("<= 200"))).toBe(true);
  });

  test("errors on body > 500 lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 510; i++) lines.push(`line ${i}`);
    const r = checkQualityContract(lines.join("\n"));
    expect(r.errors.some((e) => e.includes("max 500"))).toBe(true);
  });

  test("warns on missing each required section", () => {
    const noSections = "no markdown headings at all";
    const r = checkQualityContract(noSections);
    expect(r.errors).toEqual([]);
    for (const s of REQUIRED_SECTIONS) {
      expect(r.warnings.some((w) => w === `missing required section: ${s}`)).toBe(true);
    }
  });

  test("warns once per missing section only", () => {
    const onlySome = "## When to use\nUse case.\n## Verification\nCheck it.";
    const r = checkQualityContract(onlySome);
    const missing = REQUIRED_SECTIONS.filter((s) => s !== "when to use" && s !== "verification");
    for (const s of missing) {
      expect(r.warnings.some((w) => w === `missing required section: ${s}`)).toBe(true);
    }
    expect(r.warnings.filter((w) => w.startsWith("missing required section:")).length).toBe(
      missing.length,
    );
  });

  test("accepts H2 or H3 required sections with case-insensitive suffixes", () => {
    const body = [
      "### WHEN TO USE this skill",
      "Use.",
      "### When NOT to use:",
      "Dont.",
      "### Steps to follow",
      "Step.",
      "## verification:",
      "Verify.",
    ].join("\n");
    const r = checkQualityContract(body);
    expect(r.warnings.filter((w) => w.startsWith("missing required section:"))).toEqual([]);
  });

  test("warns on ALL-CAPS instruction blocks", () => {
    const body = [
      "## When to use",
      "Use for x.",
      "## When NOT to use",
      "Not for y.",
      "## Steps",
      "1. ALWAYS follow this order.",
      "## Verification",
      "Check output.",
    ].join("\n");
    const r = checkQualityContract(body);
    expect(r.warnings.some((w) => w.includes("ALL-CAPS"))).toBe(true);
  });

  test("empty body produces warnings (all sections missing, no caps)", () => {
    const r = checkQualityContract("");
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

// ── validateSkillDir integration (quality warnings pass through) ────────────

describe("validateSkillDir: quality contract integration", () => {
  function makeBody(sections: string[]): string {
    return sections.join("\n");
  }

  test("valid body with all sections: no quality warnings", () => {
    const r = validateSkillDir("/tmp", {
      existsSync: () => true,
      readFileSync: () =>
        [
          "---",
          "name: qc-skill",
          "description: test",
          "---",
          "",
          "# Skill",
          "",
          "## When to use",
          "Use case.",
          "## When NOT to use",
          "Not case.",
          "## Steps",
          "1. Do.",
          "## Verification",
          "Check.",
        ].join("\n"),
      readdirSync: () => [],
      statSync: () => ({ isDirectory: () => false }),
    });
    expect(r.ok).toBe(true);
    // quality warnings: none expected
    const qualityWarnings = r.warnings.filter(
      (w) =>
        w.includes("lines") || w.includes("missing required section") || w.includes("ALL-CAPS"),
    );
    expect(qualityWarnings).toEqual([]);
  });

  test("body > 200 lines: quality warning passes through validateSkillDir", () => {
    const bodyLines: string[] = [];
    for (let i = 0; i < 210; i++) bodyLines.push(`line ${i}`);
    const r = validateSkillDir("/tmp", {
      existsSync: () => true,
      readFileSync: () =>
        [
          "---",
          "name: long-skill",
          "description: test",
          "---",
          "",
          "## When to use",
          "Use.",
          "## When NOT to use",
          "Dont.",
          "## Steps",
          "Steps.",
          "## Verification",
          "Verify.",
          ...bodyLines,
        ].join("\n"),
      readdirSync: () => [],
      statSync: () => ({ isDirectory: () => false }),
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("lines"))).toBe(true);
  });

  test("body > 500 lines: error blocks validation", () => {
    const bodyLines: string[] = [];
    for (let i = 0; i < 510; i++) bodyLines.push(`line ${i}`);
    const r = validateSkillDir("/tmp", {
      existsSync: () => true,
      readFileSync: () =>
        [
          "---",
          "name: huge-skill",
          "description: test",
          "---",
          "",
          "## When to use",
          "Use.",
          "## When NOT to use",
          "Dont.",
          "## Steps",
          "Steps.",
          "## Verification",
          "Verify.",
          ...bodyLines,
        ].join("\n"),
      readdirSync: () => [],
      statSync: () => ({ isDirectory: () => false }),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("max 500"))).toBe(true);
  });

  test("missing sections: warns (does not fail) in validateSkillDir", () => {
    const r = validateSkillDir("/tmp", {
      existsSync: () => true,
      readFileSync: () =>
        [
          "---",
          "name: no-sections",
          "description: test",
          "---",
          "",
          "# Just a body with no required sections, but enough actionable explanatory text to pass the base validator.",
        ].join("\n"),
      readdirSync: () => [],
      statSync: () => ({ isDirectory: () => false }),
    });
    expect(r.ok).toBe(true);
    for (const s of REQUIRED_SECTIONS) {
      expect(r.warnings.some((w) => w === `missing required section: ${s}`)).toBe(true);
    }
  });
});

// ── checkPublishGate: quality contract hook on common channel ───────────────

describe("checkPublishGate: quality contract hook (#657)", () => {
  test("passes publish gate on clean body", () => {
    const r = checkPublishGate("/tmp", "common", {
      existsSync: () => true,
      readFileSync: () =>
        [
          "---",
          "name: clean",
          "description: test",
          "scope: common",
          "---",
          "",
          "## When to use",
          "Use.",
          "## When NOT to use",
          "Dont.",
          "## Steps",
          "1. Step.",
          "## Verification",
          "Verify.",
        ].join("\n"),
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.filter((w) => w.startsWith("quality:"))).toEqual([]);
  });

  test("blocks publish on body > 500 lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 510; i++) lines.push(`line ${i}`);
    const r = checkPublishGate("/tmp", "common", {
      existsSync: () => true,
      readFileSync: () =>
        [
          "---",
          "name: huge",
          "description: test",
          "scope: common",
          "---",
          "",
          "## When to use",
          "Use.",
          "## When NOT to use",
          "Dont.",
          "## Steps",
          "Steps.",
          "## Verification",
          "Verify.",
          ...lines,
        ].join("\n"),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith("quality:") && e.includes("max 500"))).toBe(true);
  });

  test("blocks publish on missing required sections", () => {
    const r = checkPublishGate("/tmp", "common", {
      existsSync: () => true,
      readFileSync: () =>
        [
          "---",
          "name: no-sections",
          "description: test",
          "scope: common",
          "---",
          "",
          "No proper sections here at all.",
        ].join("\n"),
    });
    expect(r.ok).toBe(false);
    for (const s of REQUIRED_SECTIONS) {
      expect(r.errors.some((e) => e === `quality: missing required section: ${s}`)).toBe(true);
    }
  });

  test("warns on ALL-CAPS in publish gate", () => {
    const r = checkPublishGate("/tmp", "common", {
      existsSync: () => true,
      readFileSync: () =>
        [
          "---",
          "name: caps-skill",
          "description: test",
          "scope: common",
          "---",
          "",
          "## When to use",
          "ALWAYS use this. NEVER skip it.",
          "## When NOT to use",
          "Not for y.",
          "## Steps",
          "1. Step.",
          "## Verification",
          "Check.",
        ].join("\n"),
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.startsWith("quality:") && w.includes("ALL-CAPS"))).toBe(true);
  });

  test("does not run quality gate on non-common channel", () => {
    const r = checkPublishGate("/tmp", "project", {
      existsSync: () => true,
      readFileSync: () =>
        [
          "---",
          "name: proj-skill",
          "description: test",
          "scope: project",
          "---",
          "",
          "No required sections but project channel skips quality gate.",
        ].join("\n"),
    });
    // Should pass because project channel doesn't check quality
    expect(r.ok).toBe(true);
    expect(r.warnings.filter((w) => w.startsWith("quality:"))).toEqual([]);
  });
});
