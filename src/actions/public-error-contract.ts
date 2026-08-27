import type {
  PUBLIC_API_ERROR_SCHEMA_VERSION,
  PublicErrorScalarMapV1,
  PublicErrorSpecialDetailsV1,
} from "./public-error-details-contract.js";

export * from "./public-error-details-contract.js";

type ValueOf<Contract> = Contract[keyof Contract];

export const PUBLIC_ERROR_CODE = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  UNAUTHENTICATED: "unauthenticated",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  STALE_CONVERSATION: "stale_conversation",
  STALE_PROPOSAL: "stale_proposal",
  STALE_CATALOG_CURSOR: "stale_catalog_cursor",
  STALE_CAPABILITY_CURSOR: "stale_capability_cursor",
  STALE_ACTION_PROJECTION_CURSOR: "stale_action_projection_cursor",
  STALE_PENDING_PROPOSAL_CURSOR: "stale_pending_proposal_cursor",
  STALE_LINEAGE_CURSOR: "stale_lineage_cursor",
  STALE_TIMELINE_CURSOR: "stale_timeline_cursor",
  STALE_OPERATION_CURSOR: "stale_operation_cursor",
  FUTURE_EVENT_CURSOR: "future_event_cursor",
  IDEMPOTENCY_CONFLICT: "idempotency_conflict",
  PRIVATE_INPUT_HEAD_CONFLICT: "private_input_head_conflict",
  SCOPE_LOCKED: "scope_locked",
  NOT_LINEAGE_HEAD: "not_lineage_head",
  LINEAGE_HEAD_UNRESOLVED: "lineage_head_unresolved",
  APPROVAL_REQUIRED: "approval_required",
  APPROVAL_EXPIRED: "approval_expired",
  CHALLENGE_REQUIRED: "challenge_required",
  CHALLENGE_EXPIRED: "challenge_expired",
  PERMISSION_DENIED: "permission_denied",
  HANDOFF_TOO_LARGE: "handoff_too_large",
  HANDOFF_MISMATCH: "handoff_mismatch",
  SOURCE_DIGEST_CHANGED: "source_digest_changed",
  PREIMAGE_CHANGED: "preimage_changed",
  PRE_EFFECT_REFUSED: "pre_effect_refused",
  UNSUPPORTED_SCHEMA_VERSION: "unsupported_schema_version",
  MANUAL_ACTION_REQUIRED: "manual_action_required",
  TARGET_UNSUPPORTED: "target_unsupported",
  DEPENDENCY_RESOLUTION_TOO_COMPLEX: "dependency_resolution_too_complex",
  SCOPE_NEEDS_RECOVERY: "scope_needs_recovery",
  AUTHORITY_CORRUPT: "authority_corrupt",
  REPAIR_UNAVAILABLE: "repair_unavailable",
  CATALOG_DEGRADED: "catalog_degraded",
  RATE_LIMITED: "rate_limited",
  SERVICE_UNAVAILABLE: "service_unavailable",
} as const);

export type PublicErrorCode = ValueOf<typeof PUBLIC_ERROR_CODE>;
export const PUBLIC_ERROR_CODES = Object.freeze(Object.values(PUBLIC_ERROR_CODE));

export const PUBLIC_RECOVERY_ACTION = Object.freeze({
  RETRY: "retry",
  EDIT: "edit",
  REFRESH_PROPOSAL: "refresh-proposal",
  RESTART_PAGINATION: "restart-pagination",
  COMPLETE_CHALLENGE: "complete-challenge",
  SELECT_LINEAGE_HEAD: "select-lineage-head",
  REBUILD_CATALOG: "rebuild-catalog",
  RESUME_BY_ID: "resume-by-id",
  INSPECT_TRACE: "inspect-trace",
  RESOLVE_AGAIN: "resolve-again",
  ROLLBACK: "rollback",
  REPAIR: "repair",
  REPAIR_AUTHORITY: "repair-authority",
  VERIFIED_ABANDON: "verified-abandon",
  RECONCILE_REVISION: "reconcile-revision",
  ADOPT: "adopt",
  RENEW_GRANT: "renew-grant",
  AUTHORIZE_SOURCE: "authorize-source",
  DISABLE: "disable",
  RETARGET: "retarget",
  COMPLETE_MANUAL_STEP: "complete-manual-step",
  EXPORT_REDACTED_DIAGNOSTICS: "export-redacted-diagnostics",
} as const);

export type RecoveryAction = ValueOf<typeof PUBLIC_RECOVERY_ACTION>;
export const PUBLIC_RECOVERY_ACTIONS = Object.freeze(Object.values(PUBLIC_RECOVERY_ACTION));

export const PUBLIC_API_ERROR_MAX_BYTES = 4_096;
export const PUBLIC_API_ERROR_MESSAGE_MAX_BYTES = 512;
export const PUBLIC_API_ERROR_CORRELATION_MAX_BYTES = 256;

