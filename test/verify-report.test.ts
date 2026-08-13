import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectVerifyReportAsync, defaultGoalEvalFn } from "../src/commands/tools-detect.js";
import { runWaiverGate } from "../src/commands/waiver-gate.js";
import { CTX_DIR, readState, writeState } from "../src/core.js";

// Async-only: the route uses collectVerifyReportAsync (non-blocking); the old
// sync collectVerifyReport was removed because spawnSync froze Bun.serve.

const fakeSpawner = (status: number) => () => Promise.resolve({ status });

// Helper: create a temp dir with a package.json containing the given scripts.
function tempProject(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-verify-test-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }, null, 2));
  return dir;
}

// Shared temp dir with package.json (npm toolchain) for goalEval tests.
const tmp = tempProject({ typecheck: "exit 0", test: "exit 0" });

describe("collectVerifyReportAsync", () => {
  test("#764: current-HEAD review evidence is required by default", async () => {
    const dir = tempProject({ test: "exit 0" });
    mkdirSync(join(dir, CTX_DIR), { recursive: true });
    writeState(dir, {
      task_id: "T",
      goal: "g",
      success_criteria: [],
      work_units: [],
      totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    });

    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(0) });
    expect(report.ok).toBe(false);
    expect(report.policy.failures).toContain("review-evidence: cannot resolve HEAD");
  });

  test("runs toolchain gates and returns structured report", async () => {
    const report = await collectVerifyReportAsync(process.cwd(), { spawner: fakeSpawner(0) });
    expect(report).toHaveProperty("toolchain");
    expect(report).toHaveProperty("policy");
    expect(Array.isArray(report.toolchain)).toBe(true);
    expect(typeof report.policy).toBe("object");
    expect(Array.isArray(report.policy.passed)).toBe(true);
    expect(Array.isArray(report.policy.warnings)).toBe(true);
    expect(Array.isArray(report.policy.failures)).toBe(true);
    expect(typeof report.ok).toBe("boolean");
  });

  test("marks failing gates in toolchain when spawner returns non-zero", async () => {
    const report = await collectVerifyReportAsync(process.cwd(), { spawner: fakeSpawner(1) });
    expect(report.ok).toBe(false);
    expect(report.toolchain.some((g) => !g.pass)).toBe(true);
  });

  test("structure is correct regardless of pass/fail", async () => {
    const report = await collectVerifyReportAsync(process.cwd(), { spawner: fakeSpawner(0) });
    expect(typeof report.ok).toBe("boolean");
    expect(Array.isArray(report.toolchain)).toBe(true);
  });

  test("toolchain gates have label and pass fields", async () => {
    const report = await collectVerifyReportAsync(process.cwd(), { spawner: fakeSpawner(0) });
    for (const gate of report.toolchain) {
      expect(typeof gate.label).toBe("string");
      expect(typeof gate.pass).toBe("boolean");
    }
  });

  test("default spawner works with real spawn on temp project", async () => {
    // Create a temp project with a typecheck script, then call
    // collectVerifyReportAsync WITHOUT a fake spawner so the real
    // default spawner runs (exercising lines 90-97).
    const dir = tempProject({ typecheck: "exit 0", test: "exit 0" });
    const report = await collectVerifyReportAsync(dir);
    expect(report).toHaveProperty("ok");
    expect(Array.isArray(report.toolchain)).toBe(true);
  });

  // Type B PRODUCER (cross-review P0): when gates pass, a done unit's
  // impl_fingerprint + verified_sha must be WRITTEN back to state, else the
  // Type B drift gate is permanently silent.
  test("writes impl_fingerprint on done units when gates pass", async () => {
    const dir = tempProject({ typecheck: "exit 0", test: "exit 0" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "x.ts"), "export const x = 1;\n");
    mkdirSync(join(dir, CTX_DIR), { recursive: true });
    writeState(dir, {
      task_id: "T",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "u",
          status: "done",
          confidence: 1,
          scope: ["src/x.ts"],
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
          resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          evidence: ["src/x.ts:1 — done"],
        },
      ],
      totals: { units: 1, done: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    } as never);
    await collectVerifyReportAsync(dir, {
      spawner: fakeSpawner(0),
      requireReviewEvidence: false,
    });
    const after = readState(dir) as { work_units: Array<{ impl_fingerprint?: object }> };
    // fingerprint written for the scoped file (best-effort; may be {} if git absent,
    // but the key must be SET so the gate has something to compare next time).
    expect(after.work_units[0]?.impl_fingerprint).toBeDefined();
  });

  test("default spawner error handler on non-existent binary", async () => {
    // Create a temp project with a script that calls a non-existent binary.
    // The default spawner's "error" event handler (line 96) resolves { status: 1 }.
    const dir = tempProject({ lint: "nonexistent-command-xyz-123", test: "exit 0" });
    const report = await collectVerifyReportAsync(dir);
    expect(report).toHaveProperty("ok");
    expect(Array.isArray(report.toolchain)).toBe(true);
    for (const gate of report.toolchain) {
      expect(typeof gate.label).toBe("string");
      expect(typeof gate.pass).toBe("boolean");
    }
  });

  test("gradle toolchain reports pass=false when the check fails", async () => {
    // detectToolchain returns { kind: "gradle" } when build.gradle exists
    // and no package.json is present. A failing gradle check (status 1) must
    // surface pass=false. Uses fakeSpawner(1): the real-spawner default path is
    // already covered by "default spawner error handler on non-existent binary",
    // and GitHub runners ship gradle, so a real `gradle check` hangs >30s (flaky).
    const dir = mkdtempSync(join(tmpdir(), "vf-gradle-test-"));
    writeFileSync(join(dir, "build.gradle"), "");
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(1) });
    expect(report).toHaveProperty("ok");
    expect(report.toolchain.length).toBeGreaterThanOrEqual(1);
    const first = report.toolchain[0] as { label: string; pass: boolean };
    expect(first.pass).toBe(false);
  });

  test("gradle toolchain with fakeSpawner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-gradle-test-"));
    writeFileSync(join(dir, "build.gradle"), "");
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(0) });
    expect(report).toHaveProperty("ok");
    expect(report.toolchain.length).toBe(1);
    const first = report.toolchain[0] as { label: string; pass: boolean };
    expect(first.label).toMatch(/gradle|check/);
    expect(first.pass).toBe(true);
  });

  test("monorepo toolchain with fakeSpawner", async () => {
    // detectToolchain returns { kind: "monorepo" } when a subdirectory
    // (web/app/frontend) contains a package.json with typecheck/lint/test scripts.
    const dir = mkdtempSync(join(tmpdir(), "vf-monorepo-test-"));
    const webDir = join(dir, "web");
    mkdirSync(webDir, { recursive: true });
    writeFileSync(
      join(webDir, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc", lint: "biome", test: "vitest" } }, null, 2),
    );
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(0) });
    expect(report).toHaveProperty("ok");
    expect(report.toolchain.length).toBe(3);
    for (const gate of report.toolchain) {
      expect(gate.label).toContain("(web)");
      expect(gate.pass).toBe(true);
    }
  });

  test("returns ok=false when gradle check fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-gradle-fail-"));
    writeFileSync(join(dir, "build.gradle"), "");
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(1) });
    expect(report.ok).toBe(false);
    expect(report.toolchain.length).toBe(1);
    const first = report.toolchain[0] as { label: string; pass: boolean };
    expect(first.pass).toBe(false);
  });

  test("coverage gate runs when lcov.info exists and coverage=true", async () => {
    const dir = tempProject({ typecheck: "exit 0", test: "exit 0" });
    const covDir = join(dir, "coverage");
    mkdirSync(covDir, { recursive: true });
    writeFileSync(
      join(covDir, "lcov.info"),
      "TN:\nSF:src/index.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n",
    );
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(0), coverage: true });
    const covGate = report.toolchain.find((g) => g.label === "coverage:gate") as
      | { label: string; pass: boolean }
      | undefined;
    expect(covGate).toBeDefined();
    expect((covGate as { label: string; pass: boolean }).pass).toBe(true);
  });

  test("coverage gate skipped when lcov.info missing", async () => {
    const dir = tempProject({ typecheck: "exit 0" });
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(0), coverage: true });
    const covGate = report.toolchain.find((g) => g.label === "coverage:gate");
    expect(covGate).toBeUndefined();
  });

  test("flutter toolchain runs flutter test (#440)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-flutter-test-"));
    writeFileSync(join(dir, "pubspec.yaml"), "name: test\n");
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(0) });
    expect(report.toolchain.length).toBe(1);
    const gate = report.toolchain[0] as { label: string; pass: boolean };
    expect(gate.label).toMatch(/flutter.*test|test/);
    expect(gate.pass).toBe(true);
  });

  test("flutter toolchain iterates plan.gates not hardcoded (#446 fix)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-flutter-loop-"));
    writeFileSync(join(dir, "pubspec.yaml"), "name: test\n");
    const called: { cmd: string; args: string[] }[] = [];
    const spawner = async (cmd: string, args: string[]) => {
      called.push({ cmd, args: [...args] });
      return { status: 0 };
    };
    await collectVerifyReportAsync(dir, { spawner });
    expect(called).toHaveLength(1);
    expect(called[0]?.cmd).toBe("flutter");
    expect(called[0]?.args).toEqual(["test"]);
  });

  test("collectVerifyReportAsync: accepts goalEvalFn inject returning covered", async () => {
    const spawner = async () => ({ status: 0 });
    const goalEvalFn = async () => ({ covered: true, uncovered: [] as string[] });
    const report = await collectVerifyReportAsync(tmp, { spawner, goalEvalFn, goal: "add X" });
    expect(report.goalEval).toBeDefined();
    expect(report.goalEval?.pass).toBe(true);
    expect(report.goalEval?.uncovered).toHaveLength(0);
  });

  test("collectVerifyReportAsync: goalEvalFn inject returning uncovered items causes goalEval.pass=false", async () => {
    const spawner = async () => ({ status: 0 });
    const goalEvalFn = async () => ({ covered: false, uncovered: ["edge case: empty input"] });
    const report = await collectVerifyReportAsync(tmp, { spawner, goalEvalFn, goal: "add X" });
    expect(report.goalEval?.pass).toBe(false);
    expect(report.goalEval?.uncovered).toEqual(["edge case: empty input"]);
  });

  test("collectVerifyReportAsync: goalEval skipped when no goal provided", async () => {
    const spawner = async () => ({ status: 0 });
    const goalEvalFn = async () => ({ covered: false, uncovered: ["should not run"] });
    const report = await collectVerifyReportAsync(tmp, { spawner, goalEvalFn }); // no goal
    expect(report.goalEval).toBeUndefined();
  });

  test("collectVerifyReportAsync: goalEval skipped when toolchain fails", async () => {
    const spawner = async () => ({ status: 1 }); // toolchain fail
    const goalEvalFn = async () => ({ covered: false, uncovered: ["should not run"] });
    const report = await collectVerifyReportAsync(tmp, { spawner, goalEvalFn, goal: "add X" });
    expect(report.goalEval).toBeUndefined(); // only run when toolchain passes
  });

  test("collectVerifyReportAsync: goalEvalFn called in production path when goal provided", async () => {
    let called = false;
    const goalEvalFn = async (goal: string) => {
      called = true;
      expect(goal).toBe("add X feature");
      return { covered: true, uncovered: [] as string[] };
    };
    const spawner = async () => ({ status: 0 });
    const report = await collectVerifyReportAsync(tmp, {
      spawner,
      goal: "add X feature",
      goalEvalFn,
    });
    expect(called).toBe(true);
    expect(report.goalEval?.pass).toBe(true);
  });

  test("collectVerifyReportAsync: goalEval.pass=false when LLM reports uncovered", async () => {
    const goalEvalFn = async () => ({
      covered: false,
      uncovered: ["edge case: empty string not handled"],
    });
    const spawner = async () => ({ status: 0 });
    const report = await collectVerifyReportAsync(tmp, { spawner, goal: "g", goalEvalFn });
    expect(report.goalEval?.pass).toBe(false);
    expect(report.ok).toBe(false);
  });
});

