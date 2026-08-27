import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NormativeCatalogDigests,
  type NormativeProofDefinitionV2,
  type NormativeProofRunner,
  catalogDigests,
  catalogShape,
  proofCatalogFailures,
} from "./normative-evidence-catalog.js";
import {
  CAPABILITY_DESIGN_PATH,
  CAPABILITY_PROOF_MANIFEST_PATH,
  sha256Text,
} from "./normative-matrix-source.js";
import {
  type ObservedCase,
  observedCasesFor,
  parseBunJunit,
  parsePlaywrightJson,
} from "./normative-proof-report.js";
import { VERIFY_RUNTIME_AUTHORITY } from "./runtime-authority.js";

export { type ObservedCase, parseBunJunit, parsePlaywrightJson } from "./normative-proof-report.js";

export const NORMATIVE_PROOF_RUN_PROFILE = "vf-normative-proof-run/2" as const;
export type NormativeProofStatus = "passed" | "failed" | "skipped" | "not-executed";

export interface NormativeRunnerExecutionV2 {
  runner: NormativeProofRunner;
  version: string;
  version_argv: string[];
  version_exit_code: number | null;
  argv: string[];
  executed: boolean;
  exit_code: number | null;
  status: NormativeProofStatus;
  stdout_sha256: string;
  stderr_sha256: string;
}

export interface NormativeProofExecutionV2 {
  id: string;
  runner: NormativeProofRunner;
  executed: boolean;
  status: NormativeProofStatus;
  exit_code: number | null;
  test_sha256: string;
  production_sha256: string;
}

export interface NormativeProofRunV2 {
  schema_version: "2.0";
  profile: typeof NORMATIVE_PROOF_RUN_PROFILE;
  design_sha256: string;
  manifest_sha256: string;
  test_sha256: string;
  production_sha256: string;
  runner_runs: NormativeRunnerExecutionV2[];
  proofs: NormativeProofExecutionV2[];
  errors: string[];
}

interface ProofRunOptions {
  spawner?: typeof spawnSync;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const ZERO_DIGEST = "0".repeat(64);

function boundedText(path: string, maximum: number): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximum)
    throw new Error("normative proof input is invalid");
  return readFileSync(path, "utf8");
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value == null ? "" : String(value);
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface NormativeRunnerCommandV2 {
  command: string;
  args: string[];
  versionArgs: string[];
}

export function normativeRunnerCommand(
  runner: Exclude<NormativeProofRunner, "manual">,
  proofs: readonly NormativeProofDefinitionV2[],
  reportPath: string,
): NormativeRunnerCommandV2 {
  const paths = [...new Set(proofs.map((proof) => proof.path))].sort();
  const pattern = `^(?:${proofs.map((proof) => escapePattern(proof.title)).join("|")})$`;
  if (runner === "bun") {
    return {
      command: "bun",
      versionArgs: ["--version"],
      args: [
        "test",
        ...paths,
        "--test-name-pattern",
        pattern,
        "--reporter=junit",
        `--reporter-outfile=${reportPath}`,
        "--timeout",
        "30000",
      ],
    };
  }
  return {
    command: "bunx",
    versionArgs: ["playwright", "--version"],
    args: ["playwright", "test", ...paths, "--grep", pattern, "--reporter=json"],
  };
}

export function emptyNormativeProofRun(errors: string[]): NormativeProofRunV2 {
  return {
    schema_version: "2.0",
    profile: NORMATIVE_PROOF_RUN_PROFILE,
    design_sha256: ZERO_DIGEST,
    manifest_sha256: ZERO_DIGEST,
    test_sha256: ZERO_DIGEST,
    production_sha256: ZERO_DIGEST,
    runner_runs: [],
    proofs: [],
    errors,
  };
}

export interface NormativeProofPreparationV2 {
  report: NormativeProofRunV2;
  proofs: NormativeProofDefinitionV2[];
  digests?: NormativeCatalogDigests;
}

