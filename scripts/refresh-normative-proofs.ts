import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CAPABILITY_DESIGN_PATH,
  CAPABILITY_MATRIX_PATH,
  CAPABILITY_PROOF_MANIFEST_PATH,
  type NormativeProofManifestV2,
  canonicalJson,
  buildNormativeMatrix,
  normativeManifestPayloadDigest,
} from "../src/verify/normative-matrix-source.js";
import { catalogDigests } from "../src/verify/normative-evidence-catalog.js";

const base = process.cwd();
const manifestPath = join(base, CAPABILITY_PROOF_MANIFEST_PATH);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as NormativeProofManifestV2;
const digests = catalogDigests(base, manifest.proof_catalog);
for (const proof of manifest.proof_catalog) {
  const current = digests.proofs[proof.id];
  if (!current) throw new Error(`no digest for ${proof.id}`);
  proof.test_sha256 = current.test_sha256;
  proof.production_sha256 = current.production_sha256;
}
manifest.review.reviewed_payload_sha256 = normativeManifestPayloadDigest(manifest);
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(manifestPath, manifestText);
const design = readFileSync(join(base, CAPABILITY_DESIGN_PATH), "utf8");
const matrix = buildNormativeMatrix(design, manifest, manifestText);
const destination = join(base, CAPABILITY_MATRIX_PATH);
const temporary = `${destination}.tmp`;
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(temporary, `${JSON.stringify(matrix, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
renameSync(temporary, destination);
console.log(`refreshed ${manifest.proof_catalog.length} proof digests + review binding + matrix`);
