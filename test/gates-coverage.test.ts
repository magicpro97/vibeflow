import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCanaryCheck } from "../src/canary.js";
import {
  computeConfidence,
  e2eEvaluateDynamicImportWarning,
  e2eUnicodeSelectorWarning,
  findScopeConflicts,
  isVerifiableEvidence,
  policyGates,
} from "../src/gates.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("findScopeConflicts", () => {
  test("returns empty array when no work units (line 61-66)", () => {
    const units: Array<{ name: string; scope?: string[] }> = [];
    expect(findScopeConflicts(units)).toEqual([]);
  });

  test("detects overlapping scopes between two units", () => {
    const units: Array<{ name: string; scope?: string[] }> = [
      { name: "a", scope: ["src/foo.ts", "src/bar.ts"] },
      { name: "b", scope: ["src/bar.ts", "src/baz.ts"] },
    ];
    const conflicts = findScopeConflicts(units);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]).toEqual(["a", "b"]);
  });

  test("does NOT report disjoint scopes as conflicts", () => {
    const units: Array<{ name: string; scope?: string[] }> = [
      { name: "a", scope: ["src/a.ts"] },
      { name: "b", scope: ["src/b.ts"] },
    ];
    expect(findScopeConflicts(units)).toEqual([]);
  });

  test("handles units with no scope at all", () => {
    const units: Array<{ name: string; scope?: string[] }> = [{ name: "a" }, { name: "b" }];
    expect(findScopeConflicts(units)).toEqual([]);
  });
});

