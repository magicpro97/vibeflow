import { isCapabilityScope } from "../core/capability-contract.js";
import { CONVERSATION_PUBLIC_PROFILE } from "../orchestrator/conversation/conversation-public-wire-contract.js";
import { HOST_ACTION_KIND, type HostActionKind, isHostActionKind } from "./host-action-contract.js";
import type { HostActionV1 } from "./internal-action-types.js";
import {
  validateCompactionInput,
  validateLegacyCandidate,
  validateOversizedCandidate,
} from "./internal-candidate-validation.js";
import { validateRepairPlan } from "./internal-repair-validation.js";
import {
  ACTION_PREVIEW_PROJECTOR_VERSION,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "./public-action-contract.js";
import {
  assertDigest,
  assertOpaqueId,
  assertPackageId,
  assertTimestamp,
} from "./record-primitives.js";
import { ActionValidationError, boundedString, exactObject, safeInteger } from "./strict-json.js";
import { validateHostActionRequest } from "./validation.js";

const fields = <const Fields extends readonly string[]>(...values: Fields): Readonly<Fields> =>
  Object.freeze(values);

type InternalStagedActionKind =
  | typeof HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL
  | typeof HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION
  | typeof HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION
  | typeof HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION
  | typeof HOST_ACTION_KIND.CONTEXT_COMPACT
  | typeof HOST_ACTION_KIND.CAPABILITY_ADOPT
  | typeof HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY
  | typeof HOST_ACTION_KIND.SECRET_REVOKE
  | typeof HOST_ACTION_KIND.AUTHORITY_REPAIR;

type InternalStagedActionFieldMap = {
  readonly [Kind in InternalStagedActionKind]: readonly Exclude<
    keyof Extract<HostActionV1, { type: Kind }>,
    "type"
  >[];
};

export const INTERNAL_STAGED_ACTION_FIELDS = Object.freeze({
  [HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL]: fields("binding"),
  [HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION]: fields(
    "revision_operation_id",
    "expected_header_digest",
  ),
  [HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION]: fields(
    "revision_operation_id",
    "expected_header_digest",
    "expected_head_digest",
  ),
  [HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION]: fields(
    "revision_operation_id",
    "expected_header_digest",
    "expected_state_digest",
    "expected_effect_action_operation_id",
  ),
  [HOST_ACTION_KIND.CONTEXT_COMPACT]: fields("oversized_candidate", "profile", "compaction_input"),
  [HOST_ACTION_KIND.CAPABILITY_ADOPT]: fields("scope", "candidate"),
  [HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY]: fields("scope", "change"),
  [HOST_ACTION_KIND.SECRET_REVOKE]: fields(
    "scope",
    "private_binding_ref",
    "expected_binding_digest",
  ),
  [HOST_ACTION_KIND.AUTHORITY_REPAIR]: fields("plan"),
} satisfies InternalStagedActionFieldMap);

export const INTERNAL_STAGED_ACTION_KINDS = Object.freeze(
  Object.keys(INTERNAL_STAGED_ACTION_FIELDS) as InternalStagedActionKind[],
);

function isInternalStagedActionKind(type: HostActionKind): type is InternalStagedActionKind {
  return INTERNAL_STAGED_ACTION_KINDS.some((candidate) => candidate === type);
}

export function validateInternalHostAction(value: unknown): HostActionV1 {
  const initial = exactObject(
    value,
    Object.keys((value ?? {}) as Record<string, unknown>),
    [],
    "$.action",
  );
  if (typeof initial.type !== "string" || !isHostActionKind(initial.type))
    throw new ActionValidationError("unsupported internal action", "$.action.type");
  if (!isInternalStagedActionKind(initial.type)) {
    const action = validateHostActionRequest(value) as HostActionV1;
    assertCanonicalActionArrays(action);
    return action;
  }
  const row = exactObject(
    value,
    ["type", ...INTERNAL_STAGED_ACTION_FIELDS[initial.type]],
    [],
    "$.action",
  );
  switch (initial.type) {
    case HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL:
      literalBinding(row.binding);
      break;
    case HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION:
    case HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION:
    case HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION:
      for (const key of INTERNAL_STAGED_ACTION_FIELDS[initial.type])
        if (key.endsWith("_digest")) assertDigest(row[key], `$.action.${key}`);
        else assertOpaqueId(row[key], `$.action.${key}`);
      break;
    case HOST_ACTION_KIND.CONTEXT_COMPACT:
      if (row.profile !== CONVERSATION_PUBLIC_PROFILE.COMPACTION)
        throw new ActionValidationError("invalid compaction profile", "$.action.profile");
      validateOversizedCandidate(row.oversized_candidate, "$.action.oversized_candidate");
      validateCompactionInput(row.compaction_input, "$.action.compaction_input");
      break;
    case HOST_ACTION_KIND.CAPABILITY_ADOPT:
      capabilityScope(row.scope, "$.action.scope");
      validateLegacyCandidate(row.candidate, row.scope, "$.action.candidate");
      break;
    case HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY:
      capabilityScope(row.scope, "$.action.scope");
      policyChange(row.change);
      if ((row.change as { scope?: unknown }).scope !== row.scope)
        throw new ActionValidationError("policy scope mismatch", "$.action.change.scope");
      break;
    case HOST_ACTION_KIND.SECRET_REVOKE:
      capabilityScope(row.scope, "$.action.scope");
      boundedString(row.private_binding_ref, "$.action.private_binding_ref");
      assertDigest(row.expected_binding_digest, "$.action.expected_binding_digest");
      break;
    case HOST_ACTION_KIND.AUTHORITY_REPAIR:
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
  if (
    row.schema_version !== PUBLIC_ACTION_SCHEMA_VERSION ||
    row.projector_version !== ACTION_PREVIEW_PROJECTOR_VERSION
  )
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
  if (action.type === HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT)
    sorted(action.participant.skill_refs, "$.action.participant.skill_refs");
  if (action.type === HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT && action.changes.skill_refs)
    sorted(action.changes.skill_refs, "$.action.changes.skill_refs");
  if (action.type === HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES) {
    if (action.root_session_ids.length < 2)
      throw new ActionValidationError(
        "association requires at least two roots",
        "$.action.root_session_ids",
      );
    sorted(action.root_session_ids, "$.action.root_session_ids");
  }
  if (
    action.type === HOST_ACTION_KIND.CAPABILITY_INSTALL ||
    action.type === HOST_ACTION_KIND.CAPABILITY_UPDATE ||
    action.type === HOST_ACTION_KIND.CAPABILITY_CONFIGURE
  ) {
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
  if (!isCapabilityScope(value)) throw new ActionValidationError("invalid capability scope", path);
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
