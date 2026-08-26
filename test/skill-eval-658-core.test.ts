import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "../src/core/types";
import {
  type EvalCase,
  type EvalFile,
  type EvalResult,
  findEvalFile,
  loadEvalFile,
  runSkillEval,
  runTaskEval,
  validateEvalFile,
  writeEvalResult,
} from "../src/skills/eval";

let dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vf-eval-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeSkill(over: Partial<Skill> = {}): Skill {
  return {
    name: "test-skill",
    description: "A test skill for eval.",
    status: "unverified",
    capabilities: ["pdf", "parse"],
    triggers: [".pdf", ".txt"],
    dir: "/tmp/skill",
    path: "/tmp/skill/SKILL.md",
    ...over,
  };
}

function validEvalFile(): EvalFile {
  return {
    schemaVersion: 1,
    skill: "test-skill",
    cases: [
      { id: "p1", type: "positive", prompt: "parse this pdf file" },
      { id: "n1", type: "negative", prompt: "compile rust code" },
      { id: "b1", type: "baseline", prompt: "just run the tests" },
    ],
  };
}

describe("validateEvalFile", () => {
  test("accepts valid eval file", () => {
    const ef = validEvalFile();
    expect(validateEvalFile(ef)).toEqual(ef);
  });

  test("rejects non-object", () => {
    expect(() => validateEvalFile(null)).toThrow("expected object");
  });

  test("rejects wrong schemaVersion", () => {
    expect(() => validateEvalFile({ schemaVersion: 2, skill: "x", cases: [] })).toThrow(
      "schemaVersion must be 1",
    );
  });

  test("rejects missing skill", () => {
    expect(() => validateEvalFile({ schemaVersion: 1, skill: "", cases: [] })).toThrow(
      "skill is required",
    );
  });

  test("rejects non-array cases", () => {
    expect(() => validateEvalFile({ schemaVersion: 1, skill: "x", cases: "not-array" })).toThrow(
      "cases must be an array",
    );
  });

  test("rejects empty cases", () => {
    expect(() => validateEvalFile({ schemaVersion: 1, skill: "x", cases: [] })).toThrow(
      "cases must not be empty",
    );
  });

  test("rejects case with invalid type", () => {
    expect(() =>
      validateEvalFile({
        schemaVersion: 1,
        skill: "x",
        cases: [{ id: "c1", type: "invalid", prompt: "hello" }],
      }),
    ).toThrow("case[0].type must be positive|negative|baseline");
  });

  test("rejects case with non-string id", () => {
    expect(() =>
      validateEvalFile({
        schemaVersion: 1,
        skill: "x",
        cases: [{ id: 123, type: "positive", prompt: "hello" } as unknown as EvalCase],
      }),
    ).toThrow("expected string, got number");
  });

  test("rejects case with empty id", () => {
    expect(() =>
      validateEvalFile({
        schemaVersion: 1,
        skill: "x",
        cases: [{ id: "", type: "positive", prompt: "hello" }],
      }),
    ).toThrow("case[0].id is required");
  });

  test("rejects case with missing prompt", () => {
    expect(() =>
      validateEvalFile({
        schemaVersion: 1,
        skill: "x",
        cases: [{ id: "c1", type: "positive", prompt: "" }],
      }),
    ).toThrow("case[0].prompt is required");
  });

  test("rejects invalid objective fields", () => {
    const file = (entry: Record<string, unknown>) => ({
      schemaVersion: 1,
      skill: "test-skill",
      cases: [{ id: "c1", type: "positive", prompt: "hello", ...entry }],
    });
    expect(() => validateEvalFile(file({ expected: "" }))).toThrow("expected is required");
    expect(() => validateEvalFile(file({ expected: "ok", matcher: "regex" }))).toThrow(
      "matcher must be equals|contains",
    );
    expect(() => validateEvalFile(file({ matcher: "equals" }))).toThrow(
      "matcher requires expected",
    );
  });
});

