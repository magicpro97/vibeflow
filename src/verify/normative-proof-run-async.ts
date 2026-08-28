import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observedCasesFor } from "./normative-proof-report.js";
import {
  type NormativeProofRunV2,
  type NormativeProofStatus,
  type ObservedCase,
  normativeRunnerCommand,
  normativeRunnerEnvironment,
  parseBunJunit,
  parsePlaywrightJson,
  prepareNormativeProofRun,
} from "./normative-proof-run.js";
import { VERIFY_RUNTIME_AUTHORITY } from "./runtime-authority.js";

export interface NormativeAsyncSpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "ignore" | "pipe";
  timeout?: number;
  maxBuffer?: number;
}

export interface NormativeAsyncCommandResult {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

export type NormativeAsyncSpawner = (
  command: string,
  args: string[],
  options: NormativeAsyncSpawnOptions,
) => Promise<NormativeAsyncCommandResult>;

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value == null ? "" : String(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Async command seam shared by the HTTP verifier and normative runner. */
export const defaultNormativeAsyncSpawner: NormativeAsyncSpawner = (command, args, options) =>
  new Promise((resolve) => {
    const maximum = options.maxBuffer ?? 64 * 1024 * 1024;
    const piped = options.stdio !== "ignore";
    const child = spawn(command, args, {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      stdio: piped ? ["ignore", "pipe", "pipe"] : "ignore",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let overflow = false;
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        status: overflow ? 1 : status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    };
    const append = (destination: Buffer[], chunk: unknown): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += value.length;
      if (bytes > maximum) {
        overflow = true;
        child.kill();
        return;
      }
      destination.push(value);
    };
    child.stdout?.on("data", (chunk) => append(stdout, chunk));
    child.stderr?.on("data", (chunk) => append(stderr, chunk));
    child.on("error", (error) => {
      append(stderr, error.message);
      finish(1);
    });
    child.on("close", finish);
    const timer = options.timeout
      ? setTimeout(() => {
          overflow = true;
          child.kill();
        }, options.timeout)
      : undefined;
  });

function readReport(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 32 * 1024 * 1024) {
    throw new Error("structured report is not a bounded regular file");
  }
  return readFileSync(path, "utf8");
}

async function safelySpawn(
  spawner: NormativeAsyncSpawner,
  command: string,
  args: string[],
  options: NormativeAsyncSpawnOptions,
): Promise<NormativeAsyncCommandResult> {
  try {
    return await spawner(command, args, options);
  } catch (error) {
    return {
      status: 1,
      stderr: error instanceof Error ? error.message : "async proof spawn failed",
    };
  }
}

export async function runNormativeProofsAsync(
  base: string,
  options: { spawner?: NormativeAsyncSpawner } = {},
): Promise<NormativeProofRunV2> {
  const preparation = prepareNormativeProofRun(base);
  if (!preparation.digests) return preparation.report;
  const { report, proofs, digests } = preparation;
  const spawner = options.spawner ?? defaultNormativeAsyncSpawner;
  const temporary = mkdtempSync(join(tmpdir(), "vf-normative-proof-async-"));
  try {
    for (const runner of ["bun", "playwright", "manual"] as const) {
      const selected = proofs.filter((proof) => proof.runner === runner);
      if (!selected.length) continue;
      if (runner === "manual") {
        report.runner_runs.push({
          runner,
          version: "manual",
          version_argv: [],
          version_exit_code: null,
          argv: [],
          executed: false,
          exit_code: null,
          status: "skipped",
          stdout_sha256: sha256(""),
          stderr_sha256: sha256(""),
        });
        for (const proof of selected) {
          const digest = digests.proofs[proof.id];
          if (digest)
            report.proofs.push({
              id: proof.id,
              runner,
              executed: false,
              status: "skipped",
              exit_code: null,
              ...digest,
            });
        }
        continue;
      }

      const reportPath = join(temporary, runner === "bun" ? "bun.xml" : "playwright.json");
      const command = normativeRunnerCommand(runner, selected, reportPath);
      const version = await safelySpawn(spawner, command.command, command.versionArgs, {
        cwd: base,
        stdio: "pipe",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const versionText = `${outputText(version.stdout)} ${outputText(version.stderr)}`.trim();
      let result: NormativeAsyncCommandResult | undefined;
      let stdout = "";
      let stderr = "";
      let cases: ObservedCase[] = [];
      if (version.status === 0) {
        result = await safelySpawn(spawner, command.command, command.args, {
          cwd: base,
          env: normativeRunnerEnvironment(command),
          stdio: "pipe",
          timeout: VERIFY_RUNTIME_AUTHORITY.gateTimeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        });
        stdout = outputText(result.stdout);
        stderr = outputText(result.stderr);
        try {
          cases =
            runner === "bun"
              ? parseBunJunit(readReport(reportPath))
              : parsePlaywrightJson(readReport(reportPath));
        } catch (error) {
          report.errors.push(
            `${runner} structured report is invalid: ${error instanceof Error ? error.message : "parse failed"}`,
          );
        }
      }
      const observed = selected.map((proof) => {
        const matches = observedCasesFor(cases, proof.path, proof.title);
        if (matches.length > 1)
          report.errors.push(`${runner} proof matched ${matches.length} cases ${proof.id}`);
        return { proof, testcase: matches.length === 1 ? matches[0] : undefined };
      });
      const status: NormativeProofStatus =
        version.status !== 0 ||
        result?.status !== 0 ||
        observed.some((item) => item.testcase?.status === "failed")
          ? "failed"
          : observed.some((item) => !item.testcase)
            ? "not-executed"
            : observed.some((item) => item.testcase?.status === "skipped")
              ? "skipped"
              : "passed";
      report.runner_runs.push({
        runner,
        version: versionText,
        version_argv: [command.command, ...command.versionArgs],
        version_exit_code: version.status,
        argv: [command.command, ...command.args],
        executed: Boolean(result),
        exit_code: result?.status ?? null,
        status,
        stdout_sha256: sha256(stdout),
        stderr_sha256: sha256(stderr),
      });
      for (const { proof, testcase } of observed) {
        const digest = digests.proofs[proof.id];
        if (digest)
          report.proofs.push({
            id: proof.id,
            runner,
            executed: Boolean(result && testcase),
            status: testcase?.status ?? "not-executed",
            exit_code: result?.status ?? null,
            ...digest,
          });
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return report;
}
