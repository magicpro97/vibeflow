import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectVerifyReportAsync } from "../src/commands/tools-detect.js";
import { verify } from "../src/commands/verify.js";
import { writeState } from "../src/core.js";
import {
  type NormativeAsyncSpawner,
  runNormativeProofsAsync,
} from "../src/verify/normative-proof-run-async.js";
import { runNormativeProofs } from "../src/verify/normative-proof-run.js";
import { VERIFY_RUNTIME_AUTHORITY } from "../src/verify/runtime-authority.js";
import { createNormativeFixture } from "./helpers/normative-proof.js";

function project(scripts: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "vf-verify-authority-"));
  writeFileSync(join(base, "package.json"), JSON.stringify({ scripts }));
  writeState(base, {
    task_id: "verify-authority",
    goal: "fail closed at verifier boundaries",
    success_criteria: [],
    work_units: [],
    totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  });
  return base;
}

function addWaiverGate(base: string): void {
  mkdirSync(join(base, "scripts"), { recursive: true });
  writeFileSync(join(base, "scripts", "waiver-policy.cjs"), "process.exit(0);\n");
}

function writeNormativeJunit(args: readonly string[], path: string, title: string): void {
  const report = args.find((arg) => arg.startsWith("--reporter-outfile="));
  if (!report) throw new Error("normative report argument is absent");
  writeFileSync(
    report.slice("--reporter-outfile=".length),
    `<testsuites><testsuite><testcase name="${title}" file="${path}" /></testsuite></testsuites>`,
  );
}

describe("verify runtime authority", () => {
  test("uses the frozen 15-minute timeout for sync toolchain gates", () => {
    const base = project({ test: "bun test" });
    addWaiverGate(base);
    const calls: Array<{ options?: { timeout?: number } }> = [];
    const spawner = ((_command, _args, options) => {
      calls.push({ options: options as { timeout?: number } });
      return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
    }) as typeof spawnSync;
    try {
      expect(Object.isFrozen(VERIFY_RUNTIME_AUTHORITY)).toBe(true);
      expect(VERIFY_RUNTIME_AUTHORITY.gateTimeoutMs).toBe(900_000);
      expect(verify({ projectDir: base, requireReviewEvidence: false, spawner })).toBe(0);
      expect(calls).toHaveLength(2);
      expect(
        calls.every((call) => call.options?.timeout === VERIFY_RUNTIME_AUTHORITY.gateTimeoutMs),
      ).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("uses the same timeout authority for async toolchain gates", async () => {
    const base = project({ test: "bun test" });
    addWaiverGate(base);
    const timeouts: Array<number | undefined> = [];
    const spawner: NormativeAsyncSpawner = async (_command, _args, options) => {
      timeouts.push(options.timeout);
      return { status: 0 };
    };
    try {
      await collectVerifyReportAsync(base, { spawner, requireReviewEvidence: false });
      expect(timeouts).toEqual([
        VERIFY_RUNTIME_AUTHORITY.gateTimeoutMs,
        VERIFY_RUNTIME_AUTHORITY.gateTimeoutMs,
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("keeps the sync normative version probe short and gives the proof gate 15 minutes", () => {
    const fixture = createNormativeFixture();
    const timeouts: Array<number | undefined> = [];
    const spawner = ((_command, args, options) => {
      timeouts.push((options as { timeout?: number }).timeout);
      if (!(args as readonly string[]).includes("--version")) {
        writeNormativeJunit(args as readonly string[], fixture.proof.path, fixture.proof.title);
      }
      return { status: 0, stdout: Buffer.from("1.4.0"), stderr: Buffer.from("") };
    }) as typeof spawnSync;
    try {
      expect(runNormativeProofs(fixture.base, { spawner }).errors).toEqual([]);
      expect(timeouts).toEqual([30_000, VERIFY_RUNTIME_AUTHORITY.gateTimeoutMs]);
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

  test("keeps the async normative version probe short and gives the proof gate 15 minutes", async () => {
    const fixture = createNormativeFixture();
    const timeouts: Array<number | undefined> = [];
    const spawner: NormativeAsyncSpawner = async (_command, args, options) => {
      timeouts.push(options.timeout);
      if (!args.includes("--version")) {
        writeNormativeJunit(args, fixture.proof.path, fixture.proof.title);
      }
      return { status: 0, stdout: Buffer.from("1.4.0"), stderr: Buffer.from("") };
    };
    try {
      expect((await runNormativeProofsAsync(fixture.base, { spawner })).errors).toEqual([]);
      expect(timeouts).toEqual([30_000, VERIFY_RUNTIME_AUTHORITY.gateTimeoutMs]);
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });

  test("sync --coverage fails when lcov.info is absent", () => {
    const base = project({});
    try {
      expect(
        verify({
          projectDir: base,
          coverage: true,
          requireReviewEvidence: false,
        }),
      ).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("async --coverage exposes a blocking missing-lcov gate", async () => {
    const base = project({});
    let goalEvaluations = 0;
    try {
      const report = await collectVerifyReportAsync(base, {
        coverage: true,
        requireReviewEvidence: false,
        goal: "must have coverage",
        goalEvalFn: async () => {
          goalEvaluations++;
          return { covered: true, uncovered: [] };
        },
      });
      expect(report.ok).toBe(false);
      expect(goalEvaluations).toBe(0);
      expect(report.goalEval).toBeUndefined();
      expect(report.gates.coverage).toMatchObject({
        status: "fail",
        details: "coverage/lcov.info not found",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
