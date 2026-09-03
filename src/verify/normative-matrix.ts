import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type NormativeProofDefinitionV2,
  catalogDigests,
  proofCatalogFailures,
} from "./normative-evidence-catalog.js";
import {
  CAPABILITY_DESIGN_PATH,
  CAPABILITY_MATRIX_PATH,
  CAPABILITY_PROOF_MANIFEST_PATH,
  type NormativeProofManifestV2,
  buildNormativeMatrix,
  canonicalJson,
  normativeManifestPayloadDigest,
  sha256Text,
} from "./normative-matrix-source.js";
import { normativeRunnerCommand } from "./normative-proof-run.js";
import {
  normativeManifestShape,
  normativeMatrixShape,
  normativeProofRunShape,
} from "./normative-schema.js";

const MAX_DESIGN_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_MATRIX_BYTES = 32 * 1024 * 1024;

export interface NormativeMatrixCheckResult {
  applicable: boolean;
  ok: boolean;
  details: string;
  evidence_refs: string[];
  atom_count: number;
  candidate_count: number;
  proof_count: number;
}

export interface NormativeMatrixCheckOptions {
  designText?: string;
  manifestText?: string;
  manifestValue?: unknown;
  matrixText?: string;
  matrixValue?: unknown;
  proofRun?: unknown;
  requireProofRun?: boolean;
}

function readBounded(path: string, maximum: number): string {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > maximum) throw new Error("normative matrix input is invalid");
  return readFileSync(path, "utf8");
}

function referencedCatalog(manifest: NormativeProofManifestV2): NormativeProofDefinitionV2[] {
  const ids = new Set(manifest.section_dispositions.flatMap((entry) => entry.proof_ids));
  const catalog = new Map(manifest.proof_catalog.map((proof) => [proof.id, proof]));
  return [...ids].sort().map((id) => {
    const proof = catalog.get(id);
    if (!proof) throw new Error(`referenced proof is absent ${id}`);
    return proof;
  });
}

function manifestFailures(manifest: NormativeProofManifestV2, designDigest: string): string[] {
  const failures: string[] = [];
  if (manifest.review.reviewed_payload_sha256 !== normativeManifestPayloadDigest(manifest)) {
    failures.push("manifest review binding is stale");
  }
  const referenced = new Set(manifest.section_dispositions.flatMap((entry) => entry.proof_ids));
  for (const proof of manifest.proof_catalog)
    if (!referenced.has(proof.id)) failures.push(`unused proof ${proof.id}`);
  for (const waiver of manifest.waivers) {
    if (waiver.reviewed_design_sha256 !== designDigest)
      failures.push(`waiver design binding is stale ${waiver.id}`);
    if (Date.parse(`${waiver.expires_on}T23:59:59Z`) < Date.now())
      failures.push(`waiver is expired ${waiver.id}`);
  }
  return failures;
}

function proofRunFailures(
  base: string,
  designText: string,
  manifestText: string,
  catalog: readonly NormativeProofDefinitionV2[],
  value: unknown,
): string[] {
  if (!normativeProofRunShape(value))
    return ["same-invocation structured proof run is absent or invalid"];
  const failures = [...value.errors];
  const digests = catalogDigests(base, catalog);
  if (value.design_sha256 !== sha256Text(designText))
    failures.push("proof run design digest is stale");
  if (value.manifest_sha256 !== sha256Text(manifestText))
    failures.push("proof run manifest digest is stale");
  if (value.test_sha256 !== digests.test_sha256) failures.push("proof run test digest is stale");
  if (value.production_sha256 !== digests.production_sha256)
    failures.push("proof run production digest is stale");
  const proofs = new Map(value.proofs.map((proof) => [proof.id, proof]));
  if (proofs.size !== value.proofs.length) failures.push("proof run contains duplicate proof IDs");
  for (const expected of catalog) {
    const actual = proofs.get(expected.id);
    const digest = digests.proofs[expected.id];
    if (!actual) failures.push(`proof was not reported ${expected.id}`);
    else if (
      actual.runner !== expected.runner ||
      !actual.executed ||
      actual.status !== "passed" ||
      actual.exit_code !== 0 ||
      actual.test_sha256 !== digest?.test_sha256 ||
      actual.production_sha256 !== digest?.production_sha256
    )
      failures.push(`proof did not pass exact preimages ${expected.id}`);
  }
  for (const id of proofs.keys())
    if (!catalog.some((proof) => proof.id === id)) failures.push(`extra proof result ${id}`);
  const runners = new Map(value.runner_runs.map((run) => [run.runner, run]));
  if (runners.size !== value.runner_runs.length)
    failures.push("proof run contains duplicate runners");
  for (const runner of new Set(catalog.map((proof) => proof.runner))) {
    const run = runners.get(runner);
    if (
      !run ||
      !run.executed ||
      run.status !== "passed" ||
      run.exit_code !== 0 ||
      run.version_exit_code !== 0 ||
      !run.version.trim() ||
      run.argv.length === 0
    )
      failures.push(`runner did not execute successfully ${runner}`);
    if (run && runner !== "manual") {
      const expected = normativeRunnerCommand(
        runner,
        catalog.filter((proof) => proof.runner === runner),
        "<temporary-report>",
      );
      const normalizedArgv = run.argv.map((argument) =>
        argument.startsWith("--reporter-outfile=")
          ? "--reporter-outfile=<temporary-report>"
          : argument,
      );
      if (
        canonicalJson(normalizedArgv) !== canonicalJson([expected.command, ...expected.args]) ||
        canonicalJson(run.version_argv) !==
          canonicalJson([expected.command, ...expected.versionArgs])
      )
        failures.push(`runner argv does not bind the exact proof selection ${runner}`);
    }
  }
  for (const runner of runners.keys())
    if (!catalog.some((proof) => proof.runner === runner))
      failures.push(`extra runner result ${runner}`);
  return failures;
}

