import { digestHex, digestV1 } from "../durability/index.js";
import type {
  LegacyAdoptCandidateV1,
  OversizedHandoffCandidateV1,
} from "./internal-action-types.js";
import { validateLegacyManifestClosure } from "./legacy-manifest-validation.js";
import { validatePackagePin } from "./package-pin-validation.js";
import { assertPublicProjectionSafe } from "./public-safety.js";
import {
  assertDigest,
  assertOpaqueId,
  assertRawSha256,
  assertStringArray,
  assertTimestamp,
  bytewise,
} from "./record-primitives.js";
import { ActionValidationError, boundedString, exactObject, safeInteger } from "./strict-json.js";

const LEGACY_SOURCES = new Set([
  "skill-lock",
  "tool-managed-evidence",
  "mcp-managed-sidecar",
  "hook-sentinel",
  "role-marker",
]);

export function validateCompactionInput(value: unknown, path: string): void {
  const row = exactObject(
    value,
    [
      "schema_version",
      "profile",
      "public_summary",
      "retained_event_ids",
      "retained_artifact_ids",
      "input_digest",
    ],
    [],
    path,
  );
  if (row.schema_version !== "1.0" || row.profile !== "vf-public-compaction/1")
    invalid("invalid compaction profile", path);
  const summary = boundedString(row.public_summary, `${path}.public_summary`, { max: 64 * 1024 });
  if (!summary || summary !== summary.normalize("NFC")) invalid("invalid compaction summary", path);
  assertPublicProjectionSafe(summary, `${path}.public_summary`, { maxBytes: 64 * 1024 + 2 });
  assertStringArray(row.retained_event_ids, `${path}.retained_event_ids`, {
    max: 256,
    sorted: true,
  });
  assertStringArray(row.retained_artifact_ids, `${path}.retained_artifact_ids`, {
    max: 256,
    sorted: true,
  });
  assertDigest(row.input_digest, `${path}.input_digest`);
  const { input_digest: observed, ...preimage } = row;
  if (observed !== digestV1("VF-PUBLIC-COMPACTION-INPUT\0v1\0", preimage))
    invalid("compaction input digest mismatch", `${path}.input_digest`);
}

export function validateOversizedCandidate(value: unknown, path: string): void {
  const row = exactObject(
    value,
    [
      "schema_version",
      "candidate_id",
      "source",
      "source_public_head_digest",
      "selection_plan_digest",
      "mandatory_projection_digest",
      "prompt_budget_bytes",
      "encoded_candidate_bytes",
      "overflow_bytes",
      "private_candidate_ref",
      "created_at",
      "expires_at",
      "candidate_digest",
    ],
    [],
    path,
  );
  if (row.schema_version !== "1.0") invalid("invalid oversized candidate version", path);
  const source = exactObject(
    row.source,
    ["conversation_id", "revision_id", "last_seq", "lock_digest"],
    [],
    `${path}.source`,
  );
  assertOpaqueId(source.conversation_id, `${path}.source.conversation_id`);
  assertOpaqueId(source.revision_id, `${path}.source.revision_id`);
  const lastSeq = safeInteger(source.last_seq, `${path}.source.last_seq`);
  if (lastSeq < 0) invalid("negative source sequence", `${path}.source.last_seq`);
  assertDigest(source.lock_digest, `${path}.source.lock_digest`);
  for (const key of [
    "source_public_head_digest",
    "selection_plan_digest",
    "mandatory_projection_digest",
    "candidate_digest",
  ])
    assertDigest(row[key], `${path}.${key}`);
  const budget = safeInteger(row.prompt_budget_bytes, `${path}.prompt_budget_bytes`);
  const encoded = safeInteger(row.encoded_candidate_bytes, `${path}.encoded_candidate_bytes`);
  const overflow = safeInteger(row.overflow_bytes, `${path}.overflow_bytes`);
  if (budget < 1 || encoded <= budget || overflow !== encoded - budget)
    invalid("oversized candidate byte accounting mismatch", path);
  const privateRef = assertOpaqueId(
    row.private_candidate_ref,
    `${path}.private_candidate_ref`,
    256,
  );
  if (!/^objects\/v1\/[a-f0-9]{64}\.json$/.test(privateRef))
    invalid(
      "oversized candidate private ref is not the fixed object path",
      `${path}.private_candidate_ref`,
    );
  const created = assertTimestamp(row.created_at, `${path}.created_at`);
  const expires = assertTimestamp(row.expires_at, `${path}.expires_at`);
  if (expires !== created + 10 * 60_000)
    invalid("oversized candidate expiry must be ten minutes", `${path}.expires_at`);
  const { candidate_id: observedId, candidate_digest: observedDigest, ...preimage } = row;
  const expectedDigest = digestV1("VF-OVERSIZED-HANDOFF-CANDIDATE\0v1\0", preimage);
  if (
    observedDigest !== expectedDigest ||
    observedId !== `vf-oversized-handoff-${digestHex(expectedDigest)}`
  )
    invalid("oversized candidate identity mismatch", path);
}