test("defaultGoalEvalFn: catch block — git diff throws → still returns covered=true (fail-open)", async () => {
  // Temporarily change cwd to a non-git path so git diff throws internally
  const orig = process.cwd();
  process.chdir("/tmp");
  const origEnv = process.env.VIBEFLOW_AI;
  // biome-ignore lint/performance/noDelete: Bun 1.3 assigns undefined as string "undefined"
  delete process.env.VIBEFLOW_AI;
  const result = await defaultGoalEvalFn("any goal");
  process.chdir(orig);
  if (origEnv !== undefined) process.env.VIBEFLOW_AI = origEnv;
  expect(result.covered).toBe(true); // fail-open
});

test("defaultGoalEvalFn: injected spawner throws → diff catch → covered=true (no bridge)", async () => {
  const origEnv = process.env.VIBEFLOW_AI;
  // biome-ignore lint/performance/noDelete: Bun 1.3 assigns undefined as string "undefined"
  delete process.env.VIBEFLOW_AI;
  let calls = 0;
  const result = await defaultGoalEvalFn("any goal", () => {
    calls++;
    throw new Error("ENOENT: git not found");
  });
  if (origEnv !== undefined) process.env.VIBEFLOW_AI = origEnv;
  expect(calls).toBe(1); // diff spawner attempted, bridge skipped
  expect(result).toEqual({ covered: true, uncovered: [] });
});