function referencedProofs(manifest: Record<string, unknown>): NormativeProofDefinitionV2[] {
  if (!catalogShape(manifest.proof_catalog)) throw new Error("proof catalog schema is invalid");
  if (!Array.isArray(manifest.section_dispositions))
    throw new Error("section dispositions are invalid");
  const ids = new Set<string>();
  for (const value of manifest.section_dispositions) {
    if (!value || typeof value !== "object") throw new Error("section disposition is invalid");
    const proofIds = (value as { proof_ids?: unknown }).proof_ids;
    if (!Array.isArray(proofIds) || !proofIds.every((id) => typeof id === "string")) {
      throw new Error("section proof IDs are invalid");
    }
    for (const id of proofIds) ids.add(id);
  }
  const catalog = new Map(manifest.proof_catalog.map((proof) => [proof.id, proof]));
  return [...ids].sort().map((id) => {
    const proof = catalog.get(id);
    if (!proof) throw new Error(`referenced proof is absent ${id}`);
    return proof;
  });
}

export function prepareNormativeProofRun(base: string): NormativeProofPreparationV2 {
  try {
    const designText = boundedText(join(base, CAPABILITY_DESIGN_PATH), 4 * 1024 * 1024);
    const manifestText = boundedText(join(base, CAPABILITY_PROOF_MANIFEST_PATH), 8 * 1024 * 1024);
    const parsed = JSON.parse(manifestText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("manifest schema is invalid");
    const proofs = referencedProofs(parsed as Record<string, unknown>);
    const failures = proofCatalogFailures(base, proofs);
    if (failures.length) return { report: emptyNormativeProofRun(failures), proofs };
    const digests = catalogDigests(base, proofs);
    return {
      report: {
        schema_version: "2.0",
        profile: NORMATIVE_PROOF_RUN_PROFILE,
        design_sha256: sha256Text(designText),
        manifest_sha256: sha256Text(manifestText),
        test_sha256: digests.test_sha256,
        production_sha256: digests.production_sha256,
        runner_runs: [],
        proofs: [],
        errors: [],
      },
      proofs,
      digests,
    };
  } catch (error) {
    return {
      report: emptyNormativeProofRun([
        error instanceof Error ? error.message : "normative proof setup failed",
      ]),
      proofs: [],
    };
  }
}

export function runNormativeProofs(
  base: string,
  options: ProofRunOptions = {},
): NormativeProofRunV2 {
  const preparation = prepareNormativeProofRun(base);
  if (!preparation.digests) return preparation.report;
  const { report, proofs, digests } = preparation;
  const spawner = options.spawner ?? spawnSync;
  const temporary = mkdtempSync(join(tmpdir(), "vf-normative-proof-"));
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
          if (!digest) continue;
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
      const reportPath = join(temporary, `${runner}.xml`);
      const command = normativeRunnerCommand(runner, selected, reportPath);
      const version = spawner(command.command, command.versionArgs, {
        cwd: base,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const versionText = `${outputText(version.stdout)} ${outputText(version.stderr)}`.trim();
      let result: ReturnType<typeof spawnSync> | undefined;
      let stdout = "";
      let stderr = "";
      let cases: ObservedCase[] = [];
      if (version.status === 0) {
        result = spawner(command.command, command.args, {
          cwd: base,
          encoding: "utf8",
          timeout: VERIFY_RUNTIME_AUTHORITY.gateTimeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        });
        stdout = outputText(result.stdout);
        stderr = outputText(result.stderr);
        try {
          cases =
            runner === "bun"
              ? parseBunJunit(boundedText(reportPath, 32 * 1024 * 1024))
              : parsePlaywrightJson(stdout);
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
      const runStatus: NormativeProofStatus =
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
        status: runStatus,
        stdout_sha256: sha256(stdout),
        stderr_sha256: sha256(stderr),
      });
      for (const { proof, testcase } of observed) {
        const digest = digests.proofs[proof.id];
        if (!digest) continue;
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