describe("runSkillEval", () => {
  test("positive case triggers -> pass", () => {
    const skill = makeSkill({ triggers: ["pdf"], capabilities: ["parse"] });
    const evals: EvalFile = {
      schemaVersion: 1,
      skill: "test-skill",
      cases: [{ id: "p1", type: "positive", prompt: "parse this pdf document" }],
    };
    const result = runSkillEval(skill, evals);
    expect(result.cases[0]?.pass).toBe(true);
    expect(result.cases[0]?.actualTrigger).toBe(true);
  });

  test("positive case no trigger -> fail", () => {
    const skill = makeSkill({ triggers: ["pdf"], capabilities: [] });
    const evals: EvalFile = {
      schemaVersion: 1,
      skill: "test-skill",
      cases: [{ id: "p1", type: "positive", prompt: "write a rust compiler" }],
    };
    const result = runSkillEval(skill, evals);
    expect(result.cases[0]?.pass).toBe(false);
    expect(result.cases[0]?.actualTrigger).toBe(false);
  });

  test("negative case no trigger -> pass", () => {
    const skill = makeSkill({ triggers: ["pdf"], capabilities: [] });
    const evals: EvalFile = {
      schemaVersion: 1,
      skill: "test-skill",
      cases: [{ id: "n1", type: "negative", prompt: "compile rust code" }],
    };
    const result = runSkillEval(skill, evals);
    expect(result.cases[0]?.pass).toBe(true);
    expect(result.cases[0]?.actualTrigger).toBe(false);
  });

  test("negative case triggers -> fail", () => {
    const skill = makeSkill({ triggers: ["pdf"], capabilities: ["compile"] });
    const evals: EvalFile = {
      schemaVersion: 1,
      skill: "test-skill",
      cases: [{ id: "n1", type: "negative", prompt: "compile rust code" }],
    };
    const result = runSkillEval(skill, evals);
    expect(result.cases[0]?.pass).toBe(false);
    expect(result.cases[0]?.actualTrigger).toBe(true);
  });

  test("baseline case", () => {
    const skill = makeSkill({ triggers: ["test"], capabilities: [] });
    const evals: EvalFile = {
      schemaVersion: 1,
      skill: "test-skill",
      cases: [{ id: "b1", type: "baseline", prompt: "just run the tests" }],
    };
    const result = runSkillEval(skill, evals);
    expect(result.cases[0]?.pass).toBe(true);
  });

  test("scores all three categories", () => {
    const skill = makeSkill({ triggers: ["pdf", "txt"], capabilities: ["parse", "compile"] });
    const evals: EvalFile = {
      schemaVersion: 1,
      skill: "test-skill",
      cases: [
        { id: "p1", type: "positive", prompt: "parse pdf" },
        { id: "n1", type: "negative", prompt: "not related at all" },
        { id: "b1", type: "baseline", prompt: "compile this code" },
      ],
    };
    const result = runSkillEval(skill, evals);
    expect(result.summary.positive.total).toBe(1);
    expect(result.summary.negative.total).toBe(1);
    expect(result.summary.baseline.total).toBe(1);
  });

  test("regression when trigger accuracy drops", () => {
    const skill = makeSkill({ triggers: ["pdf"], capabilities: [] });
    const evals: EvalFile = {
      schemaVersion: 1,
      skill: "test-skill",
      cases: [{ id: "p1", type: "positive", prompt: "write a rust compiler" }],
    };
    const result = runSkillEval(skill, evals, { triggerAccuracy: 1 });
    expect(result.summary.regression).toBe(true);
    expect(result.previousSummary).toEqual({ triggerAccuracy: 1 });
  });

  test("no regression when pass rate equal or higher", () => {
    const skill = makeSkill({ triggers: ["pdf"], capabilities: ["compile"] });
    const evals: EvalFile = {
      schemaVersion: 1,
      skill: "test-skill",
      cases: [{ id: "p1", type: "positive", prompt: "compile this" }],
    };
    const result = runSkillEval(skill, evals, { triggerAccuracy: 0.5 });
    expect(result.summary.regression).toBe(false);
  });

  test("no previous -> no regression", () => {
    const evals: EvalFile = {
      schemaVersion: 1,
      skill: "test-skill",
      cases: [{ id: "p1", type: "positive", prompt: "hello" }],
    };
    const result = runSkillEval(makeSkill(), evals);
    expect(result.summary.regression).toBe(false);
    expect(result.previousSummary).toBeUndefined();
  });

  test("objective task runs baseline then skill context", async () => {
    const evals = validateEvalFile({
      schemaVersion: 1,
      skill: "test-skill",
      cases: [{ id: "task", type: "positive", prompt: "answer", expected: "correct" }],
    });
    const calls: Array<string | undefined> = [];
    const result = await runTaskEval(evals, "skill body", (_prompt, context) => {
      calls.push(context);
      return context ? "correct" : "wrong";
    });
    expect(calls).toEqual([undefined, "skill body"]);
    expect(result).toMatchObject({
      baselinePassRate: 0,
      skillPassRate: 1,
      delta: 1,
      taskPassRate: 1,
    });
    expect((await runTaskEval(evals, "skill body", () => "wrong", 1))?.regression).toBe(true);
  });

  test("includes ISO timestamp", () => {
    const evals: EvalFile = {
      schemaVersion: 1,
      skill: "test-skill",
      cases: [{ id: "p1", type: "positive", prompt: "hello" }],
    };
    const result = runSkillEval(makeSkill(), evals);
    expect(() => new Date(result.timestamp)).not.toThrow();
  });
});