test("defaultGoalEvalFn: injected spawner throws with bridge set → bridge catch → covered=true", async () => {
  const origEnv = process.env.VIBEFLOW_AI;
  process.env.VIBEFLOW_AI = "echo COVERED";
  let calls = 0;
  const result = await defaultGoalEvalFn("any goal", () => {
    calls++;
    throw new Error("ENOENT: bridge binary not found");
  });
  // biome-ignore lint/performance/noDelete: Bun 1.3 assigns undefined as string "undefined"
  if (origEnv === undefined) delete process.env.VIBEFLOW_AI;
  else process.env.VIBEFLOW_AI = origEnv;
  expect(calls).toBe(2); // both diff + bridge spawners attempted and threw
  expect(result).toEqual({ covered: true, uncovered: [] });
});

test("defaultGoalEvalFn: returns covered=true when VIBEFLOW_AI not set", async () => {
  const origEnv = process.env.VIBEFLOW_AI;
  // biome-ignore lint/performance/noDelete: Bun 1.3 assigns undefined as string "undefined"
  delete process.env.VIBEFLOW_AI;
  const result = await defaultGoalEvalFn("any goal");
  expect(result.covered).toBe(true);
  if (origEnv !== undefined) process.env.VIBEFLOW_AI = origEnv;
});