describe("e2eUnicodeSelectorWarning", () => {
  test("returns empty list when e2e dir does not exist", () => {
    const dir = freshDir("vf-e2e-uni-");
    expect(e2eUnicodeSelectorWarning(dir)).toEqual([]);
  });

  test("returns empty list when e2e dir exists but no spec files", () => {
    const dir = freshDir("vf-e2e-uni-");
    mkdirSync(join(dir, "e2e"));
    writeFileSync(join(dir, "e2e", "README.md"), "not a spec");
    expect(e2eUnicodeSelectorWarning(dir)).toEqual([]);
  });

  test("returns empty list for spec with only ASCII text selectors", () => {
    const dir = freshDir("vf-e2e-uni-");
    mkdirSync(join(dir, "e2e"));
    writeFileSync(join(dir, "e2e", "login.spec.ts"), 'await page.locator("text=Login").click();');
    expect(e2eUnicodeSelectorWarning(dir)).toEqual([]);
  });

  test("warns on Unicode chars in text selector (line 157-168)", () => {
    const dir = freshDir("vf-e2e-uni-");
    mkdirSync(join(dir, "e2e"));
    writeFileSync(
      join(dir, "e2e", "i18n.spec.ts"),
      'await page.locator("text=Café—Auth").click();',
    );
    const warnings = e2eUnicodeSelectorWarning(dir);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("Café—Auth");
  });

  test("warns on hasText Unicode string (line 160-161)", () => {
    const dir = freshDir("vf-e2e-uni-");
    mkdirSync(join(dir, "e2e"));
    writeFileSync(
      join(dir, "e2e", "i18n.spec.ts"),
      'await page.getByRole("button", { hasText: "Привет" }).click();',
    );
    const warnings = e2eUnicodeSelectorWarning(dir);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("warns on hasText regex Unicode (line 162-164)", () => {
    const dir = freshDir("vf-e2e-uni-");
    mkdirSync(join(dir, "e2e"));
    writeFileSync(
      join(dir, "e2e", "i18n.spec.ts"),
      'await page.getByRole("button", { hasText: /日本/ }).click();',
    );
    const warnings = e2eUnicodeSelectorWarning(dir);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("ignores .ts files that don't match the e2e spec pattern", () => {
    const dir = freshDir("vf-e2e-uni-");
    mkdirSync(join(dir, "e2e"));
    writeFileSync(join(dir, "e2e", "utils.ts"), 'await page.locator("text=Café").click();');
    expect(e2eUnicodeSelectorWarning(dir)).toEqual([]);
  });
});

describe("e2eEvaluateDynamicImportWarning", () => {
  test("returns empty list when e2e dir does not exist", () => {
    const dir = freshDir("vf-e2e-dyn-");
    expect(e2eEvaluateDynamicImportWarning(dir)).toEqual([]);
  });

  test("returns empty list for spec with no dynamic imports", () => {
    const dir = freshDir("vf-e2e-dyn-");
    mkdirSync(join(dir, "e2e"));
    writeFileSync(join(dir, "e2e", "normal.spec.ts"), 'await page.locator("#submit").click();');
    expect(e2eEvaluateDynamicImportWarning(dir)).toEqual([]);
  });

  test("warns on dynamic import() inside page.evaluate() (line 197-241)", () => {
    const dir = freshDir("vf-e2e-dyn-");
    mkdirSync(join(dir, "e2e"));
    // The check inspects the same line as `.evaluate(` for an
    // `import(` token. So we put the dynamic import on the same line.
    writeFileSync(
      join(dir, "e2e", "bad.spec.ts"),
      `await page.evaluate(async () => import("./mod"));`,
    );
    const warnings = e2eEvaluateDynamicImportWarning(dir);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("dynamic import");
  });

  test("does not warn when import() is OUTSIDE page.evaluate()", () => {
    const dir = freshDir("vf-e2e-dyn-");
    mkdirSync(join(dir, "e2e"));
    writeFileSync(
      join(dir, "e2e", "ok.spec.ts"),
      `const m = await import("./mod");
test("runs", async () => { await page.goto("/"); });`,
    );
    expect(e2eEvaluateDynamicImportWarning(dir)).toEqual([]);
  });

  // Documented limitation: e2eEvaluateDynamicImportWarning only detects
  // dynamic imports that appear on the SAME line as `.evaluate(`.
  // The multi-line tracking code (inEvaluate / depth counting) exists
  // for completeness but is never reached because the initial inline
  // check already short-circuits. The else branch's paren counting
  // exists only to find the end of a multi-line `.evaluate(` call so
  // the function knows when to stop tracking.
});

describe("policyGates branches", () => {
  test("policyGates: null state returns FAIL (no-workflow-state) (line 61-66)", () => {
    // Regression: previously this returned ok:true with a "nothing to gate" pass — which let
    // `vf verify` exit 0 on a fresh repo. The audit (PR28 finding C2) flagged this as Critical:
    // a CI that runs `vf verify` as a gate would have been silently green on a repo with no
    // workflow at all, defeating the entire point of the gate.
    const r = policyGates(null);
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.failures[0]).toMatch(/no-workflow-state/);
    expect(r.failures[0]).toContain("vf init");
  });

  test("policyGates: all units at confidence 1.0 (line 70-76)", () => {
    const state = {
      task_id: "T1",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "u1",
          status: "done" as const, // must be done, not running, to pass policy gates
          confidence: 1,
          gates: {
            build: "pass" as const,
            lint: "pass" as const,
            test: "pass" as const,
            review: "pass" as const,
          },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          evidence: ['bun test 2>&1 | tail -3 → "5 pass, 0 fail"'],
        },
      ],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const r = policyGates(state);
    expect(r.ok).toBe(true);
    expect(r.passed).toContain("computed-confidence: all units meet their risk threshold");
  });

  test("policyGates: still-running units block verify (lines 75-79)", () => {
    const state = {
      task_id: "T1",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "active-unit",
          status: "running" as const,
          confidence: 1,
          gates: {
            build: "pass" as const,
            lint: "pass" as const,
            test: "pass" as const,
            review: "pass" as const,
          },
          resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const r = policyGates(state);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.startsWith("still-running:"))).toBe(true);
  });

  test("policyGates: low-confidence units flagged (line 67-78)", () => {
    const state = {
      task_id: "T1",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "u1",
          status: "done" as const, // use done so we test confidence gate specifically
          confidence: 0.5,
          gates: {
            build: "pending" as const,
            lint: "pending" as const,
            test: "pending" as const,
            review: "pending" as const,
          },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          evidence: [],
        },
      ],
      totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const r = policyGates(state);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("computed-confidence"))).toBe(true);
    expect(r.failures.some((f) => f.includes("investigate/debate"))).toBe(true);
  });

  test("policyGates: no-evidence failure contains → Fix: substring", () => {
    const state = {
      task_id: "T1",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "u1",
          status: "done" as const,
          confidence: 1,
          gates: {
            build: "pass" as const,
            lint: "pass" as const,
            test: "pass" as const,
            review: "pass" as const,
          },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          evidence: [],
        },
      ],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const r = policyGates(state);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("no-evidence"))).toBe(true);
    expect(r.failures.some((f) => f.includes("→ Fix:"))).toBe(true);
  });
});

