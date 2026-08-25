import type { HostActionV1 } from "./internal-action-types.js";
import {
  validateCompactionInput,
  validateLegacyCandidate,
  validateOversizedCandidate,
} from "./internal-candidate-validation.js";
import { validateRepairPlan } from "./internal-repair-validation.js";
import {
  assertDigest,
  assertOpaqueId,
  assertPackageId,
  assertTimestamp,
} from "./record-primitives.js";
import { isHostActionKind } from "./request-types.js";
import { ActionValidationError, boundedString, exactObject, safeInteger } from "./strict-json.js";
import { validateHostActionRequest } from "./validation.js";

const STAGED = new Set([
  "conversation.publish_suspected_literal",
  "conversation.abandon_revision_operation",
  "conversation.retry_revision_operation",
  "conversation.reconcile_revision_operation",
  "context.compact",
  "capability.adopt",
  "policy.update_authority",
  "secret.revoke",
  "authority.repair",
]);
const KEYS: Record<string, readonly string[]> = {
  "conversation.publish_suspected_literal": ["binding"],
  "conversation.abandon_revision_operation": ["revision_operation_id", "expected_header_digest"],
  "conversation.retry_revision_operation": [
    "revision_operation_id",
    "expected_header_digest",
    "expected_head_digest",
  ],
  "conversation.reconcile_revision_operation": [
    "revision_operation_id",
    "expected_header_digest",
    "expected_state_digest",
    "expected_effect_action_operation_id",
  ],
  "context.compact": ["oversized_candidate", "profile", "compaction_input"],
  "capability.adopt": ["scope", "candidate"],
  "policy.update_authority": ["scope", "change"],
  "secret.revoke": ["scope", "private_binding_ref", "expected_binding_digest"],
  "authority.repair": ["plan"],
};

export function validateInternalHostAction(value: unknown): HostActionV1 {
  const initial = exactObject(
    value,
    Object.keys((value ?? {}) as Record<string, unknown>),
    [],
    "$.action",
  );
  if (typeof initial.type !== "string" || !isHostActionKind(initial.type))
    throw new ActionValidationError("unsupported internal action", "$.action.type");
  if (!STAGED.has(initial.type)) {
    const action = validateHostActionRequest(value) as HostActionV1;
    assertCanonicalActionArrays(action);
    return action;
  }
  const row = exactObject(value, ["type", ...(KEYS[initial.type] ?? [])], [], "$.action");
  switch (initial.type) {
    case "conversation.publish_suspected_literal":
      literalBinding(row.binding);
      break;
    case "conversation.abandon_revision_operation":
    case "conversation.retry_revision_operation":
    case "conversation.reconcile_revision_operation":
      for (const key of KEYS[initial.type] ?? [])
        if (key.endsWith("_digest")) assertDigest(row[key], `$.action.${key}`);
        else assertOpaqueId(row[key], `$.action.${key}`);
      break;
    case "context.compact":
      if (row.profile !== "vf-public-compaction/1")
        throw new ActionValidationError("invalid compaction profile", "$.action.profile");
      validateOversizedCandidate(row.oversized_candidate, "$.action.oversized_candidate");
      validateCompactionInput(row.compaction_input, "$.action.compaction_input");
      break;
    case "capability.adopt":
      capabilityScope(row.scope, "$.action.scope");
      validateLegacyCandidate(row.candidate, row.scope, "$.action.candidate");
      break;
    case "policy.update_authority":
      capabilityScope(row.scope, "$.action.scope");
      policyChange(row.change);
      if ((row.change as { scope?: unknown }).scope !== row.scope)
        throw new ActionValidationError("policy scope mismatch", "$.action.change.scope");
      break;
    case "secret.revoke":
      capabilityScope(row.scope, "$.action.scope");
      boundedString(row.private_binding_ref, "$.action.private_binding_ref");
      assertDigest(row.expected_binding_digest, "$.action.expected_binding_digest");
      break;
    case "authority.repair":
      validateRepairPlan(row.plan);
      break;
  }
  return value as HostActionV1;
}

