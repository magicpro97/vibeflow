import {
  NORMATIVE_PROOF_OWNERS,
  type NormativeProofOwner,
  catalogShape,
} from "./normative-evidence-catalog.js";
import {
  CAPABILITY_DESIGN_PATH,
  NORMATIVE_EXTRACTOR_VERSION,
  NORMATIVE_MANIFEST_PROFILE,
  NORMATIVE_MATRIX_PROFILE,
  NORMATIVE_REVIEW_STATEMENT,
  type NormativeClauseMatrixV2,
  type NormativeProofManifestV2,
} from "./normative-matrix-source.js";
import {
  NORMATIVE_PROOF_RUN_PROFILE,
  type NormativeProofExecutionV2,
  type NormativeProofRunV2,
  type NormativeRunnerExecutionV2,
} from "./normative-proof-run.js";

const HEX = /^[0-9a-f]{64}$/;
const SECTION_ID = /^section:[a-z0-9-]{1,72}:[0-9a-f]{12}$/;
const PROOF_ID = /^proof:(?:bun|playwright|manual):[A-Za-z0-9._/-]+#[a-z0-9][a-z0-9-]{0,127}$/;

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    observed.length === expected.length && observed.every((key, index) => key === expected[index])
  );
}

function uniqueStrings(value: unknown, maximum: number, allowEmpty = false): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximum &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length
  );
}

function calendarDate(value: string): boolean {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function dispositionShape(value: unknown): boolean {
  if (
    !plain(value) ||
    !exact(value, [
      "candidate_count",
      "candidate_sha256",
      "disposition",
      "heading",
      "owners",
      "proof_ids",
      "rationale",
      "section_id",
      "semantic_atom_count",
      "semantic_atom_sha256",
      "waiver_id",
    ]) ||
    typeof value.section_id !== "string" ||
    !SECTION_ID.test(value.section_id) ||
    typeof value.heading !== "string" ||
    !value.heading.trim() ||
    !Number.isSafeInteger(value.semantic_atom_count) ||
    (value.semantic_atom_count as number) < 0 ||
    typeof value.semantic_atom_sha256 !== "string" ||
    !HEX.test(value.semantic_atom_sha256) ||
    !Number.isSafeInteger(value.candidate_count) ||
    (value.candidate_count as number) < 0 ||
    typeof value.candidate_sha256 !== "string" ||
    !HEX.test(value.candidate_sha256) ||
    !["behavioral", "structural", "informational", "waived"].includes(String(value.disposition)) ||
    !uniqueStrings(value.owners, NORMATIVE_PROOF_OWNERS.length, true) ||
    !(value.owners as string[]).every((owner) =>
      NORMATIVE_PROOF_OWNERS.includes(owner as NormativeProofOwner),
    ) ||
    !uniqueStrings(value.proof_ids, 64, true) ||
    !(value.proof_ids as string[]).every((id) => PROOF_ID.test(id)) ||
    typeof value.rationale !== "string" ||
    !value.rationale.trim() ||
    value.rationale.length > 2_048 ||
    !(
      value.waiver_id === null ||
      (typeof value.waiver_id === "string" && /^waiver:[a-z0-9-]+$/.test(value.waiver_id))
    )
  )
    return false;
  if (["behavioral", "structural"].includes(String(value.disposition))) {
    return (value.owners as string[]).length > 0 && (value.proof_ids as string[]).length > 0;
  }
  if ((value.owners as string[]).length > 0 || (value.proof_ids as string[]).length > 0)
    return false;
  return value.disposition === "waived" ? value.waiver_id !== null : value.waiver_id === null;
}

function waiverShape(value: unknown): boolean {
  return (
    plain(value) &&
    exact(value, [
      "expires_on",
      "id",
      "reason",
      "reviewed_design_sha256",
      "reviewer",
      "section_ids",
    ]) &&
    typeof value.id === "string" &&
    /^waiver:[a-z0-9-]+$/.test(value.id) &&
    uniqueStrings(value.section_ids, 128) &&
    (value.section_ids as string[]).every((id) => SECTION_ID.test(id)) &&
    typeof value.reason === "string" &&
    value.reason.trim().length >= 20 &&
    typeof value.reviewer === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._@-]{2,127}$/.test(value.reviewer) &&
    typeof value.expires_on === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.expires_on) &&
    calendarDate(value.expires_on) &&
    typeof value.reviewed_design_sha256 === "string" &&
    HEX.test(value.reviewed_design_sha256)
  );
}

