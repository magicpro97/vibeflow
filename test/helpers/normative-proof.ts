import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { NormativeProofDefinitionV2 } from "../../src/verify/normative-evidence-catalog.js";
import {
  catalogDigests,
  currentProofDigests,
} from "../../src/verify/normative-evidence-catalog.js";
import {
  CAPABILITY_DESIGN_PATH,
  CAPABILITY_MATRIX_PATH,
  CAPABILITY_PROOF_MANIFEST_PATH,
  NORMATIVE_MANIFEST_PROFILE,
  NORMATIVE_REVIEW_STATEMENT,
  type NormativeClauseMatrixV2,
  type NormativeProofManifestV2,
  buildNormativeMatrix,
  extractNormativeAtoms,
  normativeManifestPayloadDigest,
  normativeSectionInventories,
  sha256Text,
} from "../../src/verify/normative-matrix-source.js";
import {
  NORMATIVE_PROOF_RUN_PROFILE,
  type NormativeProofRunV2,
  normativeRunnerCommand,
} from "../../src/verify/normative-proof-run.js";

export const FIXTURE_DESIGN = `# Contract
The host must validate input without clearing the draft and can never reuse hidden history.
Draft → Review
| State | Outcome |
| --- | --- |
| Draft | Review |
type HostActionKind = "conversation.continue_message" | "capability.install";
type ActionRootDomainV1 = "conversation" | "capability";
content_sha256 = lowercaseHex(SHA256(fileBytes))
The HMAC uses digestV1("VF-EXAMPLE\\0v1\\0", value) after canonicalization.
`;

export interface NormativeFixture {
  base: string;
  design: string;
  manifest: NormativeProofManifestV2;
  manifestText: string;
  matrix: NormativeClauseMatrixV2;
  proof: NormativeProofDefinitionV2;
  proofSource: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function write(base: string, path: string, value: string): void {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), value);
}

export function manifestText(manifest: NormativeProofManifestV2): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function reviewManifest(manifest: NormativeProofManifestV2): NormativeProofManifestV2 {
  manifest.review.reviewed_payload_sha256 = normativeManifestPayloadDigest(manifest);
  return manifest;
}

export function createNormativeFixture(design = FIXTURE_DESIGN): NormativeFixture {
  const base = mkdtempSync(join(tmpdir(), "vf-normative-v2-"));
  const proofSource =
    'import { expect, test } from "bun:test";\ntest("exercises the exact reviewed behavior", () => expect(true).toBe(true));\n';
  write(base, CAPABILITY_DESIGN_PATH, design);
  write(base, "test/exact-behavior.test.ts", proofSource);
  write(base, "src/exact-behavior.ts", "export const exactBehavior = true;\n");
  const preimage = currentProofDigests(base, {
    path: "test/exact-behavior.test.ts",
    production_paths: ["src/exact-behavior.ts"],
  });
  const proof: NormativeProofDefinitionV2 = {
    id: "proof:bun:test/exact-behavior.test.ts#exact-reviewed-behavior",
    owner: "foundation-durability-actions",
    runner: "bun",
    assurance: "behavioral",
    path: "test/exact-behavior.test.ts",
    title: "exercises the exact reviewed behavior",
    production_paths: ["src/exact-behavior.ts"],
    ...preimage,
  };
  const atoms = extractNormativeAtoms(design);
  const sections = new Map(atoms.map((atom) => [atom.section_id, atom.section]));
  const inventories = normativeSectionInventories(atoms);
  const manifest: NormativeProofManifestV2 = {
    schema_version: "2.0",
    profile: NORMATIVE_MANIFEST_PROFILE,
    design: { path: CAPABILITY_DESIGN_PATH, sha256: sha256Text(design) },
    proof_catalog: [proof],
    section_dispositions: [...sections].map(([section_id, heading]) => ({
      section_id,
      heading,
      ...(inventories.get(section_id) ??
        (() => {
          throw new Error("section inventory is absent");
        })()),
      disposition: "behavioral",
      owners: [proof.owner],
      proof_ids: [proof.id],
      rationale: "The exact behavioral proof exercises this compact fixture contract.",
      waiver_id: null,
    })),
    waivers: [],
    review: {
      reviewer: "normative-reviewer",
      statement: NORMATIVE_REVIEW_STATEMENT,
      reviewed_payload_sha256: "0".repeat(64),
    },
  };
  reviewManifest(manifest);
  const serialized = manifestText(manifest);
  const matrix = buildNormativeMatrix(design, manifest, serialized);
  write(base, CAPABILITY_PROOF_MANIFEST_PATH, serialized);
  write(base, CAPABILITY_MATRIX_PATH, `${JSON.stringify(matrix, null, 2)}\n`);
  return { base, design, manifest, manifestText: serialized, matrix, proof, proofSource };
}

export function passingProofRun(fixture: NormativeFixture): NormativeProofRunV2 {
  const digests = catalogDigests(fixture.base, [fixture.proof]);
  const command = normativeRunnerCommand("bun", [fixture.proof], "/tmp/vf-proof.xml");
  const proof = digests.proofs[fixture.proof.id];
  if (!proof) throw new Error("fixture proof digest is absent");
  return {
    schema_version: "2.0",
    profile: NORMATIVE_PROOF_RUN_PROFILE,
    design_sha256: sha256Text(fixture.design),
    manifest_sha256: sha256Text(fixture.manifestText),
    test_sha256: digests.test_sha256,
    production_sha256: digests.production_sha256,
    runner_runs: [
      {
        runner: "bun",
        version: "1.4.0",
        version_argv: [command.command, ...command.versionArgs],
        version_exit_code: 0,
        argv: [command.command, ...command.args],
        executed: true,
        exit_code: 0,
        status: "passed",
        stdout_sha256: sha256(""),
        stderr_sha256: sha256(""),
      },
    ],
    proofs: [
      {
        id: fixture.proof.id,
        runner: "bun",
        executed: true,
        status: "passed",
        exit_code: 0,
        ...proof,
      },
    ],
    errors: [],
  };
}
