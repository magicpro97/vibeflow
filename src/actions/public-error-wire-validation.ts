import { isHostActionKind } from "./host-action-contract.js";
import {
  PUBLIC_API_ERROR_CORRELATION_MAX_BYTES,
  PUBLIC_API_ERROR_ENVELOPE_FIELDS,
  PUBLIC_API_ERROR_FIELDS,
  PUBLIC_API_ERROR_MAX_BYTES,
  PUBLIC_API_ERROR_MESSAGE_MAX_BYTES,
  PUBLIC_API_ERROR_SCHEMA_VERSION,
  PUBLIC_ERROR_CANONICAL_MESSAGE,
  PUBLIC_ERROR_CODE,
  PUBLIC_ERROR_DETAIL_FIELDS,
  PUBLIC_ERROR_GENERIC_DETAILS_MAX_BYTES,
  PUBLIC_ERROR_GENERIC_DETAILS_MAX_FIELDS,
  PUBLIC_ERROR_GENERIC_DETAIL_KEY_MAX_BYTES,
  PUBLIC_ERROR_NULLABLE_DETAIL_FIELDS,
  PUBLIC_ERROR_PRE_EFFECT_FRONTIER,
  PUBLIC_ERROR_PRE_EFFECT_REASON,
  PUBLIC_ERROR_SCOPE,
  PUBLIC_ERROR_SEMANTICS,
  PUBLIC_HANDOFF_CANDIDATE_FIELDS,
  PUBLIC_HANDOFF_SOURCE_FIELDS,
  PUBLIC_LINEAGE_HEAD_STATUS,
  PUBLIC_LINEAGE_NODE_FIELDS,
  type PublicApiErrorBodyV1,
  type PublicApiErrorV1,
  type PublicErrorCode,
  isPublicErrorCode,
  isPublicRecoveryAction,
} from "./public-error-contract.js";
import {
  compareUtf8Wire,
  hasExactWireFields,
  isBoundedJsonWireValue,
  isBoundedWireIdentity,
  isBoundedWireText,
  isExactWireTimestamp,
  isNonnegativeSafeWireInteger,
  isPlainWireRecord,
  isSha256WireDigest,
} from "./public-wire-primitives.js";

export function parsePublicApiError(value: unknown): PublicApiErrorV1 {
  if (!isPlainWireRecord(value) || !hasExactWireFields(value, PUBLIC_API_ERROR_ENVELOPE_FIELDS))
    throw new Error("unknown or missing public error envelope field");
  if (value.schema_version !== PUBLIC_API_ERROR_SCHEMA_VERSION)
    throw new Error("unsupported public error schema version");
  return {
    schema_version: PUBLIC_API_ERROR_SCHEMA_VERSION,
    error: parsePublicApiErrorBody(value.error),
  };
}

export function parsePublicApiErrorBody(
  value: unknown,
  expectedCorrelationId?: string,
): PublicApiErrorBodyV1 {
  if (!isPlainWireRecord(value) || !hasExactWireFields(value, PUBLIC_API_ERROR_FIELDS))
    throw new Error("unknown or missing public error field");
  if (!isPublicErrorCode(value.code)) throw new Error("unknown public error code");
  if (!isBoundedWireText(value.message, { maxBytes: PUBLIC_API_ERROR_MESSAGE_MAX_BYTES }))
    throw new Error("invalid bounded public error message");
  if (
    !isBoundedWireText(value.correlation_id, {
      maxBytes: PUBLIC_API_ERROR_CORRELATION_MAX_BYTES,
      ascii: true,
    }) ||
    (expectedCorrelationId !== undefined && value.correlation_id !== expectedCorrelationId)
  )
    throw new Error("invalid bounded public error wire value");
  if (typeof value.retryable !== "boolean") throw new Error("invalid public error retryability");
  if (value.recovery_action !== null && !isPublicRecoveryAction(value.recovery_action))
    throw new Error("unknown public error recovery action");
  const details = snapshotPublicErrorDetails(value.code, value.details);
  const semantics = PUBLIC_ERROR_SEMANTICS[value.code];
  if (
    value.retryable !== semantics.retryable ||
    !semantics.recovery_actions.some((candidate) => candidate === value.recovery_action)
  )
    throw new Error("public error recovery semantics mismatch");
  const canonicalMessage = Object.hasOwn(PUBLIC_ERROR_CANONICAL_MESSAGE, value.code)
    ? PUBLIC_ERROR_CANONICAL_MESSAGE[value.code as keyof typeof PUBLIC_ERROR_CANONICAL_MESSAGE]
    : undefined;
  if (canonicalMessage !== undefined && value.message !== canonicalMessage)
    throw new Error("public error message semantics mismatch");
  if (!isBoundedJsonWireValue(value, PUBLIC_API_ERROR_MAX_BYTES))
    throw new Error("public error exceeds 4 KiB byte limit");
  return {
    code: value.code,
    message: value.message,
    correlation_id: value.correlation_id,
    retryable: value.retryable,
    recovery_action: value.recovery_action,
    details,
  } as PublicApiErrorBodyV1;
}

