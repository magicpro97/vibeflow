import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import { handleProposeMergeSubcommand, proposeMerge } from "../src/skills/propose-merge.js";

const CTX_DIR = ".vibeflow";
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-propose-merge-"));
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
    return skills("propose-merge", rest);
  } finally {
    process.chdir(orig);
    if (origHome === undefined) process.env.VF_SKILLS_HOME = undefined;
    else process.env.VF_SKILLS_HOME = origHome;
  }
}

// ── Basic merge ─────────────────────────────────────────────────────────

describe("proposeMerge", () => {
  test("merges two skills with triggers", () => {
    scaffold("skill-a", { triggers: ["react", "jsx"] });
    scaffold("skill-b", { triggers: ["react", "hooks"] });
    const r = proposeMerge(base, "skill-a", "skill-b");
    expect(r.errors).toEqual([]);
    expect(r.proposal).not.toBeNull();
    if (!r.proposal) throw new Error("expected proposal");
    const p = r.proposal;
    expect(p.mergedName).toBe("skill-a-skill-b");
    expect(p.sources.sort()).toEqual(["skill-a", "skill-b"]);
    // triggers union
    expect(p.skillMd).toContain("react");
    expect(p.skillMd).toContain("jsx");
    expect(p.skillMd).toContain("hooks");
    // replaces metadata
    expect(p.replaces["skill-a"]).toBe("skill-a-skill-b");
    expect(p.replaces["skill-b"]).toBe("skill-a-skill-b");
    // deprecation stubs
    expect(p.deprecationStubs).toHaveLength(2);
    const names = p.deprecationStubs.map((s) => s.name).sort();
    expect(names).toEqual(["skill-a", "skill-b"]);
    expect(p.deprecationStubs[0]?.skillMd).toContain("status: deprecated");
    expect(p.deprecationStubs[0]?.skillMd).toContain("supersedes: skill-a-skill-b");
    // eval plan
    expect(p.evalPlan).toContain("Eval plan for merged skill");
    expect(p.evalPlan).toContain("skill-a-skill-b");
  });

  test("merges capabilities union", () => {
    scaffold("a", { capabilities: ["cap1", "cap2"] });
    scaffold("b", { capabilities: ["cap2", "cap3"] });
    const r = proposeMerge(base, "a", "b");
    expect(r.errors).toEqual([]);
    expect(r.proposal?.skillMd).toContain("cap1");
    expect(r.proposal?.skillMd).toContain("cap2");
    expect(r.proposal?.skillMd).toContain("cap3");
  });

  test("merges body sections via heading match", () => {
    const bodyA = "## Setup\nnpm install.\n\n## Build\nRun build.\n\n";
    const bodyB = "## Setup\nuse yarn.\n\n## Deploy\nDeploy to prod.\n\n";
    scaffold("a", {}, bodyA);
    scaffold("b", {}, bodyB);
    const r = proposeMerge(base, "a", "b");
    expect(r.errors).toEqual([]);
    // Setup should be overridden by b (b wins due to alphabetically ordering)
    // Actually: first=a, second=b (alphabetical). mergeBodies applies second (b) as override.
    // So Setup should use b's version, Build from a, Deploy from b appended.
    // In mergeBodies: adapterBody is the second one passed, and it replaces matching headings in baseBody.
    // We call mergeBodies(firstMd.body, secondMd.body) where first=a, second=b.
    // So a.body is base, b.body is adapter. "Setup" heading matches → b's version used.
    expect(r.proposal?.skillMd).toContain("use yarn");
    expect(r.proposal?.skillMd).toContain("Run build");
    expect(r.proposal?.skillMd).toContain("Deploy to prod");
  });

  test("exit code 0 on success via CLI", () => {
    scaffold("skill-a", { triggers: ["react"] });
    scaffold("skill-b", { triggers: ["hooks"] });
    expect(run(["skill-a", "skill-b"])).toBe(0);
  });
});

// ── Error cases ─────────────────────────────────────────────────────────

describe("proposeMerge errors", () => {
  test("first unknown skill returns error", () => {
    scaffold("a", { triggers: ["x"] });
    const r = proposeMerge(base, "nonexistent", "a");
    expect(r.errors.some((e) => e.includes("Unknown skill"))).toBe(true);
    expect(r.proposal).toBeNull();
    expect(r.exitCode).toBe(2);
  });

  test("unreadable source skills return errors", () => {
    scaffold("a", { triggers: ["x"] });
    scaffold("b", { triggers: ["y"] });
    const r = proposeMerge(base, "a", "b", {
      readFileSync: () => {
        throw new Error("no read");
      },
    });
    expect(r.errors).toHaveLength(2);
    expect(r.exitCode).toBe(1);
  });

  test("second malformed skill name errors", () => {
    scaffold("a", { triggers: ["x"] });
    const r = proposeMerge(base, "a", "Bad Name!");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.exitCode).toBe(2);
  });

  test("path traversal rejected", () => {
    scaffold("a", { triggers: ["x"] });
    const r = proposeMerge(base, "../../etc", "a");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.exitCode).toBe(2);
  });

  test("self-merge rejected", () => {
    scaffold("a", { triggers: ["x"] });
    const r = proposeMerge(base, "a", "a");
    expect(r.errors.some((e) => e.includes("itself"))).toBe(true);
    expect(r.exitCode).toBe(2);
  });

  test("missing CLI args", () => {
    scaffold("a", {});
    expect(run([])).toBe(2);
    expect(run(["a"])).toBe(2);
  });

  test("CLI returns nonzero on unknown skill", () => {
    scaffold("a", { triggers: ["x"] });
    expect(run(["a", "nonexistent"])).toBe(2);
  });
});

// ── Output content ──────────────────────────────────────────────────────

describe("proposeMerge output", () => {
  test("output contains deprecation stubs", () => {
    scaffold("a", { triggers: ["x"] });
    scaffold("b", { triggers: ["y"] });
    const r = proposeMerge(base, "a", "b");
    expect(r.proposal?.deprecationStubs[0]?.skillMd).toContain("status: deprecated");
  });

  test("output contains replaces metadata", () => {
    scaffold("a", { triggers: ["x"] });
    scaffold("b", { triggers: ["y"] });
    const r = proposeMerge(base, "a", "b");
    expect(Object.keys(r.proposal?.replaces ?? {}).sort()).toEqual(["a", "b"]);
  });

  test("output contains eval plan", () => {
    scaffold("a", { triggers: ["x"] });
    scaffold("b", { triggers: ["y"] });
    const r = proposeMerge(base, "a", "b");
    expect(r.proposal?.evalPlan).toContain("Eval plan");
    expect(r.proposal?.evalPlan).toContain("Trigger union");
    expect(r.proposal?.evalPlan).toContain("Deprecation gate");
  });

  test("single skill returns zero findings (no comparison)", () => {
    scaffold("a", { triggers: ["x"] });
    expect(run(["a", "nonexistent"])).toBe(2);
  });
});

// ── Ordering stability ──────────────────────────────────────────────────

describe("proposeMerge stability", () => {
  test("output is deterministic regardless of input order", () => {
    scaffold("a-skill", { triggers: ["react"] });
    scaffold("b-skill", { triggers: ["hooks"] });
    const r1 = proposeMerge(base, "a-skill", "b-skill");
    const r2 = proposeMerge(base, "b-skill", "a-skill");
    expect(r1.proposal?.mergedName).toBe(r2.proposal?.mergedName);
    expect(r1.proposal?.sources).toEqual(r2.proposal?.sources);
    expect(r1.proposal?.replaces).toEqual(r2.proposal?.replaces);
  });
});