test("defaultGoalEvalFn: returns covered=true when VIBEFLOW_AI set to echo COVERED", async () => {
  const orig = process.env.VIBEFLOW_AI;
  process.env.VIBEFLOW_AI = "echo COVERED";
  const result = await defaultGoalEvalFn("add X feature");
  expect(result.covered).toBe(true);
  expect(result.uncovered).toHaveLength(0);
  if (orig === undefined) process.env.VIBEFLOW_AI = undefined;
  else process.env.VIBEFLOW_AI = orig;
});

test("defaultGoalEvalFn: returns covered=false when VIBEFLOW_AI returns non-COVERED", async () => {
  const orig = process.env.VIBEFLOW_AI;
  process.env.VIBEFLOW_AI = "echo Missing edge case: empty input";
  const result = await defaultGoalEvalFn("add X feature");
  expect(result.covered).toBe(false);
  expect(result.uncovered.length).toBeGreaterThan(0);
  if (orig === undefined) process.env.VIBEFLOW_AI = undefined;
  else process.env.VIBEFLOW_AI = orig;
});

test("runWaiverGate returns true when waiver-policy.cjs does not exist (skip-missing #679)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-waiver-none-"));
  expect(runWaiverGate(dir)).toBe(true);
});

test("runWaiverGate returns false when spawner exits non-zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-waiver-fail-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "waiver-policy.cjs"), "process.exit(1)\n");
  const spawner = (() => ({
    status: 1,
    stdout: "",
    stderr: "",
    pid: 0,
    output: [],
    signal: null,
  })) as never;
  expect(runWaiverGate(dir, { spawner })).toBe(false);
});

test("runWaiverGate returns true when spawner exits zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-waiver-ok-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "waiver-policy.cjs"), "process.exit(0)\n");
  const spawner = (() => ({
    status: 0,
    stdout: "",
    stderr: "",
    pid: 0,
    output: [],
    signal: null,
  })) as never;
  expect(runWaiverGate(dir, { spawner })).toBe(true);
});