export function isPublicApiErrorBody(
  value: unknown,
  expectedCorrelationId?: string,
): value is PublicApiErrorBodyV1 {
  try {
    parsePublicApiErrorBody(value, expectedCorrelationId);
    return true;
  } catch {
    return false;
  }
}

export function validatePublicErrorDetails(code: PublicErrorCode, value: unknown): void {
  if (code === PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED && value === null) return;
  const fields = PUBLIC_ERROR_DETAIL_FIELDS[code as keyof typeof PUBLIC_ERROR_DETAIL_FIELDS] as
    | readonly string[]
    | undefined;
  if (!fields) {
    validateGenericScalarDetails(value);
    return;
  }
  if (!isPlainWireRecord(value) || !hasExactWireFields(value, fields))
    throw new Error("unknown or missing public error details field");
  if (code === PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED) {
    if (!isHostActionKind(value.action_type)) throw new Error("invalid target action type");
    return;
  }
  if (code === PUBLIC_ERROR_CODE.CATALOG_DEGRADED) {
    if (typeof value.recoverable_by_id !== "boolean")
      throw new Error("invalid catalog recovery details");
    return;
  }
  if (code === PUBLIC_ERROR_CODE.HANDOFF_TOO_LARGE) {
    validateHandoffCandidate(value.candidate);
    return;
  }
  const nullableFields = (
    PUBLIC_ERROR_NULLABLE_DETAIL_FIELDS as Partial<
      Readonly<Record<PublicErrorCode, readonly string[]>>
    >
  )[code];
  for (const [key, field] of Object.entries(value)) {
    if (key === "head_epoch" || key === "current_last_seq") {
      if (!isNonnegativeSafeWireInteger(field)) throw new Error("invalid public error integer");
    } else if (key === "head" || key === "current_head") validateLineageNode(field);
    else if (key === "candidate_heads") validateCandidateHeads(field);
    else if (key === "input_ids") validateSortedStrings(field);
    else if (field === null) {
      if (!nullableFields?.some((candidate) => candidate === key))
        throw new Error("invalid nullable public error detail");
    } else if (!isBoundedWireIdentity(field))
      throw new Error("invalid bounded public error detail");
  }
  if (
    (Object.hasOwn(value, "scope") &&
      value.scope !== PUBLIC_ERROR_SCOPE.PROJECT &&
      value.scope !== PUBLIC_ERROR_SCOPE.USER) ||
    (Object.hasOwn(value, "head_status") &&
      value.head_status !== PUBLIC_LINEAGE_HEAD_STATUS.AMBIGUOUS &&
      value.head_status !== PUBLIC_LINEAGE_HEAD_STATUS.UNCLAIMED)
  )
    throw new Error("invalid closed public error enum");
  if (Object.hasOwn(value, "head_digest") && !isSha256WireDigest(value.head_digest))
    throw new Error("invalid public error digest");
  if (code === PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED) {
    if (
      !Object.values(PUBLIC_ERROR_PRE_EFFECT_REASON).some(
        (candidate) => candidate === value.reason_code,
      ) ||
      !Object.values(PUBLIC_ERROR_PRE_EFFECT_FRONTIER).some(
        (candidate) => candidate === value.frontier_kind,
      )
    )
      throw new Error("invalid pre-effect refusal details");
  }
}

function validateGenericScalarDetails(value: unknown): void {
  if (value === null) return;
  if (!isPlainWireRecord(value))
    throw new Error("generic public error details must be a scalar map");
  const entries = Object.entries(value);
  if (
    entries.length > PUBLIC_ERROR_GENERIC_DETAILS_MAX_FIELDS ||
    !isBoundedJsonWireValue(value, PUBLIC_ERROR_GENERIC_DETAILS_MAX_BYTES, {
      maxDepth: 1,
      maxNodes: PUBLIC_ERROR_GENERIC_DETAILS_MAX_FIELDS + 1,
    })
  )
    throw new Error("generic public error details exceed the 4 KiB scalar-map limit");
  for (const [key, field] of entries) {
    if (
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor" ||
      !isBoundedWireText(key, { maxBytes: PUBLIC_ERROR_GENERIC_DETAIL_KEY_MAX_BYTES }) ||
      !(
        field === null ||
        typeof field === "string" ||
        typeof field === "boolean" ||
        (typeof field === "number" && Number.isFinite(field))
      )
    )
      throw new Error("generic public error details contain a non-scalar or unsafe field");
  }
}