export const PUBLIC_API_ERROR_FIELD = Object.freeze({
  CODE: "code",
  MESSAGE: "message",
  CORRELATION_ID: "correlation_id",
  RETRYABLE: "retryable",
  RECOVERY_ACTION: "recovery_action",
  DETAILS: "details",
} as const);

export const PUBLIC_API_ERROR_FIELDS = Object.freeze(Object.values(PUBLIC_API_ERROR_FIELD));

export const PUBLIC_API_ERROR_ENVELOPE_FIELDS = Object.freeze(["schema_version", "error"] as const);

export type PublicErrorDetailsV1<Code extends PublicErrorCode> =
  Code extends keyof PublicErrorSpecialDetailsV1
    ? PublicErrorSpecialDetailsV1[Code]
    : PublicErrorScalarMapV1 | null;

interface PublicApiErrorBaseV1 {
  message: string;
  correlation_id: string;
  retryable: boolean;
  recovery_action: RecoveryAction | null;
}

export type PublicApiErrorBodyV1 = {
  [Code in PublicErrorCode]: PublicApiErrorBaseV1 & {
    code: Code;
    details: PublicErrorDetailsV1<Code>;
  };
}[PublicErrorCode];

export interface PublicApiErrorV1 {
  schema_version: typeof PUBLIC_API_ERROR_SCHEMA_VERSION;
  error: PublicApiErrorBodyV1;
}

type ErrorSemantics = Readonly<{
  retryable: boolean;
  recovery_actions: readonly (RecoveryAction | null)[];
}>;

const semantics = (
  retryable: boolean,
  ...recovery_actions: readonly (RecoveryAction | null)[]
): ErrorSemantics =>
  Object.freeze({ retryable, recovery_actions: Object.freeze(recovery_actions) });

const noRecovery = semantics(false, null);
const refresh = semantics(false, PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL);
const restart = semantics(false, PUBLIC_RECOVERY_ACTION.RESTART_PAGINATION);

export const PUBLIC_ERROR_SEMANTICS = Object.freeze({
  [PUBLIC_ERROR_CODE.INVALID_REQUEST]: noRecovery,
  [PUBLIC_ERROR_CODE.UNAUTHENTICATED]: noRecovery,
  [PUBLIC_ERROR_CODE.FORBIDDEN]: noRecovery,
  [PUBLIC_ERROR_CODE.NOT_FOUND]: noRecovery,
  [PUBLIC_ERROR_CODE.STALE_CONVERSATION]: refresh,
  [PUBLIC_ERROR_CODE.STALE_PROPOSAL]: semantics(true, PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL),
  [PUBLIC_ERROR_CODE.STALE_CATALOG_CURSOR]: restart,
  [PUBLIC_ERROR_CODE.STALE_CAPABILITY_CURSOR]: restart,
  [PUBLIC_ERROR_CODE.STALE_ACTION_PROJECTION_CURSOR]: restart,
  [PUBLIC_ERROR_CODE.STALE_PENDING_PROPOSAL_CURSOR]: restart,
  [PUBLIC_ERROR_CODE.STALE_LINEAGE_CURSOR]: restart,
  [PUBLIC_ERROR_CODE.STALE_TIMELINE_CURSOR]: restart,
  [PUBLIC_ERROR_CODE.STALE_OPERATION_CURSOR]: restart,
  [PUBLIC_ERROR_CODE.FUTURE_EVENT_CURSOR]: restart,
  [PUBLIC_ERROR_CODE.IDEMPOTENCY_CONFLICT]: noRecovery,
  [PUBLIC_ERROR_CODE.PRIVATE_INPUT_HEAD_CONFLICT]: semantics(
    false,
    PUBLIC_RECOVERY_ACTION.RESOLVE_AGAIN,
  ),
  [PUBLIC_ERROR_CODE.SCOPE_LOCKED]: semantics(true, PUBLIC_RECOVERY_ACTION.RETRY),
  [PUBLIC_ERROR_CODE.NOT_LINEAGE_HEAD]: semantics(
    false,
    PUBLIC_RECOVERY_ACTION.SELECT_LINEAGE_HEAD,
  ),
  [PUBLIC_ERROR_CODE.LINEAGE_HEAD_UNRESOLVED]: semantics(
    false,
    PUBLIC_RECOVERY_ACTION.SELECT_LINEAGE_HEAD,
  ),
  [PUBLIC_ERROR_CODE.APPROVAL_REQUIRED]: semantics(
    false,
    PUBLIC_RECOVERY_ACTION.COMPLETE_CHALLENGE,
  ),
  [PUBLIC_ERROR_CODE.APPROVAL_EXPIRED]: refresh,
  [PUBLIC_ERROR_CODE.CHALLENGE_REQUIRED]: semantics(
    false,
    PUBLIC_RECOVERY_ACTION.COMPLETE_CHALLENGE,
  ),
  [PUBLIC_ERROR_CODE.CHALLENGE_EXPIRED]: noRecovery,
  [PUBLIC_ERROR_CODE.PERMISSION_DENIED]: semantics(
    false,
    null,
    PUBLIC_RECOVERY_ACTION.AUTHORIZE_SOURCE,
  ),
  [PUBLIC_ERROR_CODE.HANDOFF_TOO_LARGE]: semantics(false, PUBLIC_RECOVERY_ACTION.EDIT),
  [PUBLIC_ERROR_CODE.HANDOFF_MISMATCH]: semantics(false, PUBLIC_RECOVERY_ACTION.RESOLVE_AGAIN),
  [PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED]: refresh,
  [PUBLIC_ERROR_CODE.PREIMAGE_CHANGED]: refresh,
  [PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED]: refresh,
  [PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION]: noRecovery,
  [PUBLIC_ERROR_CODE.MANUAL_ACTION_REQUIRED]: semantics(
    false,
    PUBLIC_RECOVERY_ACTION.RESOLVE_AGAIN,
    PUBLIC_RECOVERY_ACTION.COMPLETE_MANUAL_STEP,
  ),
  [PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED]: semantics(false, null, PUBLIC_RECOVERY_ACTION.RETARGET),
  [PUBLIC_ERROR_CODE.DEPENDENCY_RESOLUTION_TOO_COMPLEX]: semantics(
    false,
    PUBLIC_RECOVERY_ACTION.EDIT,
  ),
  [PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY]: semantics(false, PUBLIC_RECOVERY_ACTION.REPAIR),
  [PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT]: semantics(false, PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY),
  [PUBLIC_ERROR_CODE.REPAIR_UNAVAILABLE]: noRecovery,
  [PUBLIC_ERROR_CODE.CATALOG_DEGRADED]: semantics(
    true,
    PUBLIC_RECOVERY_ACTION.REBUILD_CATALOG,
    PUBLIC_RECOVERY_ACTION.RESUME_BY_ID,
  ),
  [PUBLIC_ERROR_CODE.RATE_LIMITED]: semantics(true, PUBLIC_RECOVERY_ACTION.RETRY),
  [PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE]: semantics(true, PUBLIC_RECOVERY_ACTION.RETRY),
} satisfies Readonly<Record<PublicErrorCode, ErrorSemantics>>);

