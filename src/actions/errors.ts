import { canonicalJsonBytes } from "../durability/index.js";
import {
  PUBLIC_API_ERROR_MAX_BYTES,
  PUBLIC_API_ERROR_SCHEMA_VERSION,
  PUBLIC_ERROR_CODE,
  PUBLIC_ERROR_HTTP_STATUS,
  PUBLIC_RECOVERY_ACTION,
  type PublicApiErrorV1,
  type PublicErrorCode,
} from "./public-error-contract.js";
import { parsePublicApiErrorBody } from "./public-error-wire-validation.js";
import { assertPublicProjectionSafe } from "./public-safety.js";

export type {
  PublicApiErrorBodyV1,
  PublicApiErrorV1,
  PublicErrorCode,
} from "./public-error-contract.js";

export class ActionConflictError extends Error {
  readonly public_error: PublicApiErrorV1;

  constructor(
    code: Extract<
      PublicErrorCode,
      | typeof PUBLIC_ERROR_CODE.IDEMPOTENCY_CONFLICT
      | typeof PUBLIC_ERROR_CODE.STALE_PROPOSAL
      | typeof PUBLIC_ERROR_CODE.CHALLENGE_EXPIRED
    >,
    message: string,
    correlationId: string,
  ) {
    super(message);
    this.name = "ActionConflictError";
    const stale = code === PUBLIC_ERROR_CODE.STALE_PROPOSAL;
    this.public_error = publicActionError({
      code,
      message,
      correlation_id: correlationId,
      retryable: stale,
      recovery_action: stale ? PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL : null,
      details: null,
    });
  }
}

export function publicActionError(input: PublicApiErrorV1["error"]): PublicApiErrorV1 {
  const error = parsePublicApiErrorBody(input);
  const result: PublicApiErrorV1 = {
    schema_version: PUBLIC_API_ERROR_SCHEMA_VERSION,
    error,
  };
  assertPublicProjectionSafe(result, "$.public_error", { maxBytes: PUBLIC_API_ERROR_MAX_BYTES });
  if (
    canonicalJsonBytes(result, { maxBytes: PUBLIC_API_ERROR_MAX_BYTES }).length >
    PUBLIC_API_ERROR_MAX_BYTES
  )
    throw new Error("public error exceeds 4 KiB");
  return result;
}

export function httpStatusForPublicError(code: PublicErrorCode): number {
  return PUBLIC_ERROR_HTTP_STATUS[code as keyof typeof PUBLIC_ERROR_HTTP_STATUS] ?? 409;
}