function snapshotPublicErrorDetails(code: PublicErrorCode, value: unknown): unknown {
  validatePublicErrorDetails(code, value);
  if (value === null) return null;
  if (Object.hasOwn(PUBLIC_ERROR_DETAIL_FIELDS, code)) return structuredClone(value);
  const snapshot: Record<string, string | number | boolean | null> = Object.create(null);
  for (const [key, field] of Object.entries(
    value as Record<string, string | number | boolean | null>,
  ))
    snapshot[key] = field;
  return snapshot;
}

function validateLineageNode(value: unknown): void {
  if (!isPlainWireRecord(value) || !hasExactWireFields(value, PUBLIC_LINEAGE_NODE_FIELDS))
    throw new Error("invalid lineage node details");
  if (
    !isBoundedWireIdentity(value.conversation_id) ||
    !isBoundedWireIdentity(value.revision_id) ||
    !isNonnegativeSafeWireInteger(value.revision_ordinal)
  )
    throw new Error("invalid lineage node details");
}

function validateCandidateHeads(value: unknown): void {
  if (!Array.isArray(value) || value.length > 256) throw new Error("invalid candidate head list");
  for (const item of value) validateLineageNode(item);
  const heads = value as Array<{
    conversation_id: string;
    revision_id: string;
    revision_ordinal: number;
  }>;
  for (let index = 1; index < heads.length; index += 1) {
    const previous = heads[index - 1];
    const current = heads[index];
    if (!previous || !current || compareCandidateHeads(previous, current) >= 0)
      throw new Error("candidate heads are duplicated or unordered");
  }
}

function compareCandidateHeads(
  left: { conversation_id: string; revision_id: string; revision_ordinal: number },
  right: { conversation_id: string; revision_id: string; revision_ordinal: number },
): number {
  if (left.revision_ordinal !== right.revision_ordinal)
    return left.revision_ordinal < right.revision_ordinal ? -1 : 1;
  return (
    compareUtf8Wire(left.conversation_id, right.conversation_id) ||
    compareUtf8Wire(left.revision_id, right.revision_id)
  );
}

function validateSortedStrings(value: unknown): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128)
    throw new Error("invalid string list");
  const rows = value.filter(isBoundedWireIdentity);
  const sorted = [...rows].sort(compareUtf8Wire);
  if (
    rows.length !== value.length ||
    new Set(rows).size !== rows.length ||
    rows.some((item, index) => item !== sorted[index])
  )
    throw new Error("public error string list is duplicated or unsorted");
}

function validateHandoffCandidate(value: unknown): void {
  if (!isPlainWireRecord(value) || !hasExactWireFields(value, PUBLIC_HANDOFF_CANDIDATE_FIELDS))
    throw new Error("invalid handoff candidate fields");
  if (
    value.schema_version !== PUBLIC_API_ERROR_SCHEMA_VERSION ||
    !isSha256WireDigest(value.candidate_digest) ||
    value.candidate_id !== `vf-oversized-handoff-${value.candidate_digest.slice(7)}`
  )
    throw new Error("public handoff candidate identity mismatch");
  if (
    !isPlainWireRecord(value.source) ||
    !hasExactWireFields(value.source, PUBLIC_HANDOFF_SOURCE_FIELDS)
  )
    throw new Error("invalid handoff candidate source");
  if (
    !isBoundedWireIdentity(value.source.conversation_id) ||
    !isBoundedWireIdentity(value.source.revision_id) ||
    !isNonnegativeSafeWireInteger(value.source.last_seq) ||
    !isSha256WireDigest(value.source.lock_digest) ||
    !isSha256WireDigest(value.source_public_head_digest) ||
    !isSha256WireDigest(value.selection_plan_digest) ||
    !isSha256WireDigest(value.mandatory_projection_digest)
  )
    throw new Error("invalid handoff candidate authority");
  if (
    !isNonnegativeSafeWireInteger(value.prompt_budget_bytes) ||
    value.prompt_budget_bytes < 1 ||
    !isNonnegativeSafeWireInteger(value.encoded_candidate_bytes) ||
    !isNonnegativeSafeWireInteger(value.overflow_bytes) ||
    value.encoded_candidate_bytes <= value.prompt_budget_bytes ||
    value.overflow_bytes !== value.encoded_candidate_bytes - value.prompt_budget_bytes
  )
    throw new Error("public handoff candidate byte accounting mismatch");
  if (!isExactWireTimestamp(value.created_at) || !isExactWireTimestamp(value.expires_at))
    throw new Error("invalid handoff candidate timestamp");
  if (Date.parse(value.expires_at) !== Date.parse(value.created_at) + 600_000)
    throw new Error("public handoff candidate expiry mismatch");
}
