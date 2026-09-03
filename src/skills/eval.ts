// src/skills/eval.ts — #658
//
// Skill eval: deterministic trigger checks plus objective task-output checks
// through an injected runner. Core stays engine-agnostic and network-free.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Skill } from "../core/types.js";
import { matchSkillsForTask } from "./registry.js";

// ── Schema types ────────────────────────────────────────────────────

export type EvalCaseType = "positive" | "negative" | "baseline";

export interface EvalCase {
  id: string;
  type: EvalCaseType;
  prompt: string;
  expected?: string;
  matcher?: "equals" | "contains";
}

export interface EvalFile {
  schemaVersion: number;
  skill: string;
  cases: EvalCase[];
}

export interface EvalCaseResult {
  id: string;
  type: EvalCaseType;
  expectedTrigger: boolean;
  actualTrigger: boolean;
  pass: boolean;
}

export interface CategoryScore {
  total: number;
  passed: number;
  triggerAccuracy: number;
}

export interface EvalSummary {
  positive: CategoryScore;
  negative: CategoryScore;
  baseline: CategoryScore;
  triggerAccuracy: number;
  regression: boolean;
}

export interface TaskCaseResult {
  id: string;
  baselineOutput: string;
  skillOutput: string;
  baselinePass: boolean;
  skillPass: boolean;
}

export interface TaskSummary {
  cases: TaskCaseResult[];
  baselinePassRate: number;
  skillPassRate: number;
  delta: number;
  taskPassRate: number;
  regression: boolean;
}

export interface EvalResult {
  schemaVersion: number;
  skill: string;
  timestamp: string;
  cases: EvalCaseResult[];
  summary: EvalSummary;
  task?: TaskSummary;
  previousSummary?: { triggerAccuracy?: number; taskPassRate?: number };
}

// ── Schema validation ───────────────────────────────────────────────

function asStr(v: unknown): string {
  if (typeof v === "string") return v;
  throw new Error(`expected string, got ${typeof v}`);
}

function assertRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected object");
  return v as Record<string, unknown>;
}

function validateEvalCase(v: unknown, idx: number): EvalCase {
  const r = assertRecord(v);
  const id = asStr(r.id);
  const type = asStr(r.type);
  const prompt = asStr(r.prompt);
  if (type !== "positive" && type !== "negative" && type !== "baseline")
    throw new Error(`case[${idx}].type must be positive|negative|baseline, got "${type}"`);
  if (!id) throw new Error(`case[${idx}].id is required`);
  if (!prompt) throw new Error(`case[${idx}].prompt is required`);
  const expected = r.expected === undefined ? undefined : asStr(r.expected);
  const matcher = r.matcher === undefined ? undefined : asStr(r.matcher);
  if (expected !== undefined && !expected) throw new Error(`case[${idx}].expected is required`);
  if (matcher !== undefined && matcher !== "equals" && matcher !== "contains")
    throw new Error(`case[${idx}].matcher must be equals|contains`);
  if (matcher !== undefined && expected === undefined)
    throw new Error(`case[${idx}].matcher requires expected`);
  return { id, type, prompt, expected, matcher: matcher as EvalCase["matcher"] };
}

export function validateEvalFile(data: unknown): EvalFile {
  const r = assertRecord(data);
  const sv = r.schemaVersion;
  if (sv !== 1) throw new Error(`schemaVersion must be 1, got ${JSON.stringify(sv)}`);
  const skill = asStr(r.skill);
  if (!skill) throw new Error("skill is required");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)) throw new Error("skill must be kebab-case");
  const raw = r.cases;
  if (!Array.isArray(raw)) throw new Error("cases must be an array");
  const cases = raw.map((c, i) => validateEvalCase(c, i));
  if (!cases.length) throw new Error("cases must not be empty");
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error("case ids must be unique");
  return { schemaVersion: sv, skill, cases };
}

// ── Score calculation ───────────────────────────────────────────────

function catScore(cases: EvalCaseResult[]): CategoryScore {
  const total = cases.length;
  const passed = cases.filter((c) => c.pass).length;
  return { total, passed, triggerAccuracy: total === 0 ? 1 : passed / total };
}

