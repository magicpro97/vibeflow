import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CAPABILITY_DESIGN_PATH,
  CAPABILITY_MATRIX_PATH,
  CAPABILITY_PROOF_MANIFEST_PATH,
  type NormativeProofManifestV2,
  buildNormativeMatrix,
} from "../src/verify/normative-matrix-source.js";

const base = process.cwd();
const design = readFileSync(join(base, CAPABILITY_DESIGN_PATH), "utf8");
const manifestText = readFileSync(join(base, CAPABILITY_PROOF_MANIFEST_PATH), "utf8");
const manifest = JSON.parse(manifestText) as NormativeProofManifestV2;
const matrix = buildNormativeMatrix(design, manifest, manifestText);
const destination = join(base, CAPABILITY_MATRIX_PATH);
const temporary = `${destination}.tmp`;
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(temporary, `${JSON.stringify(matrix, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
renameSync(temporary, destination);
process.stdout.write(
  `generated ${matrix.atoms.length} exact normative atoms → ${CAPABILITY_MATRIX_PATH}\n`,
);