export function validateLegacyCandidate(value: unknown, outerScope: unknown, path: string): void {
  const row = exactObject(
    value,
    [
      "schema_version",
      "candidate_id",
      "scope",
      "scope_identity_digest",
      "legacy_source",
      "synthetic_manifest",
      "synthetic_pin",
      "permissions",
      "dependencies",
      "targets",
      "owned_resources",
      "inspection_evidence_digest",
      "inspected_at",
      "expires_at",
      "candidate_digest",
    ],
    [],
    path,
  ) as unknown as LegacyAdoptCandidateV1;
  if (
    row.schema_version !== "1.0" ||
    row.scope !== outerScope ||
    !["project", "user"].includes(row.scope)
  )
    invalid("legacy candidate version or scope mismatch", path);
  if (!LEGACY_SOURCES.has(row.legacy_source))
    invalid("invalid legacy source", `${path}.legacy_source`);
  assertDigest(row.scope_identity_digest, `${path}.scope_identity_digest`);
  assertDigest(row.inspection_evidence_digest, `${path}.inspection_evidence_digest`);
  validatePackagePin(row.synthetic_pin, `${path}.synthetic_pin`);
  if (
    row.synthetic_pin.source.kind !== "legacy-adopt" ||
    row.synthetic_pin.source.legacy_source !== row.legacy_source ||
    row.synthetic_pin.source.inspection_evidence_digest !== row.inspection_evidence_digest ||
    !/^0\.0\.0-legacy\.[a-f0-9]{12}$/.test(row.synthetic_pin.version)
  )
    invalid(
      "legacy candidate synthetic pin does not bind source evidence",
      `${path}.synthetic_pin`,
    );
  if (
    !Array.isArray(row.permissions) ||
    !Array.isArray(row.dependencies) ||
    !Array.isArray(row.targets)
  )
    invalid("legacy candidate arrays are invalid", path);
  validateCandidateTargets(row.targets, row.synthetic_pin.id, `${path}.targets`);
  validateOwnedResources(row.owned_resources, `${path}.owned_resources`);
  validateLegacyManifestClosure(row, path);
  const inspected = assertTimestamp(row.inspected_at, `${path}.inspected_at`);
  if (assertTimestamp(row.expires_at, `${path}.expires_at`) !== inspected + 10 * 60_000)
    invalid("legacy candidate expiry must be ten minutes", `${path}.expires_at`);
  const { candidate_id: observedId, candidate_digest: observedDigest, ...preimage } = row;
  const expectedDigest = digestV1("VF-LEGACY-ADOPT-CANDIDATE\0v1\0", preimage);
  if (observedDigest !== expectedDigest || observedId !== `vf-adopt-${digestHex(expectedDigest)}`)
    invalid("legacy candidate identity mismatch", path);
}

function validateCandidateTargets(
  values: LegacyAdoptCandidateV1["targets"],
  packageId: string,
  path: string,
): void {
  if (values.length > 64) invalid("legacy target count exceeds bound", path);
  const ids = values.map((binding, index) => {
    const row = exactObject(binding, ["target_id", "target", "subject"], [], `${path}[${index}]`);
    const target = exactObject(
      row.target,
      ["scope", "engine", "participant_id", "required", "on_apply_failure", "on_health_failure"],
      [],
      `${path}[${index}].target`,
    );
    if (!["project", "user"].includes(target.scope as string))
      invalid("invalid legacy target scope", `${path}[${index}].target.scope`);
    if (
      target.engine !== null &&
      !["claude", "codex", "copilot", "opencode", "antigravity"].includes(target.engine as string)
    )
      invalid("invalid legacy target engine", `${path}[${index}].target.engine`);
    if (target.participant_id !== null)
      assertOpaqueId(target.participant_id, `${path}[${index}].target.participant_id`);
    if (
      target.required === true &&
      (target.on_apply_failure !== "abort-scope" || target.on_health_failure !== "abort-scope")
    )
      invalid("required legacy target policy mismatch", `${path}[${index}].target`);
    if (
      target.required === false &&
      (target.on_apply_failure !== "omit-after-rollback" ||
        !["omit-after-rollback", "commit-degraded"].includes(target.on_health_failure as string))
    )
      invalid("optional legacy target policy mismatch", `${path}[${index}].target`);
    if (typeof target.required !== "boolean")
      invalid("invalid legacy target required flag", `${path}[${index}].target.required`);
    const subject = exactObject(
      row.subject,
      ["kind", "package_id", "component_id"],
      [],
      `${path}[${index}].subject`,
    );
    if (subject.kind !== "capability" || subject.package_id !== packageId)
      invalid("legacy target subject mismatch", `${path}[${index}].subject`);
    assertOpaqueId(subject.component_id, `${path}[${index}].subject.component_id`);
    const expected = `vf-target-${digestHex(digestV1("VF-ACTION-TARGET-ID\0v1\0", { schema_version: "1.0", target: row.target, subject: row.subject }))}`;
    if (row.target_id !== expected)
      invalid("legacy target ID mismatch", `${path}[${index}].target_id`);
    return row.target_id as string;
  });
  ordered(ids, path);
}

function validateOwnedResources(
  value: LegacyAdoptCandidateV1["owned_resources"],
  path: string,
): void {
  if (!Array.isArray(value) || value.length > 512) invalid("owned resources exceed bound", path);
  const ownership = new Set<string>();
  const identities = value.map((item, index) => {
    const row = exactObject(
      item,
      ["ownership_key", "public_target", "expected_preimage_sha256"],
      [],
      `${path}[${index}]`,
    );
    const key = assertOpaqueId(row.ownership_key, `${path}[${index}].ownership_key`);
    if (ownership.has(key)) invalid("duplicate ownership key", path);
    ownership.add(key);
    boundedString(row.public_target, `${path}[${index}].public_target`, { max: 1_024 });
    assertRawSha256(row.expected_preimage_sha256, `${path}[${index}].expected_preimage_sha256`);
    return `${key}\0${row.public_target}\0${row.expected_preimage_sha256}`;
  });
  ordered(identities, path);
}

function ordered(values: string[], path: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => value !== [...values].sort(bytewise)[index])
  )
    invalid("candidate array is duplicated or not canonical", path);
}

function invalid(message: string, path: string): never {
  throw new ActionValidationError(message, path);
}