function triggerAccuracy(cases: EvalCaseResult[]): number {
  const all = cases.length;
  if (all === 0) return 1;
  const passed = cases.filter((c) => c.pass).length;
  return passed / all;
}

// ── Core eval ───────────────────────────────────────────────────────

/** Run deterministic trigger eval for one skill against evals cases. */
export function runSkillEval(
  skill: Skill,
  evals: EvalFile,
  prev?: { triggerAccuracy: number },
): EvalResult {
  const results: EvalCaseResult[] = [];
  for (const c of evals.cases) {
    const matches = matchSkillsForTask([skill], c.prompt);
    const triggered = matches.length > 0;
    const expectedTrigger = c.type === "positive";
    const pass = triggered === expectedTrigger;
    results.push({
      id: c.id,
      type: c.type,
      expectedTrigger,
      actualTrigger: triggered,
      pass,
    });
  }

  const positive = catScore(results.filter((r) => r.type === "positive"));
  const negative = catScore(results.filter((r) => r.type === "negative"));
  const baseline = catScore(results.filter((r) => r.type === "baseline"));

  const accuracy = triggerAccuracy(results);
  const regression = prev !== undefined && accuracy < prev.triggerAccuracy;

  const result: EvalResult = {
    schemaVersion: 1,
    skill: evals.skill,
    timestamp: new Date().toISOString(),
    cases: results,
    summary: { positive, negative, baseline, triggerAccuracy: accuracy, regression },
  };

  if (prev) result.previousSummary = prev;

  return result;
}

export async function runTaskEval(
  evals: EvalFile,
  skillContext: string,
  runner: (prompt: string, skillContext?: string) => string | Promise<string>,
  previousTaskPassRate?: number,
): Promise<TaskSummary | undefined> {
  const objectiveCases = evals.cases.filter((c) => c.expected !== undefined);
  if (!objectiveCases.length) return undefined;
  const cases: TaskCaseResult[] = [];
  for (const c of objectiveCases) {
    const baselineOutput = await runner(c.prompt);
    const skillOutput = await runner(c.prompt, skillContext);
    const expected = c.expected as string;
    const check = (output: string) =>
      c.matcher === "equals" ? output.trim() === expected : output.includes(expected);
    cases.push({
      id: c.id,
      baselineOutput,
      skillOutput,
      baselinePass: check(baselineOutput),
      skillPass: check(skillOutput),
    });
  }
  const rate = (key: "baselinePass" | "skillPass") =>
    cases.filter((c) => c[key]).length / cases.length;
  const baselinePassRate = rate("baselinePass");
  const skillPassRate = rate("skillPass");
  return {
    cases,
    baselinePassRate,
    skillPassRate,
    delta: skillPassRate - baselinePassRate,
    taskPassRate: skillPassRate,
    regression: previousTaskPassRate !== undefined && skillPassRate < previousTaskPassRate,
  };
}

// ── I/O helpers ─────────────────────────────────────────────────────

export function loadEvalFile(
  path: string,
  deps: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
  } = {},
): EvalFile {
  const _exists = deps.existsSync ?? existsSync;
  const _read = deps.readFileSync ?? readFileSync;
  if (!_exists(path)) throw new Error(`eval file not found: ${path}`);
  const raw = JSON.parse(_read(path, "utf8"));
  return validateEvalFile(raw);
}

export function writeEvalResult(
  path: string,
  result: EvalResult,
  deps: { writeFileSafe?: (p: string, content: string) => void } = {},
): void {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (deps.writeFileSafe) {
    deps.writeFileSafe(path, json);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, json);
  }
}

/** Find evals.json in standard locations relative to SKILL.md path. */
export function findEvalFile(
  skillDir: string,
  deps: { existsSync?: (p: string) => boolean } = {},
): string | null {
  const _exists = deps.existsSync ?? existsSync;
  const candidates = [
    join(skillDir, "evals", "evals.json"),
    join(skillDir, "..", "evals", "evals.json"),
  ];
  for (const c of candidates) {
    if (_exists(c)) return c;
  }
  return null;
}
