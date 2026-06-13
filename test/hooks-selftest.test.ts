import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookSelftest } from "../src/commands.js";
import { runSelftest, type SelftestReport } from "../src/hooks/selftest.js";

// --- Baseline: all 19 corpus cases pass, full branch coverage of reachable paths ---
describe("runSelftest: full corpus report shape", () => {
  test("report has timestamp, passed, failed, and one entry per corpus case", () => {
    const now = "2026-06-13T00:00:00.000Z";
    const report: SelftestReport = runSelftest(() => now);

    expect(report.timestamp).toBe(now);
    // 9 ATTACK + 7 BENIGN + 3 CONFIG + 1 ALLOWED pre-write = 20
    expect(report.cases.length).toBe(20);
    expect(report.passed + report.failed).toBe(report.cases.length);
    // With the real evaluator, every corpus case is expected to land on its expected outcome.
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(20);
    for (const c of report.cases) {
      expect(c.pass).toBe(true);
      // decision must be one of the four guardrail decisions
      expect(["allow", "warn", "require_approval", "block"]).toContain(c.decision);
    }
  });

  test("pre-command attack cases land on actual='blocked' (decision block)", () => {
    const report = runSelftest(() => "t");
    const attacks = report.cases.filter(
      (c) => c.event === "pre-command" && c.expected === "blocked",
    );
    expect(attacks.length).toBe(9);
    for (const a of attacks) {
      expect(a.actual).toBe("blocked");
      // Real corpus: every attack triggers 'block' (critical risk).
      expect(a.decision).toBe("block");
    }
  });

  test("pre-command benign cases land on actual='allowed' (decision allow/warn)", () => {
    const report = runSelftest(() => "t");
    const benign = report.cases.filter(
      (c) => c.event === "pre-command" && c.expected === "allowed",
    );
    expect(benign.length).toBe(7);
    for (const b of benign) {
      expect(b.actual).toBe("allowed");
      expect(["allow", "warn"]).toContain(b.decision);
    }
  });

  test("pre-write config cases (tsconfig/biome/.githooks) are reported as actual='blocked'", () => {
    const report = runSelftest(() => "t");
    const configCases = report.cases.filter(
      (c) =>
        c.event === "pre-write" &&
        c.expected === "blocked" &&
        (c.input === "tsconfig.json" ||
          c.input === "biome.json" ||
          c.input === ".githooks/pre-commit"),
    );
    expect(configCases.length).toBe(3);
    for (const c of configCases) {
      // actual='blocked' is set whenever decision is 'block' OR 'require_approval'.
      expect(c.actual).toBe("blocked");
      // Config files are sensitive — risk scorer classifies them as 'high' →
      // decision is 'require_approval', which still counts as blocking.
      expect(c.decision).toBe("require_approval");
      expect(c.pass).toBe(true);
    }
  });

  test("pre-write src/foo.ts lands on actual='allowed'", () => {
    const report = runSelftest(() => "t");
    const allowed = report.cases.find(
      (c) => c.event === "pre-write" && c.expected === "allowed" && c.input === "src/foo.ts",
    );
    expect(allowed).toBeDefined();
    expect(allowed?.actual).toBe("allowed");
    expect(allowed?.pass).toBe(true);
  });

  test("caseLabel path: pre-command uses command string as input label", () => {
    const report = runSelftest(() => "t");
    const first = report.cases.find((c) => c.event === "pre-command");
    expect(first).toBeDefined();
    // The label is the raw command string for pre-command cases.
    expect(first?.input).toBe("bash -c \"rm -rf /\"");
  });

  test("caseLabel path: pre-write joins files with ', ' as input label", () => {
    const report = runSelftest(() => "t");
    const first = report.cases.find(
      (c) => c.event === "pre-write" && c.expected === "blocked",
    );
    expect(first).toBeDefined();
    expect(first?.input).toBe("tsconfig.json");
  });
});