function failureResult(failures: readonly string[], atomCount = 0): NormativeMatrixCheckResult {
  const shown = failures.slice(0, 8);
  return {
    applicable: true,
    ok: false,
    details: `normative matrix failed: ${shown.join("; ")}${failures.length > shown.length ? `; +${failures.length - shown.length} more` : ""}`,
    evidence_refs: [CAPABILITY_DESIGN_PATH, CAPABILITY_PROOF_MANIFEST_PATH, CAPABILITY_MATRIX_PATH],
    atom_count: atomCount,
    candidate_count: 0,
    proof_count: 0,
  };
}

export function checkNormativeMatrix(
  base: string,
  options: NormativeMatrixCheckOptions = {},
): NormativeMatrixCheckResult {
  const designPath = join(base, CAPABILITY_DESIGN_PATH);
  if (options.designText === undefined && !existsSync(designPath)) {
    return {
      applicable: false,
      ok: true,
      details: "normative matrix is not applicable",
      evidence_refs: [],
      atom_count: 0,
      candidate_count: 0,
      proof_count: 0,
    };
  }
  try {
    const designText = options.designText ?? readBounded(designPath, MAX_DESIGN_BYTES);
    const manifestText =
      options.manifestText ??
      readBounded(join(base, CAPABILITY_PROOF_MANIFEST_PATH), MAX_MANIFEST_BYTES);
    const manifestValue = options.manifestValue ?? (JSON.parse(manifestText) as unknown);
    if (!normativeManifestShape(manifestValue))
      return failureResult(["proof manifest schema is invalid"]);
    const expected = buildNormativeMatrix(designText, manifestValue, manifestText);
    const matrixText =
      options.matrixText ??
      (options.matrixValue === undefined
        ? readBounded(join(base, CAPABILITY_MATRIX_PATH), MAX_MATRIX_BYTES)
        : undefined);
    const matrixValue = options.matrixValue ?? (JSON.parse(matrixText ?? "null") as unknown);
    if (!normativeMatrixShape(matrixValue))
      return failureResult(["matrix schema is invalid"], expected.atoms.length);
    const failures: string[] = [];
    if (canonicalJson(JSON.parse(manifestText) as unknown) !== canonicalJson(manifestValue)) {
      failures.push("manifest value does not match manifest bytes");
    }
    if (
      matrixText !== undefined
        ? matrixText !== `${JSON.stringify(expected, null, 2)}\n`
        : canonicalJson(matrixValue) !== canonicalJson(expected)
    )
      failures.push("tracked matrix is not byte-current");
    failures.push(...manifestFailures(manifestValue, expected.design.sha256));
    const catalog = referencedCatalog(manifestValue);
    failures.push(...proofCatalogFailures(base, catalog));
    if (options.requireProofRun !== false) {
      failures.push(...proofRunFailures(base, designText, manifestText, catalog, options.proofRun));
    }
    if (failures.length) return failureResult(failures, expected.atoms.length);
    const candidateCount = expected.atoms.reduce(
      (total, atom) => total + atom.candidates.length,
      0,
    );
    return {
      applicable: true,
      ok: true,
      details: `normative matrix passed: ${expected.atoms.length} exact atoms, ${candidateCount} mandatory candidates, ${catalog.length} same-invocation proofs`,
      evidence_refs: [
        CAPABILITY_DESIGN_PATH,
        CAPABILITY_PROOF_MANIFEST_PATH,
        CAPABILITY_MATRIX_PATH,
      ],
      atom_count: expected.atoms.length,
      candidate_count: candidateCount,
      proof_count: catalog.length,
    };
  } catch (error) {
    return failureResult([
      error instanceof Error ? error.message : "normative matrix check failed",
    ]);
  }
}
