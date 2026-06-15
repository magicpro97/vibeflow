import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  e2eEvaluateDynamicImportWarning,
  e2eUnicodeSelectorWarning,
  findScopeConflicts,
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
          status: "running" as const,
          confidence: 1,
          gates: {
            build: "pass" as const,
            lint: "pass" as const,
            test: "pass" as const,
            review: "pass" as const,
          },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const r = policyGates(state);
    expect(r.ok).toBe(true);
    expect(r.passed).toContain("confidence: all units at 1.0");
  });

  test("policyGates: low-confidence units flagged (line 67-78)", () => {
    const state = {
      task_id: "T1",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "u1",
          status: "running" as const,
          confidence: 0.5,
          gates: {
            build: "pending" as const,
            lint: "pending" as const,
            test: "pending" as const,
            review: "pending" as const,
          },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    const r = policyGates(state);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("confidence<1"))).toBe(true);
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