describe("findEvalFile", () => {
  test("finds evals/evals.json relative to skill dir", () => {
    const d = tmpDir();
    const skillDir = join(d, "my-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(join(skillDir, "evals", "evals.json"), "{}");
    expect(findEvalFile(skillDir)).toBe(join(skillDir, "evals", "evals.json"));
  });

  test("finds evals/evals.json in parent dir", () => {
    const d = tmpDir();
    const evalsDir = join(d, "evals");
    mkdirSync(evalsDir, { recursive: true });
    writeFileSync(join(evalsDir, "evals.json"), "{}");
    const skillDir = join(d, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    expect(findEvalFile(skillDir)).toBe(join(evalsDir, "evals.json"));
  });

  test("returns null when not found", () => {
    expect(findEvalFile(tmpDir())).toBeNull();
  });

  test("inject existsSync seam", () => {
    const d = tmpDir();
    const found = findEvalFile(join(d, "s"), { existsSync: () => true });
    expect(found).toBe(join(d, "s", "evals", "evals.json"));
  });
});

describe("loadEvalFile", () => {
  test("loads and validates on-disk JSON", () => {
    const d = tmpDir();
    const fp = join(d, "evals.json");
    writeFileSync(fp, JSON.stringify(validEvalFile()));
    const loaded = loadEvalFile(fp);
    expect(loaded.skill).toBe("test-skill");
    expect(loaded.cases).toHaveLength(3);
  });

  test("throws on missing file", () => {
    expect(() => loadEvalFile("/nope/evals.json")).toThrow("eval file not found");
  });

  test("throws on invalid JSON", () => {
    const d = tmpDir();
    writeFileSync(join(d, "evals.json"), "not-json");
    expect(() => loadEvalFile(join(d, "evals.json"))).toThrow();
  });

  test("inject existsSync + readFileSync seam", () => {
    const ef = validEvalFile();
    const loaded = loadEvalFile("/fake/path", {
      existsSync: () => true,
      readFileSync: () => JSON.stringify(ef),
    });
    expect(loaded.skill).toBe("test-skill");
  });

  test("inject throws when existsSync returns false", () => {
    expect(() =>
      loadEvalFile("/fake/path", { existsSync: () => false, readFileSync: () => "" }),
    ).toThrow("eval file not found");
  });
});

describe("writeEvalResult", () => {
  test("writes JSON via inject writeFileSafe", () => {
    let written = "";
    const result: EvalResult = {
      schemaVersion: 1,
      skill: "test-skill",
      timestamp: "2026-01-01T00:00:00.000Z",
      cases: [],
      summary: {
        positive: { total: 0, passed: 0, triggerAccuracy: 1 },
        negative: { total: 0, passed: 0, triggerAccuracy: 1 },
        baseline: { total: 0, passed: 0, triggerAccuracy: 1 },
        triggerAccuracy: 1,
        regression: false,
      },
    };
    writeEvalResult("/out.json", result, {
      writeFileSafe: (p, c) => {
        written = c;
      },
    });
    const parsed = JSON.parse(written);
    expect(parsed.schemaVersion).toBe(1);
  });

  test("writes JSON via fallback fs.writeFileSync", () => {
    const d = tmpDir();
    const fp = join(d, "result.json");
    const result: EvalResult = {
      schemaVersion: 1,
      skill: "test-skill",
      timestamp: "2026-01-01T00:00:00.000Z",
      cases: [],
      summary: {
        positive: { total: 0, passed: 0, triggerAccuracy: 1 },
        negative: { total: 0, passed: 0, triggerAccuracy: 1 },
        baseline: { total: 0, passed: 0, triggerAccuracy: 1 },
        triggerAccuracy: 1,
        regression: false,
      },
    };
    writeEvalResult(fp, result);
    const parsed = JSON.parse(readFileSync(fp, "utf8"));
    expect(parsed.skill).toBe("test-skill");
  });
});