export const PUBLIC_ERROR_CANONICAL_MESSAGE = Object.freeze({
  [PUBLIC_ERROR_CODE.HANDOFF_TOO_LARGE]:
    "The shared conversation context is too large and needs reviewed compaction.",
  [PUBLIC_ERROR_CODE.PRIVATE_INPUT_HEAD_CONFLICT]:
    "The current private input selection changed before this binding could commit.",
  [PUBLIC_ERROR_CODE.SCOPE_LOCKED]:
    "The capability scope is currently locked by another operation.",
  [PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED]:
    "The approved capability action was refused because a pre-effect check changed.",
  [PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY]:
    "The capability scope requires recovery before it can be changed.",
} as const);

export const PUBLIC_ERROR_HTTP_STATUS = Object.freeze({
  [PUBLIC_ERROR_CODE.INVALID_REQUEST]: 400,
  [PUBLIC_ERROR_CODE.UNAUTHENTICATED]: 401,
  [PUBLIC_ERROR_CODE.FORBIDDEN]: 403,
  [PUBLIC_ERROR_CODE.PERMISSION_DENIED]: 403,
  [PUBLIC_ERROR_CODE.NOT_FOUND]: 404,
  [PUBLIC_ERROR_CODE.APPROVAL_EXPIRED]: 410,
  [PUBLIC_ERROR_CODE.CHALLENGE_EXPIRED]: 410,
  [PUBLIC_ERROR_CODE.REPAIR_UNAVAILABLE]: 410,
  [PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION]: 422,
  [PUBLIC_ERROR_CODE.HANDOFF_TOO_LARGE]: 422,
  [PUBLIC_ERROR_CODE.MANUAL_ACTION_REQUIRED]: 422,
  [PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED]: 422,
  [PUBLIC_ERROR_CODE.SCOPE_LOCKED]: 423,
  [PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY]: 423,
  [PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT]: 423,
  [PUBLIC_ERROR_CODE.RATE_LIMITED]: 429,
  [PUBLIC_ERROR_CODE.DEPENDENCY_RESOLUTION_TOO_COMPLEX]: 429,
  [PUBLIC_ERROR_CODE.CATALOG_DEGRADED]: 503,
  [PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE]: 503,
} satisfies Partial<Readonly<Record<PublicErrorCode, number>>>);

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const isPublicErrorCode = (value: unknown): value is PublicErrorCode =>
  memberOf(PUBLIC_ERROR_CODES, value);

export const isPublicRecoveryAction = (value: unknown): value is RecoveryAction =>
  memberOf(PUBLIC_RECOVERY_ACTIONS, value);