export function normativeManifestShape(value: unknown): value is NormativeProofManifestV2 {
  if (
    !plain(value) ||
    !exact(value, [
      "design",
      "profile",
      "proof_catalog",
      "review",
      "schema_version",
      "section_dispositions",
      "waivers",
    ]) ||
    value.schema_version !== "2.0" ||
    value.profile !== NORMATIVE_MANIFEST_PROFILE ||
    !plain(value.design) ||
    !exact(value.design, ["path", "sha256"]) ||
    value.design.path !== CAPABILITY_DESIGN_PATH ||
    typeof value.design.sha256 !== "string" ||
    !HEX.test(value.design.sha256) ||
    !catalogShape(value.proof_catalog) ||
    !Array.isArray(value.section_dispositions) ||
    value.section_dispositions.length === 0 ||
    value.section_dispositions.length > 512 ||
    !value.section_dispositions.every(dispositionShape) ||
    !Array.isArray(value.waivers) ||
    value.waivers.length > 128 ||
    !value.waivers.every(waiverShape) ||
    !plain(value.review) ||
    !exact(value.review, ["reviewed_payload_sha256", "reviewer", "statement"]) ||
    typeof value.review.reviewer !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._@-]{2,127}$/.test(value.review.reviewer) ||
    value.review.statement !== NORMATIVE_REVIEW_STATEMENT ||
    typeof value.review.reviewed_payload_sha256 !== "string" ||
    !HEX.test(value.review.reviewed_payload_sha256)
  )
    return false;
  const sections = value.section_dispositions.map((entry) => entry.section_id);
  const waivers = value.waivers.map((entry) => entry.id);
  return new Set(sections).size === sections.length && new Set(waivers).size === waivers.length;
}

export function normativeMatrixShape(value: unknown): value is NormativeClauseMatrixV2 {
  return (
    plain(value) &&
    exact(value, [
      "atoms",
      "design",
      "extractor_version",
      "manifest",
      "profile",
      "schema_version",
    ]) &&
    value.schema_version === "2.0" &&
    value.profile === NORMATIVE_MATRIX_PROFILE &&
    value.extractor_version === NORMATIVE_EXTRACTOR_VERSION &&
    Array.isArray(value.atoms) &&
    value.atoms.length > 0 &&
    value.atoms.length <= 20_000
  );
}

function proofExecutionShape(value: unknown): value is NormativeProofExecutionV2 {
  return (
    plain(value) &&
    exact(value, [
      "executed",
      "exit_code",
      "id",
      "production_sha256",
      "runner",
      "status",
      "test_sha256",
    ]) &&
    typeof value.id === "string" &&
    PROOF_ID.test(value.id) &&
    ["bun", "playwright", "manual"].includes(String(value.runner)) &&
    typeof value.executed === "boolean" &&
    ["passed", "failed", "skipped", "not-executed"].includes(String(value.status)) &&
    (value.exit_code === null || Number.isSafeInteger(value.exit_code)) &&
    typeof value.test_sha256 === "string" &&
    HEX.test(value.test_sha256) &&
    typeof value.production_sha256 === "string" &&
    HEX.test(value.production_sha256)
  );
}

function runnerExecutionShape(value: unknown): value is NormativeRunnerExecutionV2 {
  return (
    plain(value) &&
    exact(value, [
      "argv",
      "executed",
      "exit_code",
      "runner",
      "status",
      "stderr_sha256",
      "stdout_sha256",
      "version",
      "version_argv",
      "version_exit_code",
    ]) &&
    ["bun", "playwright", "manual"].includes(String(value.runner)) &&
    typeof value.version === "string" &&
    uniqueStrings(value.version_argv, 8, true) &&
    (value.version_exit_code === null || Number.isSafeInteger(value.version_exit_code)) &&
    uniqueStrings(value.argv, 512, true) &&
    typeof value.executed === "boolean" &&
    (value.exit_code === null || Number.isSafeInteger(value.exit_code)) &&
    ["passed", "failed", "skipped", "not-executed"].includes(String(value.status)) &&
    typeof value.stdout_sha256 === "string" &&
    HEX.test(value.stdout_sha256) &&
    typeof value.stderr_sha256 === "string" &&
    HEX.test(value.stderr_sha256)
  );
}

export function normativeProofRunShape(value: unknown): value is NormativeProofRunV2 {
  return (
    plain(value) &&
    exact(value, [
      "design_sha256",
      "errors",
      "manifest_sha256",
      "production_sha256",
      "profile",
      "proofs",
      "runner_runs",
      "schema_version",
      "test_sha256",
    ]) &&
    value.schema_version === "2.0" &&
    value.profile === NORMATIVE_PROOF_RUN_PROFILE &&
    [value.design_sha256, value.manifest_sha256, value.test_sha256, value.production_sha256].every(
      (digest) => typeof digest === "string" && HEX.test(digest),
    ) &&
    Array.isArray(value.runner_runs) &&
    value.runner_runs.every(runnerExecutionShape) &&
    Array.isArray(value.proofs) &&
    value.proofs.every(proofExecutionShape) &&
    uniqueStrings(value.errors, 256, true)
  );
}
