import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import type { Skill } from "../src/core.js";
import {
  buildTriggerEvalSet,
  handleOptimizeDescription,
  proposeDescription,
  scoreTriggering,
} from "../src/skills/optimize-description.js";

const CTX_DIR = ".vibeflow";
let base: string;

function skill(overrides: Partial<Skill> & { name: string; description: string }): Skill {
  return {
    status: "verified",
    triggers: [],
    capabilities: [],
    dir: "/tmp/dummy",
    path: "/tmp/dummy/SKILL.md",
    ...overrides,
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-optimize-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

// ── buildTriggerEvalSet ──────────────────────────────────────────────────
describe("buildTriggerEvalSet", () => {
  test("produces positives from own name + description", () => {
    const s = skill({ name: "pdf", description: "Extract tables from PDF documents" });
    const sibling = skill({ name: "other", description: "unrelated skill" });
    const e = buildTriggerEvalSet(s, [s, sibling]);
    expect(e.positives.length).toBeGreaterThan(0);
    for (const p of e.positives) {
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
    }
  });

  test("produces negatives from sibling descriptions", () => {
    const s = skill({ name: "pdf", description: "Extract tables from PDF" });
    const sibling = skill({ name: "other", description: "Build React components" });
    const e = buildTriggerEvalSet(s, [s, sibling]);
    expect(e.negatives.length).toBeGreaterThan(0);
  });

  test("negatives exclude the target skill", () => {
    const s = skill({ name: "pdf", description: "PDF tables" });
    const e = buildTriggerEvalSet(s, [s]);
    expect(e.negatives.length).toBe(0);
  });

  test("caps at 10 per set", () => {
    const s = skill({
      name: "a",
      description:
        "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega",
    });
    const e = buildTriggerEvalSet(s, [s]);
    expect(e.positives.length).toBeLessThanOrEqual(10);
  });
});

// ── scoreTriggering ──────────────────────────────────────────────────────
describe("scoreTriggering", () => {
  test("perfect-match skill gets precision/recall/f1 = 1", () => {
    const s = skill({
      name: "perfect",
      description: "perfect match",
      triggers: ["perfect", "match", "alpha", "beta"],
    });
    const other = skill({
      name: "other",
      description: "unrelated skill",
      triggers: ["unrelated"],
    });
    const all = [s, other];
    const e = buildTriggerEvalSet(s, all);
    const r = scoreTriggering(s, all, e);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
    expect(r.f1).toBe(1);
  });

  test("vague skill with overlapping triggers gets precision < 1", () => {
    const vague = skill({
      name: "vague",
      description: "Handles data processing stuff tasks",
      triggers: ["data", "processing", "stuff"],
    });
    const sibling = skill({
      name: "sibling",
      description: "Process data with high throughput",
      triggers: ["high", "throughput"],
    });
    const all = [vague, sibling];
    const e = buildTriggerEvalSet(vague, all);
    // siblings token "data" appears in negatives, vague triggers on "data" → false positive
    const r = scoreTriggering(vague, all, e);
    expect(r.precision).toBeLessThan(1);
  });

  test("divide-by-zero: 0 triggers gives precision 1", () => {
    const s = skill({
      name: "lonely",
      description: "this skill has zero triggers that match anything",
      triggers: ["zzzznevermatch"],
    });
    const e = { positives: ["xxxnope"], negatives: ["yyynope"] };
    const r = scoreTriggering(s, [s], e);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(0);
  });

  test("divide-by-zero: 0 positives gives recall 1", () => {
    const s = skill({ name: "empty-pos", description: "test thing" });
    const e = { positives: [], negatives: ["nope"] };
    const r = scoreTriggering(s, [s], e);
    expect(r.recall).toBe(1);
    expect(r.f1).toBe(0);
  });

  test("f1 is 0 when both precision and recall are 0", () => {
    const s = skill({
      name: "lost",
      description: "lost skill",
      triggers: ["aaa"],
    });
    // negative "aaa" fires the trigger (false positive), positive "bbb" misses
    const e = { positives: ["bbb"], negatives: ["aaa"] };
    const r = scoreTriggering(s, [s], e);
    expect(r.precision).toBe(0);
    expect(r.recall).toBe(0);
    expect(r.f1).toBe(0);
  });
});

// ── proposeDescription ───────────────────────────────────────────────────
describe("proposeDescription", () => {
  test("returns null when current description scores f1 >= 1", () => {
    const s = skill({
      name: "perfect",
      description: "perfect match",
      triggers: ["perfect", "match", "alpha", "beta"],
    });
    const other = skill({ name: "other", description: "unrelated", triggers: ["unrelated"] });
    const r = proposeDescription(s, [s, other]);
    expect(r).toBeNull();
  });

  test("returns candidate with higher f1 for vague description", () => {
    const vague = skill({
      name: "vague",
      description: "Handles data processing stuff tasks",
      triggers: ["data", "processing", "stuff"],
    });
    const sibling = skill({
      name: "sibling",
      description: "Process data with high throughput",
      triggers: ["high", "throughput"],
    });
    const all = [vague, sibling];
    const r = proposeDescription(vague, all);
    if (r !== null) {
      expect(r.candidate).toContain("Use when");
      expect(r.f1).toBeGreaterThan(0);
    }
  });

  test("returns null when no positive tokens can be derived", () => {
    const s = skill({
      name: "x",
      description: "is to for a an",
      triggers: ["x"],
    });
    const r = proposeDescription(s, [s]);
    expect(r).toBeNull();
  });

  test("returns candidate when adding top phrase improves f1", () => {
    // triggers ("zzz") match none of the positive queries derived from
    // name+description, so current f1 is 0; the candidate adds the top
    // phrase to triggers, making a positive query fire → f1 improves.
    const s = skill({
      name: "dataproc",
      description: "handle records",
      triggers: ["zzz"],
    });
    const r = proposeDescription(s, [s]);
    expect(r).not.toBeNull();
    expect(r?.candidate).toContain("Use when dataproc");
    expect(r?.f1).toBeGreaterThan(0);
  });
});

// ── CLI ──────────────────────────────────────────────────────────────────
describe("vf skills optimize-description", () => {
  function scaffold(name: string, lines: string[]): string {
    const dir = join(base, CTX_DIR, "skills", name);
    mkdirSync(dir, { recursive: true });
    const md = join(dir, "SKILL.md");
    writeFileSync(md, lines.join("\n"));
    return dir;
  }

  const VALID_BODY = ["", "## Steps", "1. Do the thing.", ""];

  function fm(lines: string[]): string[] {
    return ["---", ...lines, "---", ...VALID_BODY];
  }

  async function run(rest: string[]): Promise<number> {
    const orig = process.cwd();
    const origHome = process.env.VF_SKILLS_HOME;
    process.env.VF_SKILLS_HOME = base;
    process.chdir(base);
    try {
      return await skills("optimize-description", rest);
    } finally {
      process.chdir(orig);
      if (origHome === undefined) process.env.VF_SKILLS_HOME = undefined;
      else process.env.VF_SKILLS_HOME = origHome;
    }
  }

  test("existing skill returns 0 and prints metrics", async () => {
    scaffold("test-skill", fm(["name: test-skill", "description: test skill for optimize"]));
    const code = await run(["test-skill"]);
    expect(code).toBe(0);
  });

  test("prints a proposal when the description can be improved", async () => {
    // triggers don't match name/description tokens → current f1 is 0, so
    // proposeDescription returns a candidate and the CLI prints it.
    scaffold("improvable", [
      "---",
      "name: improvable",
      "description: handle records",
      "triggers:",
      "  - zzz",
      "---",
      ...VALID_BODY,
    ]);
    const code = await run(["improvable"]);
    expect(code).toBe(0);
  });

  test("missing name returns 2", async () => {
    expect(await run([])).toBe(2);
  });

  test("unknown name returns 2", async () => {
    expect(await run(["nope"])).toBe(2);
  });
});

// ── handleOptimizeDescription direct ─────────────────────────────────────
describe("handleOptimizeDescription direct", () => {
  function scaffold(name: string, lines: string[]) {
    const dir = join(base, CTX_DIR, "skills", name);
    mkdirSync(dir, { recursive: true });
    const md = join(dir, "SKILL.md");
    writeFileSync(md, lines.join("\n"));
  }

  const BODY = ["", "## Steps", "1. Do it.", ""];
  function fm(lines: string[]): string[] {
    return ["---", ...lines, "---", ...BODY];
  }

  beforeEach(() => {
    const origHome = process.env.VF_SKILLS_HOME;
    process.env.VF_SKILLS_HOME = base;
    return () => {
      if (origHome === undefined) process.env.VF_SKILLS_HOME = undefined;
      else process.env.VF_SKILLS_HOME = origHome;
    };
  });

  test("returns 0 for known skill", () => {
    scaffold("cli-test", fm(["name: cli-test", "description: cli test skill description"]));
    const code = handleOptimizeDescription(base, ["cli-test"]);
    expect(code).toBe(0);
  });

  test("returns 2 for missing name", () => {
    expect(handleOptimizeDescription(base, [])).toBe(2);
  });

  test("returns 2 for unknown name", () => {
    expect(handleOptimizeDescription(base, ["no-such-skill"])).toBe(2);
  });
});
