import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("weakest-link — lint fail tanks more than arithmetic mean would", () => {
    // geo-mean penalizes a near-zero signal superlinearly (arithmetic mean → 0.75).
    const c = computeConfidence({ confidence: 1, gates: G({ lint: "fail" }) });
    expect(c).toBeLessThan(0.75);
    expect(c).toBeGreaterThan(0);
  });
});