describe("policyGates: knowledge_heavy + skill gate (line 116-142)", () => {
  test("done unit with knowledge_heavy_source=knowledge + skill_waiver → passed", () => {
    const state = {
      task_id: "T1",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "u1",
          status: "done" as const,
          confidence: 1,
          knowledge_heavy: true,
          knowledge_heavy_source: "risk" as const,
          skill_waiver: { reason: "manually verified", at: "2026-01-01" },
          gates: {
            build: "pass" as const,
            lint: "pass" as const,
            test: "pass" as const,
            review: "pass" as const,
          },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const r = policyGates(state);
    expect(r.passed.some((p) => p.includes("closed under waiver"))).toBe(true);
  });

  test("done unit with knowledge_heavy_source=regex → warning", () => {
    const state = {
      task_id: "T1",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "u1",
          status: "done" as const,
          confidence: 1,
          knowledge_heavy: true,
          knowledge_heavy_source: "regex" as const,
          gates: {
            build: "pass" as const,
            lint: "pass" as const,
            test: "pass" as const,
            review: "pass" as const,
          },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const r = policyGates(state);
    expect(r.warnings.some((w) => w.includes("flagged knowledge-heavy by heuristic"))).toBe(true);
  });

  test("done knowledge_heavy with skills_required but not used → warning (line 132-137)", () => {
    const state = {
      task_id: "T1",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "u1",
          status: "done" as const,
          confidence: 1,
          knowledge_heavy: true,
          knowledge_heavy_source: "risk" as const,
          skills_required: ["react"],
          skills_used: ["vue"],
          gates: {
            build: "pass" as const,
            lint: "pass" as const,
            test: "pass" as const,
            review: "pass" as const,
          },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const r = policyGates(state);
    expect(r.warnings.some((w) => w.includes("did not report using a required skill"))).toBe(true);
  });

  test("done knowledge_heavy with skills_required and used → passed (line 132)", () => {
    const state = {
      task_id: "T1",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "u1",
          status: "done" as const,
          confidence: 1,
          knowledge_heavy: true,
          knowledge_heavy_source: "risk" as const,
          skills_required: ["react"],
          skills_used: ["react"],
          gates: {
            build: "pass" as const,
            lint: "pass" as const,
            test: "pass" as const,
            review: "pass" as const,
          },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const r = policyGates(state);
    expect(r.passed.some((p) => p.includes("applied a required skill"))).toBe(true);
  });

  test("done knowledge_heavy with no skills_required and no skills_used → warning (line 124-128)", () => {
    const state = {
      task_id: "T1",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "u1",
          status: "done" as const,
          confidence: 1,
          knowledge_heavy: true,
          knowledge_heavy_source: "risk" as const,
          gates: {
            build: "pass" as const,
            lint: "pass" as const,
            test: "pass" as const,
            review: "pass" as const,
          },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const r = policyGates(state);
    expect(r.warnings.some((w) => w.includes("no verified skill matched"))).toBe(true);
  });
});

describe("e2eUnicodeSelectorWarning branches (line 180)", () => {
  test("e2eUnicodeSelectorWarning: broken symlink skipped (line 180)", () => {
    // Create a broken symlink → readFileSync throws → catch fires.
    const dir = freshDir("vf-e2e-uni-sym-");
    mkdirSync(join(dir, "e2e"));
    try {
      const { symlinkSync } = require("node:fs") as typeof import("node:fs");
      symlinkSync("/nonexistent/abc", join(dir, "e2e", "bad.spec.ts"));
      const warnings = e2eUnicodeSelectorWarning(dir);
      expect(warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("e2eEvaluateDynamicImportWarning: multi-line (line 221-235)", () => {
  test("multi-line .evaluate( → paren counter runs (line 225-235)", () => {
    // The .evaluate( is followed by '(' on the same line. The
    // paren counter inside the if block (line 225-231) runs to
    // find the depth of the opening paren. The else block at
    // 228-235 is now removed.
    const dir = freshDir("vf-e2e-ml2-");
    mkdirSync(join(dir, "e2e"));
    try {
      writeFileSync(
        join(dir, "e2e", "ml.spec.ts"),
        [
          "test('ml', async ({ page }) => {",
          "  await page.evaluate(() => {",
          "    // no import",
          "  });",
          "});",
        ].join("\n"),
      );
      const warnings = e2eEvaluateDynamicImportWarning(dir);
      expect(warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isVerifiableEvidence", () => {
  test("rejects bare 'done'", () => {
    expect(isVerifiableEvidence("done")).toBe(false);
  });
  test("rejects 'tests pass'", () => {
    expect(isVerifiableEvidence("tests pass")).toBe(false);
  });
  test("rejects 'implementation complete'", () => {
    expect(isVerifiableEvidence("implementation complete")).toBe(false);
  });
  test("rejects too-short string", () => {
    expect(isVerifiableEvidence("ok")).toBe(false);
  });
  test("accepts command output capture", () => {
    expect(isVerifiableEvidence('bun test 2>&1 | tail -3 → "12 pass, 0 fail"')).toBe(true);
  });
  test("accepts git diff stat", () => {
    expect(isVerifiableEvidence("git diff --stat origin/main HEAD → 3 files changed")).toBe(true);
  });
  test("accepts file:line reference", () => {
    expect(isVerifiableEvidence("src/gates.ts:47 — added Fix command")).toBe(true);
  });
  test("accepts commit SHA prefix", () => {
    expect(isVerifiableEvidence("commit abc1234 — feat: add goalEval gate")).toBe(true);
  });
  test("accepts test name:result format", () => {
    expect(isVerifiableEvidence("pending-hooks > clearPending: removes all entries [0.04ms]")).toBe(
      true,
    );
  });
  test("accepts CI run URL", () => {
    expect(isVerifiableEvidence("https://github.com/magicpro97/vibeflow/actions/runs/123")).toBe(
      true,
    );
  });
});

describe("policyGates: unverifiable-evidence gate (ADR-004 phase2: fail)", () => {
  const doneUnit = {
    name: "u1",
    status: "done" as const,
    confidence: 1,
    gates: {
      build: "pass" as const,
      lint: "pass" as const,
      test: "pass" as const,
      review: "pass" as const,
    },
    resources: { agents: 1, tokens: 10, cost_usd: 0, wall_seconds: 1 },
  };
  test("emits FAILURE for free-text evidence (phase 2)", () => {
    const state = {
      task_id: "t1",
      goal: "g",
      success_criteria: [],
      work_units: [{ ...doneUnit, evidence: ["tests pass"] }],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const r = policyGates(state);
    expect(r.failures.some((f) => f.includes("unverifiable-evidence"))).toBe(true);
    expect(r.warnings.filter((w) => w.includes("unverifiable-evidence"))).toHaveLength(0);
    expect(r.failures.some((f) => f.includes("→ Fix:"))).toBe(true);
    expect(r.ok).toBe(false);
  });
  test("_allowUnverifiedEvidence bypasses failure check", () => {
    const state = {
      task_id: "t1",
      goal: "g",
      success_criteria: [],
      work_units: [{ ...doneUnit, evidence: ["tests pass"] }],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      _allowUnverifiedEvidence: true,
    };
    const r = policyGates(state);
    expect(r.failures.filter((f) => f.includes("unverifiable-evidence"))).toHaveLength(0);
    expect(r.ok).toBe(true);
  });
  test("no warning for verifiable evidence", () => {
    const state = {
      task_id: "t1",
      goal: "g",
      success_criteria: [],
      work_units: [{ ...doneUnit, evidence: ['bun test 2>&1 | tail -3 → "12 pass, 0 fail"'] }],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    expect(
      policyGates(state).warnings.filter((w) => w.includes("unverifiable-evidence")),
    ).toHaveLength(0);
  });
  test("fails only on unverifiable strings, not verifiable ones in same array", () => {
    const state = {
      task_id: "t1",
      goal: "g",
      success_criteria: [],
      work_units: [{ ...doneUnit, evidence: ['bun test 2>&1 → "ok"', "all done"] }],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    expect(
      policyGates(state).failures.filter((f) => f.includes("unverifiable-evidence")),
    ).toHaveLength(1);
    expect(
      policyGates(state).warnings.filter((w) => w.includes("unverifiable-evidence")),
    ).toHaveLength(0);
  });
});

describe("policyGates: goal_eval gate (ADR-003)", () => {
  const base = {
    task_id: "t1",
    goal: "g",
    success_criteria: [] as string[],
    totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };
  const doneUnit = {
    name: "u1",
    status: "done" as const,
    confidence: 1,
    gates: {
      build: "pass" as const,
      lint: "pass" as const,
      test: "pass" as const,
      review: "pass" as const,
    },
    resources: { agents: 1, tokens: 10, cost_usd: 0, wall_seconds: 1 },
    evidence: ['bun test 2>&1 | tail -3 → "5 pass, 0 fail"'],
  };

  test("emits failure when goal_eval=fail", () => {
    const state = {
      ...base,
      work_units: [{ ...doneUnit, gates: { ...doneUnit.gates, goal_eval: "fail" as const } }],
    };
    const r = policyGates(state);
    expect(r.failures.some((f) => f.includes("goal-eval-fail"))).toBe(true);
    expect(r.failures.find((f) => f.includes("goal-eval-fail"))).toContain("→ Fix:");
  });

  test("emits passed when goal_eval=pass on any unit", () => {
    const state = {
      ...base,
      work_units: [{ ...doneUnit, gates: { ...doneUnit.gates, goal_eval: "pass" as const } }],
    };
    const r = policyGates(state);
    expect(r.passed.some((p) => p.includes("goal-eval:"))).toBe(true);
  });

  test("no goal_eval entry when gate is undefined (not run)", () => {
    const state = { ...base, work_units: [{ ...doneUnit }] };
    const r = policyGates(state);
    expect(r.failures.filter((f) => f.includes("goal-eval-fail"))).toHaveLength(0);
    expect(r.passed.filter((p) => p.includes("goal-eval:"))).toHaveLength(0);
  });
});

describe("computeConfidence (Task 5: self-report is a CAP)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: terse gate fixture for unit tests
  const G = (o = {}) =>
    ({ build: "pass", lint: "pass", test: "pass", review: "pass", ...o }) as any;

  test("all green + self 1 → 1.0", () => {
    expect(computeConfidence({ confidence: 1, gates: G() })).toBe(1);
  });
  test("test fail → hard 0", () => {
    expect(computeConfidence({ confidence: 1, gates: G({ test: "fail" }) })).toBe(0);
  });
  test("build fail beats high self-report → 0", () => {
    expect(computeConfidence({ confidence: 1, gates: G({ build: "fail" }) })).toBe(0);
  });
  test("review fail → hard 0", () => {
    expect(computeConfidence({ confidence: 1, gates: G({ review: "fail" }) })).toBe(0);
  });
  test("security fail → hard 0", () => {
    expect(computeConfidence({ confidence: 1, gates: G({ security: "fail" }) })).toBe(0);
  });
  test("goal_eval fail (all other criticals pass) → hard 0", () => {
    // All build/test/review/security pass so the critical-gate OR-chain is fully
    // evaluated down to goal_eval.
    expect(
      computeConfidence({ confidence: 1, gates: G({ security: "pass", goal_eval: "fail" }) }),
    ).toBe(0);
  });
  test("review pending caps below feature threshold 0.85", () => {
    expect(computeConfidence({ confidence: 1, gates: G({ review: "pending" }) })).toBeLessThan(
      0.85,
    );
  });
  test("running gate lowers confidence (running → 0 value)", () => {
    expect(computeConfidence({ confidence: 1, gates: G({ review: "running" }) })).toBeLessThan(
      0.85,
    );
  });
  test("honest low self-report lowers it (cap only)", () => {
    expect(computeConfidence({ confidence: 0.5, gates: G() })).toBe(0.5);
  });
  test("missing self-report defaults to 0 (cap)", () => {
    expect(computeConfidence({ gates: G() } as Parameters<typeof computeConfidence>[0])).toBe(0);
  });

  // ── #545: calibrated judge score as a graded signal ──
  test("goal_score absent → identical to today (backward-compat regression lock)", () => {
    const base = computeConfidence({ confidence: 1, gates: G() });
    expect(computeConfidence({ confidence: 1, gates: G(), goal_score: undefined })).toBe(base);
  });
  test("higher goal_score ⇒ higher confidence (graded, not binary)", () => {
    const hi = computeConfidence({ confidence: 1, gates: G(), goal_score: 0.9 });
    const lo = computeConfidence({ confidence: 1, gates: G(), goal_score: 0.3 });
    expect(hi).toBeGreaterThan(lo);
  });
  test("a weak goal_score pulls an all-green unit below 1.0", () => {
    expect(computeConfidence({ confidence: 1, gates: G(), goal_score: 0.3 })).toBeLessThan(1);
  });
  test("goal_eval fail zeros regardless of a high goal_score", () => {
    expect(
      computeConfidence({
        confidence: 1,
        gates: G({ security: "pass", goal_eval: "fail" }),
        goal_score: 0.99,
      }),
    ).toBe(0);
  });
  test("NaN / Infinity goal_score is ignored, never poisons the result (Copilot #585)", () => {
    // A non-finite score must not turn confidence into NaN (NaN < threshold === false
    // would silently let a unit pass the gate). parseGoalScore clamps, but
    // computeConfidence is public API — defend the fold directly.
    const base = computeConfidence({ confidence: 1, gates: G() });
    expect(computeConfidence({ confidence: 1, gates: G(), goal_score: Number.NaN })).toBe(base);
    expect(
      computeConfidence({ confidence: 1, gates: G(), goal_score: Number.POSITIVE_INFINITY }),
    ).toBe(base);
  });
  test("weakest-link — lint fail tanks more than arithmetic mean would", () => {
    // geo-mean penalizes a near-zero signal superlinearly (arithmetic mean → 0.75).
    const c = computeConfidence({ confidence: 1, gates: G({ lint: "fail" }) });
    expect(c).toBeLessThan(0.75);
    expect(c).toBeGreaterThan(0);
  });
  // Cross-review P0 fix: computeConfidence must accept UnitOutcome-shaped input
  // where gates is undefined/partial (the orchestrate/reviewer call sites pass this).
  test("undefined gates → near-zero (not-run signal, no crash)", () => {
    // All signals absent → wGeoMean floors every term to EPS(0.05) → objective ≈ 0.05,
    // which caps confidence far below any threshold. No NaN, no crash.
    const c = computeConfidence({ confidence: 1 });
    expect(c).toBeLessThan(0.1);
    expect(Number.isNaN(c)).toBe(false);
  });
  test("partial gates (only test present) → undefined-safe, no NaN", () => {
    const c = computeConfidence({ confidence: 1, gates: { test: "pass" } });
    expect(Number.isNaN(c)).toBe(false);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });
});

describe("policyGates: canary gate (ADR-005)", () => {
  const base = {
    task_id: "t1",
    goal: "g",
    success_criteria: [] as string[],
    totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };
  const khUnit = {
    name: "feature-x",
    status: "done" as const,
    knowledge_heavy: true,
    knowledge_heavy_source: "risk" as const,
    skills_required: ["s"],
    skills_used: ["s"],
    confidence: 1,
    evidence: ["src/x.ts:1 — done"],
    scope: ["src/x.ts"],
    gates: {
      build: "pass" as const,
      lint: "pass" as const,
      test: "pass" as const,
      review: "pass" as const,
    },
    resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };

  test("knowledge-heavy done unit without canary → FAILURE", () => {
    const state = { ...base, work_units: [{ ...khUnit }] };
    const r = policyGates(state, { canaryCheck: () => false });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("canary-required"))).toBe(true);
    expect(r.failures.some((f) => f.includes("→ Fix:"))).toBe(true);
  });

  test("knowledge-heavy with linked canary → passes", () => {
    const state = {
      ...base,
      work_units: [
        {
          ...khUnit,
          canary: { file: "test/x.canary.test.ts", author: "human", linkedAt: "2026-07-03" },
        },
      ],
    };
    const r = policyGates(state, { canaryCheck: () => true });
    expect(r.failures.some((f) => f.includes("canary-required"))).toBe(false);
    expect(r.passed.some((p) => p.includes("canary:"))).toBe(true);
  });

  test("non-knowledge-heavy unit → no canary required", () => {
    const state = {
      ...base,
      work_units: [{ ...khUnit, name: "chore-x", knowledge_heavy: false }],
    };
    const r = policyGates(state, { canaryCheck: () => false });
    expect(r.failures.some((f) => f.includes("canary-required"))).toBe(false);
  });

  test("defaultCanaryCheck: no canary → false", () => {
    expect(defaultCanaryCheck({ ...khUnit } as never)).toBe(false);
  });

  test("defaultCanaryCheck: canary authored by the dispatch engine → false", () => {
    const u = {
      ...khUnit,
      owner_agent: "codex",
      canary: { file: "test/x.canary.test.ts", author: "codex", linkedAt: "2026-07-03" },
    };
    expect(defaultCanaryCheck(u as never)).toBe(false);
  });

  test("defaultCanaryCheck: human canary differing from engine → true", () => {
    const u = {
      ...khUnit,
      owner_agent: "codex",
      canary: { file: "test/x.canary.test.ts", author: "alice", linkedAt: "2026-07-03" },
    };
    expect(defaultCanaryCheck(u as never)).toBe(true);
  });

  // Cross-review P0 (both reviewers): undefined owner_agent must NOT pass. Without
  // a known dispatch identity, `author !== undefined` is trivially true for any
  // author string — hollowing out the human-canary invariant. Missing identity = block.
  test("defaultCanaryCheck: undefined owner_agent → false (no trust without identity)", () => {
    const u = {
      ...khUnit,
      owner_agent: undefined,
      canary: { file: "test/x.canary.test.ts", author: "anyone", linkedAt: "2026-07-03" },
    };
    expect(defaultCanaryCheck(u as never)).toBe(false);
  });

  test("defaultCanaryCheck drives the real gate (no inject) — human canary passes", () => {
    const state = {
      ...base,
      work_units: [
        {
          ...khUnit,
          owner_agent: "codex",
          canary: { file: "test/x.canary.test.ts", author: "alice", linkedAt: "2026-07-03" },
        },
      ],
    };
    const r = policyGates(state);
    expect(r.failures.some((f) => f.includes("canary-required"))).toBe(false);
  });

  // Task 8: Type B impl-drift gate — injected drift seam. Covered change → WARN,
  // uncovered change → FAIL, no drift → silent.
  test("impl-drift gate: uncovered scoped edit → FAILURE", () => {
    const state = {
      ...base,
      work_units: [{ ...khUnit, impl_fingerprint: { "src/x.ts": "old" } }],
    };
    const r = policyGates(state, {
      canaryCheck: () => true,
      implDrift: () => ({ drifted: ["src/x.ts"], uncovered: ["src/x.ts"] }),
    });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("impl-drift"))).toBe(true);
  });
  test("impl-drift gate: covered scoped edit → WARN (not fail)", () => {
    const state = {
      ...base,
      work_units: [{ ...khUnit, impl_fingerprint: { "src/x.ts": "old" } }],
    };
    const r = policyGates(state, {
      canaryCheck: () => true,
      implDrift: () => ({ drifted: ["src/x.ts"], uncovered: [] }),
    });
    expect(r.failures.some((f) => f.includes("impl-drift"))).toBe(false);
    expect(r.warnings.some((w) => w.includes("impl-drift(warn)"))).toBe(true);
  });
  test("impl-drift gate: no fingerprint → not checked", () => {
    const state = { ...base, work_units: [{ ...khUnit, canary: undefined }] };
    const r = policyGates(state, {
      canaryCheck: () => true,
      implDrift: () => ({ drifted: ["should-not-run"], uncovered: ["x"] }),
    });
    expect(r.failures.some((f) => f.includes("impl-drift"))).toBe(false);
  });

  // #517: evidence-freshness — evidence recorded BEFORE the code it verifies is stale (WARN-only).
  test("evidence-freshness: stale evidence (2020 < code 2021) → warning", () => {
    const state = {
      ...base,
      work_units: [{ ...khUnit, evidence_at: { e1: "2020-01-01T00:00:00.000Z" } }],
    };
    const r = policyGates(state, {
      canaryCheck: () => true,
      codeTimeFn: () => "2021-01-01T00:00:00.000Z",
    });
    expect(r.ok).toBe(true); // warn-only, never fails
    expect(r.warnings.some((w) => w.includes("evidence-stale(warn)"))).toBe(true);
  });

  test("evidence-freshness: fresh evidence (2022 > code 2021) → no warning", () => {
    const state = {
      ...base,
      work_units: [{ ...khUnit, evidence_at: { e1: "2022-01-01T00:00:00.000Z" } }],
    };
    const r = policyGates(state, {
      canaryCheck: () => true,
      codeTimeFn: () => "2021-01-01T00:00:00.000Z",
    });
    expect(r.warnings.some((w) => w.includes("evidence-stale"))).toBe(false);
  });

  test("evidence-freshness: fail-open when evidence_at absent → no warning", () => {
    const state = { ...base, work_units: [{ ...khUnit }] }; // no evidence_at
    const r = policyGates(state, {
      canaryCheck: () => true,
      codeTimeFn: () => "2021-01-01T00:00:00.000Z",
    });
    expect(r.warnings.some((w) => w.includes("evidence-stale"))).toBe(false);
  });

  test("evidence-freshness: fail-open when codeTimeFn returns null → no warning", () => {
    const state = {
      ...base,
      work_units: [{ ...khUnit, evidence_at: { e1: "2020-01-01T00:00:00.000Z" } }],
    };
    const r = policyGates(state, {
      canaryCheck: () => true,
      codeTimeFn: () => null, // non-git / no commit
    });
    expect(r.warnings.some((w) => w.includes("evidence-stale"))).toBe(false);
  });

  // #534: evidence_at is persisted + hand-editable. A positive offset can make a
  // string sort LEXICALLY newer while the true instant is OLDER — the exact case
  // the old `.sort()` (raw string compare) got wrong. "2021-01-01T05:00:00+07:00"
  // == 2020-12-31T22:00:00Z, genuinely older than code 2021-01-01T00:00:00Z, so a
  // warning is CORRECT. Old code: lexical "…T05…" > "…T00…" → newest<ct false → NO
  // warn (MISSES real staleness). New code normalizes → warns. Discriminates.
  test("evidence-freshness: offset lexically-newer-but-actually-older → warns (#534)", () => {
    const state = {
      ...base,
      work_units: [{ ...khUnit, evidence_at: { e1: "2021-01-01T05:00:00+07:00" } }],
    };
    const r = policyGates(state, {
      canaryCheck: () => true,
      codeTimeFn: () => "2021-01-01T00:00:00.000Z",
    });
    expect(r.ok).toBe(true); // warn-only
    expect(r.warnings.some((w) => w.includes("evidence-stale(warn)"))).toBe(true);
  });

  // #534: the mirror case — a negative offset sorts LEXICALLY older while the true
  // instant is NEWER. "2021-01-01T00:00:00-07:00" == 2021-01-01T07:00:00Z, genuinely
  // newer than code 2021-01-01T03:00:00Z, so NO warning is correct. Old code: lexical
  // "…T00…" < "…T03…" → newest<ct true → FALSE warn. New code normalizes → no warn.
  test("evidence-freshness: offset lexically-older-but-actually-newer → no false warn (#534)", () => {
    const state = {
      ...base,
      work_units: [{ ...khUnit, evidence_at: { e1: "2021-01-01T00:00:00-07:00" } }],
    };
    const r = policyGates(state, {
      canaryCheck: () => true,
      codeTimeFn: () => "2021-01-01T03:00:00.000Z",
    });
    expect(r.warnings.some((w) => w.includes("evidence-stale"))).toBe(false);
  });

  // #534: a garbage / non-ISO value (Date.parse → NaN) is dropped, not treated
  // as a char array. With NO other parseable entry → fail-open (no warning),
  // never a crash or spurious warn.
  test("evidence-freshness: unparseable evidence_at value → fail-open, no crash (#534)", () => {
    const state = {
      ...base,
      work_units: [{ ...khUnit, evidence_at: { e1: "not-a-date" } }],
    };
    const r = policyGates(state, {
      canaryCheck: () => true,
      codeTimeFn: () => "2021-01-01T00:00:00.000Z",
    });
    expect(r.warnings.some((w) => w.includes("evidence-stale"))).toBe(false);
  });

  // #534: a mix — one garbage + one valid stale entry — drops the garbage and
  // still warns off the valid one (garbage must not mask a real staleness).
  test("evidence-freshness: mixed garbage + valid stale → drops garbage, still warns (#534)", () => {
    const state = {
      ...base,
      work_units: [{ ...khUnit, evidence_at: { bad: "garbage", e1: "2020-01-01T00:00:00.000Z" } }],
    };
    const r = policyGates(state, {
      canaryCheck: () => true,
      codeTimeFn: () => "2021-01-01T00:00:00.000Z",
    });
    expect(r.warnings.some((w) => w.includes("evidence-stale(warn)"))).toBe(true);
  });
});