function literalBinding(value: unknown): void {
  const row = exactObject(
    value,
    [
      "schema_version",
      "private_staging_id",
      "staging_record_digest",
      "staged_content_digest",
      "findings_digest",
      "projector_version",
      "rules_digest",
      "staged_at",
      "expires_at",
    ],
    [],
    "$.action.binding",
  );
  if (row.schema_version !== "1.0" || row.projector_version !== "vf-public-projector/1")
    throw new ActionValidationError("invalid literal binding version", "$.action.binding");
  assertOpaqueId(row.private_staging_id, "$.action.binding.private_staging_id");
  for (const key of [
    "staging_record_digest",
    "staged_content_digest",
    "findings_digest",
    "rules_digest",
  ])
    assertDigest(row[key], `$.action.binding.${key}`);
  assertTimestamp(row.staged_at, "$.action.binding.staged_at");
  if (
    assertTimestamp(row.expires_at, "$.action.binding.expires_at") <=
    Date.parse(row.staged_at as string)
  )
    throw new ActionValidationError(
      "literal binding expiry is invalid",
      "$.action.binding.expires_at",
    );
}

function policyChange(value: unknown): void {
  const row = exactObject(
    value,
    [
      "scope",
      "scope_identity_digest",
      "settings_schema_version",
      "expected_settings_sha256",
      "replacement_settings_sha256",
      "expected_policy_digest",
      "replacement_authority_subtree",
      "replacement_policy_digest",
    ],
    [],
    "$.action.change",
  );
  capabilityScope(row.scope, "$.action.change.scope");
  boundedString(row.settings_schema_version, "$.action.change.settings_schema_version");
  for (const key of [
    "scope_identity_digest",
    "expected_policy_digest",
    "replacement_policy_digest",
  ])
    assertDigest(row[key], `$.action.change.${key}`);
  for (const key of ["expected_settings_sha256", "replacement_settings_sha256"])
    if (typeof row[key] !== "string" || !/^[a-f0-9]{64}$/.test(row[key] as string))
      throw new ActionValidationError("invalid settings SHA-256", `$.action.change.${key}`);
  jsonValue(row.replacement_authority_subtree, "$.action.change.replacement_authority_subtree");
}

function assertCanonicalActionArrays(action: HostActionV1): void {
  if (action.type === "conversation.add_participant")
    sorted(action.participant.skill_refs, "$.action.participant.skill_refs");
  if (action.type === "conversation.update_participant" && action.changes.skill_refs)
    sorted(action.changes.skill_refs, "$.action.changes.skill_refs");
  if (action.type === "conversation.associate_lineages") {
    if (action.root_session_ids.length < 2)
      throw new ActionValidationError(
        "association requires at least two roots",
        "$.action.root_session_ids",
      );
    sorted(action.root_session_ids, "$.action.root_session_ids");
  }
  if (["capability.install", "capability.update", "capability.configure"].includes(action.type)) {
    const inputs =
      "inputs" in action && action.inputs ? action.inputs.map((row) => row.input_id) : [];
    sorted(inputs, "$.action.inputs");
  }
}

function sorted(values: string[], path: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((item, index) => item !== [...values].sort(bytewise)[index])
  )
    throw new ActionValidationError("array is duplicated or not canonical", path);
}

function bytewise(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function capabilityScope(value: unknown, path: string): void {
  if (value !== "project" && value !== "user")
    throw new ActionValidationError("invalid capability scope", path);
}

function jsonValue(value: unknown, path: string, depth = 0): void {
  if (depth > 32) throw new ActionValidationError("JSON depth exceeded", path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value))
    return void value.forEach((item, index) => jsonValue(item, `${path}[${index}]`, depth + 1));
  const row = exactObject(value, Object.keys(value as object), [], path);
  for (const [key, field] of Object.entries(row)) jsonValue(field, `${path}.${key}`, depth + 1);
}
