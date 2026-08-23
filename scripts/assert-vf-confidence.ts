#!/usr/bin/env bun
import { collectVerifyReportAsync } from "../src/commands/tools-detect.js";
import type { VerifyCoreReport } from "../src/verify/core.js";

export function assertionPayload(report: VerifyCoreReport): {
  confidence: number;
  gates: VerifyCoreReport["gates"];
} {
  return { confidence: report.confidence, gates: report.gates };
}

export function confidenceAssertionExitCode(report: VerifyCoreReport, expected: number): number {
  return report.ok && report.confidence === expected ? 0 : 1;
}

type ParsedArgs = { expected: number; coverage: boolean; reviewBase?: string };

function parseArgs(argv: readonly string[]): ParsedArgs {
  let expected: number | undefined;
  let coverage = false;
  let reviewBase: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--coverage") coverage = true;
    else if (arg === "--expected") {
      const raw = argv[++index];
      expected = raw === undefined ? undefined : Number(raw);
    } else if (arg === "--review-base") reviewBase = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (expected === undefined || !Number.isFinite(expected) || expected < 0 || expected > 1)
    throw new Error("--expected must be a finite number in [0,1]");
  if (reviewBase === undefined && argv.includes("--review-base"))
    throw new Error("--review-base requires a SHA");
  return { expected, coverage, ...(reviewBase ? { reviewBase } : {}) };
}

export async function runConfidenceAssertion(
  argv: readonly string[],
  inject: {
    cwd?: () => string;
    collect?: typeof collectVerifyReportAsync;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    (inject.stderr ?? console.error)(String((error as Error).message));
    return 2;
  }
  const report = await (inject.collect ?? collectVerifyReportAsync)((inject.cwd ?? process.cwd)(), {
    coverage: args.coverage,
    ...(args.reviewBase ? { reviewBase: args.reviewBase } : {}),
  });
  (inject.stdout ?? console.log)(JSON.stringify(assertionPayload(report)));
  return confidenceAssertionExitCode(report, args.expected);
}

if (import.meta.main) process.exitCode = await runConfidenceAssertion(process.argv.slice(2));