// --- Drive the public hookSelftest entry to make sure it round-trips a real report ---
describe("hookSelftest writes a report covering the same corpus", () => {
  const dirs: string[] = [];
  function freshDir(): string {
    const d = mkdtempSync(join(tmpdir(), "vf-selftest-cov-"));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  test("writes hook-selfcheck.json with same totals as runSelftest", () => {
    const dir = freshDir();
    const now = "2026-06-13T01:00:00.000Z";
    const code = hookSelftest({ base: dir, now: () => now });
    expect(code).toBe(0);
    const report = JSON.parse(
      readFileSync(join(dir, ".vibeflow", "knowledge", "hook-selfcheck.json"), "utf8"),
    ) as SelftestReport;
    expect(report.timestamp).toBe(now);
    expect(report.passed).toBe(20);
    expect(report.failed).toBe(0);
    expect(report.cases.length).toBe(20);
  });
});

// --- Mock-driven coverage: force 'require_approval' on attack cases too ---
// The real corpus already produces 'require_approval' for the 3 config-file cases
// (tsconfig.json / biome.json / .githooks/pre-commit) and 'block' for the 9 attack
// commands, so the (||) short-circuit branches on line 91 are both hit by the
// baseline test above. The mocks below add explicit assertions for the
// "every case is require_approval" path so the report structure (passed/failed
// counters) is exercised under a uniform high-risk outcome, locking the contract
// that any blocking decision — block OR require_approval — yields actual='blocked'.
describe("runSelftest: decision 'require_approval' branch (high risk)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../src/hooks/runner.js");
  });

  test("a single case with decision='require_approval' is reported as actual='blocked'", async () => {
    const runner = await import("../src/hooks/runner.js");
    const realEvaluate = runner.evaluateHook;
    const spy = vi.spyOn(runner, "evaluateHook").mockImplementation((input, getEnv) => {
      // Force a 'high' risk outcome for one specific benign command — proves the
      // right side of `decision === "block" || decision === "require_approval"`
      // short-circuit can be reached with a true right operand.
      if (input.command === "ls -la") {
        return { decision: "require_approval", risk: "high", reasons: ["forced for test"] };
      }
      return realEvaluate(input, getEnv);
    });

    const report = runSelftest(() => "t");

    // The forced case must be classified as blocked (since require_approval is a blocking decision).
    const forced = report.cases.find((c) => c.input === "ls -la");
    expect(forced).toBeDefined();
    expect(forced?.decision).toBe("require_approval");
    expect(forced?.actual).toBe("blocked");
    // expected was "allowed" → this case fails the expectation.
    expect(forced?.pass).toBe(false);

    // And we still see at least one block-from-critical attack case so the
    // left-true short-circuit branch is also covered in the same run.
    const attacks = report.cases.filter((c) => c.expected === "blocked" && c.pass);
    expect(attacks.length).toBeGreaterThan(0);

    expect(spy).toHaveBeenCalled();
  });

  test("mocking every case to 'require_approval' makes every case actual='blocked'", async () => {
    const runner = await import("../src/hooks/runner.js");
    vi.spyOn(runner, "evaluateHook").mockReturnValue({
      decision: "require_approval",
      risk: "high",
      reasons: ["forced"],
    });

    const report = runSelftest(() => "t");

    // Every case lands on 'blocked' actual.
    for (const c of report.cases) {
      expect(c.actual).toBe("blocked");
      expect(c.decision).toBe("require_approval");
    }
    // All attack + config cases pass; all benign cases fail (they expected 'allowed').
    const passing = report.cases.filter((c) => c.expected === "blocked");
    const failing = report.cases.filter((c) => c.expected === "allowed");
    expect(passing.every((c) => c.pass)).toBe(true);
    expect(failing.every((c) => !c.pass)).toBe(true);
    expect(report.passed).toBe(passing.length);
    expect(report.failed).toBe(failing.length);
  });
});

// --- Coverage ceiling doc: branch 1,1 of line 59 is unreachable from tests ---
// selftest.ts line 59 is:
//   return input.command ?? (input.files ?? []).join(", ");
// The second `??` falls back to `[]` only when `input.files` is nullish.
// `caseLabel` is module-private (not exported), so it can only be reached via
// runSelftest -> selftestCases(). selftestCases() always sets `files: [f]`
// for every pre-write case, so `input.files` is never nullish in practice.
// Branch BRDA:59,1,1 therefore has 0 reachable hits without modifying src/.
// This describe block locks the corpus invariant so the ceiling stays
// documented and the reachable 7/8 branches stay green.
describe("runSelftest: corpus invariants that gate the branch-coverage ceiling", () => {
  test("every pre-write case in the corpus carries a non-empty files array", () => {
    const report = runSelftest(() => "t");
    const preWrite = report.cases.filter((c) => c.event === "pre-write");
    expect(preWrite.length).toBe(4); // 3 config + 1 allowed src/foo.ts
    for (const c of preWrite) {
      // The label for pre-write cases is built from files joined with ', '.
      // If a pre-write case ever shipped with no files, its label would be
      // '' (empty), which would surface here as a regression.
      expect(c.input.length).toBeGreaterThan(0);
    }
  });

  test("every pre-command case in the corpus carries a non-empty command string", () => {
    const report = runSelftest(() => "t");
    const preCommand = report.cases.filter((c) => c.event === "pre-command");
    // 9 ATTACK + 7 BENIGN = 16
    expect(preCommand.length).toBe(16);
    for (const c of preCommand) {
      // caseLabel takes the left `??` branch (input.command truthy).
      expect(c.input.length).toBeGreaterThan(0);
      // The label must be the raw command string itself.
      expect(c.input).not.toContain(", ");
    }
  });

  test("runSelftest exposes only runSelftest + types — no leak of caseLabel/selftestCases", async () => {
    const mod = await import("../src/hooks/selftest.js");
    // Sanity: only runSelftest is exported at runtime. The two private helpers
    // (caseLabel, selftestCases) are intentionally not exported, which is
    // exactly why the inner `??` fallback in caseLabel is unreachable from
    // tests — there is no handle to call it with a hand-crafted input.
    // (SelftestReport / SelftestCaseResult are TS interfaces and are erased
    //  at runtime, so they don't show up in Object.keys.)
    expect(Object.keys(mod).sort()).toEqual(["runSelftest"]);
  });
});
