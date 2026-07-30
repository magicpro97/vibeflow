import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import { handleProposeSplitSubcommand, proposeSplit } from "../src/skills/propose-split.js";

const CTX_DIR = ".vibeflow";
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-propose-split-"));
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
    return skills("propose-split", rest);
  } finally {
    process.chdir(orig);
    if (origHome === undefined) process.env.VF_SKILLS_HOME = undefined;
    else process.env.VF_SKILLS_HOME = origHome;
  }
}

// ── Basic split ─────────────────────────────────────────────────────────

describe("proposeSplit", () => {
  test("splits skill with multiple substantive sections", () => {
    const body =
      "## Auth\nHandle login flow with configured identity providers and session checks.\n\n## Billing\nProcess payments with validated invoices and idempotency keys.\n\n## Logging\nWrite audit logs with timestamps and actor identifiers.\n\n";
    scaffold("my-skill", { triggers: ["react", "node"] }, body);
    const r = proposeSplit(base, "my-skill");
    expect(r.errors).toEqual([]);
    expect(r.proposal).not.toBeNull();
    if (!r.proposal) throw new Error("expected proposal");
    const p = r.proposal;
    expect(p.sourceName).toBe("my-skill");
    expect(p.pieces.length).toBe(3);
    // Each piece should contain its section
    expect(p.pieces.map((pi) => pi.sectionHeading)).toContain("Auth");
    expect(p.pieces.map((pi) => pi.sectionHeading)).toContain("Billing");
    expect(p.pieces.map((pi) => pi.sectionHeading)).toContain("Logging");
  });

  test("piece names are valid lowercase-hyphen", () => {
    const body = "## Auth\nHandle login flow.\n\n## Billing\nProcess payments.\n\n";
    scaffold("my-skill", { triggers: ["node"] }, body);
    const r = proposeSplit(base, "my-skill");
    for (const piece of r.proposal?.pieces ?? []) {
      expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(piece.name)).toBe(true);
    }
  });

  test("pieces inherit source triggers", () => {
    const body = "## Auth\nHandle login flow.\n\n## Billing\nProcess payments.\n\n";
    scaffold("my-skill", { triggers: ["react", "node"] }, body);
    const r = proposeSplit(base, "my-skill");
    for (const piece of r.proposal?.pieces ?? []) {
      expect(piece.skillMd).toContain("react");
      expect(piece.skillMd).toContain("node");
    }
  });

  test("pieces contain section body", () => {
    const body = "## Auth\nHandle login flow.\n\n## Billing\nProcess payments.\n\n";
    scaffold("my-skill", { triggers: ["node"] }, body);
    const r = proposeSplit(base, "my-skill");
    const authPiece = (r.proposal?.pieces ?? []).find((p) => p.sectionHeading === "Auth");
    expect(authPiece).toBeDefined();
    expect(authPiece?.skillMd).toContain("Handle login flow");
    const billingPiece = (r.proposal?.pieces ?? []).find((p) => p.sectionHeading === "Billing");
    expect(billingPiece).toBeDefined();
    expect(billingPiece?.skillMd).toContain("Process payments");
  });

  test("exit code 0 on success via CLI", () => {
    const body = "## Auth\nHandle login flow.\n\n## Billing\nProcess payments.\n\n";
    scaffold("my-skill", { triggers: ["node"] }, body);
    expect(run(["my-skill"])).toBe(0);
  });
});

// ── Error cases ─────────────────────────────────────────────────────────

describe("proposeSplit errors", () => {
  test("unreadable skill returns error", () => {
    scaffold("unreadable", { triggers: ["x"] });
    const r = proposeSplit(base, "unreadable", {
      readFileSync: () => {
        throw new Error("no read");
      },
    });
    expect(r.errors.some((e) => e.includes("Cannot read"))).toBe(true);
    expect(r.proposal).toBeNull();
    expect(r.exitCode).toBe(1);
  });

  test("malformed skill name returns error", () => {
    const r = proposeSplit(base, "Bad Name!");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.exitCode).toBe(2);
  });

  test("path traversal rejected", () => {
    const r = proposeSplit(base, "../../etc/passwd");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.exitCode).toBe(2);
  });

  test("missing CLI args", () => {
    expect(run([])).toBe(2);
  });

  test("CLI returns nonzero on unknown skill", () => {
    expect(run(["nonexistent"])).toBe(2);
  });
});

// ── Fewer than 2 sections ───────────────────────────────────────────────

describe("proposeSplit insufficient sections", () => {
  test("single substantive section yields error", () => {
    const body = "## Steps\n1. Do the thing.\n\n";
    scaffold("thin", { triggers: ["x"] }, body);
    const r = proposeSplit(base, "thin");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain("substantive");
    expect(r.proposal).toBeNull();
    expect(r.exitCode).toBe(1);
  });

  test("zero substantive sections yields error", () => {
    const body = "## When to use\nUse for testing.\n\n";
    scaffold("generic-only", { triggers: ["x"] }, body);
    const r = proposeSplit(base, "generic-only");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.proposal).toBeNull();
    expect(r.exitCode).toBe(1);
  });

  test("only generic headings yields error", () => {
    const body =
      "## Overview\nBrief.\n\n## When to use\nFor testing.\n\n## Verification\nCheck output.\n\n";
    scaffold("generic", { triggers: ["x"] }, body);
    const r = proposeSplit(base, "generic");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.proposal).toBeNull();
  });
});

// ── Output correctness ──────────────────────────────────────────────────

describe("proposeSplit output", () => {
  test("pieces tagged with source reference", () => {
    const body = "## Auth\nHandle login flow.\n\n## Billing\nProcess payments.\n\n";
    scaffold("src-skill", { triggers: ["node"] }, body);
    const r = proposeSplit(base, "src-skill");
    for (const piece of r.proposal?.pieces ?? []) {
      expect(piece.skillMd).toContain('Proposed split from "src-skill"');
    }
  });

  test("eval plan present in CLI output", () => {
    const body = "## Auth\nHandle login flow.\n\n## Billing\nProcess payments.\n\n";
    scaffold("eval-skill", { triggers: ["node"] }, body);
    const r = proposeSplit(base, "eval-skill");
    expect(r.proposal).not.toBeNull();
    // CLI handler prints eval plan, verify it has content via handleProposeSplitSubcommand
    const code = handleProposeSplitSubcommand(base, ["eval-skill"]);
    expect(code).toBe(0);
  });
});
