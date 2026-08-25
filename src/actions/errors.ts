import { canonicalJsonBytes } from "../durability/index.js";
import { type PublicErrorDetailsV1, validatePublicErrorDetails } from "./error-details.js";
import { assertPublicProjectionSafe } from "./public-safety.js";
import { exactObject } from "./strict-json.js";
import type { RecoveryAction } from "./types.js";

export type PublicErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "stale_conversation"
  | "stale_proposal"
  | "stale_catalog_cursor"
  | "stale_capability_cursor"
  | "stale_action_projection_cursor"
  | "stale_pending_proposal_cursor"
  | "stale_lineage_cursor"
  | "stale_timeline_cursor"
  | "stale_operation_cursor"
  | "future_event_cursor"
  | "idempotency_conflict"
  | "private_input_head_conflict"
  | "scope_locked"
  | "not_lineage_head"
  | "lineage_head_unresolved"
  | "approval_required"
  | "approval_expired"
  | "challenge_required"
  | "challenge_expired"
  | "permission_denied"
  | "handoff_too_large"
  | "handoff_mismatch"
  | "source_digest_changed"
  | "preimage_changed"
  | "pre_effect_refused"
  | "unsupported_schema_version"
  | "manual_action_required"
  | "target_unsupported"
  | "dependency_resolution_too_complex"
  | "scope_needs_recovery"
  | "authority_corrupt"
  | "repair_unavailable"
  | "catalog_degraded"
  | "rate_limited"
  | "service_unavailable";

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
  schema_version: "1.0";
  error: PublicApiErrorBodyV1;
}

const CODES = new Set<PublicErrorCode>([
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "stale_conversation",
  "stale_proposal",
  "stale_catalog_cursor",
  "stale_capability_cursor",
  "stale_action_projection_cursor",
  "stale_pending_proposal_cursor",
  "stale_lineage_cursor",
  "stale_timeline_cursor",
  "stale_operation_cursor",
  "future_event_cursor",
  "idempotency_conflict",
  "private_input_head_conflict",
  "scope_locked",
  "not_lineage_head",
  "lineage_head_unresolved",
  "approval_required",
  "approval_expired",
  "challenge_required",
  "challenge_expired",
  "permission_denied",
  "handoff_too_large",
  "handoff_mismatch",
  "source_digest_changed",
  "preimage_changed",
  "pre_effect_refused",
  "unsupported_schema_version",
  "manual_action_required",
  "target_unsupported",
  "dependency_resolution_too_complex",
  "scope_needs_recovery",
  "authority_corrupt",
  "repair_unavailable",
  "catalog_degraded",
  "rate_limited",
  "service_unavailable",
]);
const RECOVERY_ACTIONS = new Set<RecoveryAction>([
  "retry",
  "edit",
  "refresh-proposal",
  "restart-pagination",
  "complete-challenge",
  "select-lineage-head",
  "rebuild-catalog",
  "resume-by-id",
  "inspect-trace",
  "resolve-again",
  "rollback",
  "repair",
  "repair-authority",
  "verified-abandon",
  "reconcile-revision",
  "adopt",
  "renew-grant",
  "authorize-source",
  "disable",
  "retarget",
  "complete-manual-step",
  "export-redacted-diagnostics",
]);

export class ActionConflictError extends Error {
  readonly public_error: PublicApiErrorV1;

  constructor(
    code: Extract<PublicErrorCode, "idempotency_conflict" | "stale_proposal" | "challenge_expired">,
    message: string,
    correlationId: string,
  ) {
    super(message);
    this.name = "ActionConflictError";
    this.public_error = publicActionError({
      code,
      message,
      correlation_id: correlationId,
      retryable: code === "stale_proposal",
      recovery_action: code === "stale_proposal" ? "refresh-proposal" : null,
      details: null,
    });
  }
}

export function publicActionError(input: PublicApiErrorV1["error"]): PublicApiErrorV1 {
  exactObject(
    input,
    ["code", "message", "correlation_id", "retryable", "recovery_action", "details"],
    [],
    "$.error",
  );
  if (!CODES.has(input.code)) throw new Error("unknown public error code");
  if (
    !input.message ||
    Buffer.byteLength(input.message, "utf8") > 512 ||
    /\p{Cc}/u.test(input.message)
  )
    throw new Error("invalid public error message");
  if (
    !input.correlation_id ||
    Buffer.byteLength(input.correlation_id, "utf8") > 256 ||
    !/^[\x21-\x7e]+$/.test(input.correlation_id)
  )
    throw new Error("invalid public error correlation");
  if (typeof input.retryable !== "boolean") throw new Error("invalid public error retryability");
  if (input.recovery_action !== null && !RECOVERY_ACTIONS.has(input.recovery_action))
    throw new Error("invalid public error recovery action");
  validatePublicErrorDetails(input.code, input.details);
  validateClosedErrorSemantics(input);
  const result = {
    schema_version: "1.0",
    error: input,
  } as PublicApiErrorV1;
  assertPublicProjectionSafe(result, "$.public_error", { maxBytes: 4_096 });
  if (canonicalJsonBytes(result, { maxBytes: 4_096 }).length > 4_096)
    throw new Error("public error exceeds 4 KiB");
  return result;
}

function validateClosedErrorSemantics(input: PublicApiErrorV1["error"]): void {
  if (input.code === "handoff_too_large" && (input.retryable || input.recovery_action !== "edit"))
    throw new Error("handoff_too_large public error semantics mismatch");
  if (
    input.code === "private_input_head_conflict" &&
    (input.message !==
      "The current private input selection changed before this binding could commit." ||
      input.retryable ||
      input.recovery_action !== "resolve-again")
  )
    throw new Error("private_input_head_conflict public error semantics mismatch");
  if (
    input.code === "scope_locked" &&
    (input.message !== "The capability scope is currently locked by another operation." ||
      !input.retryable ||
      input.recovery_action !== "retry")
  )
    throw new Error("scope_locked public error semantics mismatch");
  if (
    input.code === "pre_effect_refused" &&
    (input.message !==
      "The approved capability action was refused because a pre-effect check changed." ||
      input.retryable ||
      input.recovery_action !== "refresh-proposal")
  )
    throw new Error("pre_effect_refused public error semantics mismatch");
}

const STATUS: Partial<Record<PublicErrorCode, number>> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  permission_denied: 403,
  not_found: 404,
  approval_expired: 410,
  challenge_expired: 410,
  repair_unavailable: 410,
  unsupported_schema_version: 422,
  handoff_too_large: 422,
  manual_action_required: 422,
  target_unsupported: 422,
  scope_locked: 423,
  scope_needs_recovery: 423,
  authority_corrupt: 423,
  rate_limited: 429,
  dependency_resolution_too_complex: 429,
  catalog_degraded: 503,
  service_unavailable: 503,
};

export function httpStatusForPublicError(code: PublicErrorCode): number {
  return STATUS[code] ?? 409;
}
