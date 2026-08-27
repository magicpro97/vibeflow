import { ActionAuthorityStaleError } from "../../actions/authority-proofs.js";
import { CAPABILITY_CLI_COMMAND } from "../../actions/capability-cli-contract.js";
import {
  ActionConflictError,
  type PublicApiErrorV1,
  publicActionError,
} from "../../actions/errors.js";
import {
  PUBLIC_API_ERROR_MESSAGE_MAX_BYTES,
  PUBLIC_ERROR_CANONICAL_MESSAGE,
  PUBLIC_ERROR_CODE,
  PUBLIC_RECOVERY_ACTION,
} from "../../actions/public-error-contract.js";
import { isBoundedWireText } from "../../actions/public-wire-primitives.js";
import { ActionValidationError } from "../../actions/strict-json.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import type { CapabilityCliResultV1 } from "../../capabilities/wire/cli.js";
import { CAPABILITY_OPERATION_STATUS } from "../../capabilities/wire/operation-state-contract.js";
import type { CapabilityQueryItemV1 } from "../../capabilities/wire/query.js";
import {
  CAPABILITY_PLAN_STATUS,
  CAPABILITY_RUNTIME_ERROR_CODE,
  type CapabilityRuntimeErrorCodeV1,
  isCapabilityRuntimeErrorCode,
} from "../../core/capability-contract.js";
import { LOG_CHANNEL, LOG_LEVEL } from "../../core/log-contract.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import { c, out } from "../_shared.js";
import { CapabilityCliUsageError } from "./parser-types.js";

export type CapabilityCliOutputLevel = typeof LOG_LEVEL.INFO | typeof LOG_LEVEL.ERROR;
export type CapabilityCliWriter = (message: string, level?: CapabilityCliOutputLevel) => void;

export const defaultCapabilityCliWriter: CapabilityCliWriter = (message, level) => {
  const rendered = level === LOG_LEVEL.ERROR ? c.red(message) : message;
  // `out` treats an unrecognized trailing value as message content, so never pass
  // an `undefined` options sentinel.
  if (level === undefined) return out(LOG_CHANNEL.VIBE_FLOW, rendered);
  out(LOG_CHANNEL.VIBE_FLOW, rendered, { level });
};

const SAFE_FALLBACK_MESSAGE: Partial<Record<PublicApiErrorV1["error"]["code"], string>> = {
  [PUBLIC_ERROR_CODE.INVALID_REQUEST]: "Capability request is invalid.",
  [PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION]: "Capability request schema is unsupported.",
  [PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED]: "Capability target is unsupported.",
  [PUBLIC_ERROR_CODE.NOT_FOUND]: "Capability package was not found.",
  [PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE]: "Capability service is unavailable.",
  [PUBLIC_ERROR_CODE.MANUAL_ACTION_REQUIRED]: "Capability command requires a manual action.",
  [PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY]:
    PUBLIC_ERROR_CANONICAL_MESSAGE[PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY],
  [PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT]: "Capability authority is corrupt.",
  [PUBLIC_ERROR_CODE.PREIMAGE_CHANGED]: "Capability preimage changed.",
  [PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED]: "Capability source digest changed.",
};

const CAPABILITY_RUNTIME_ERROR_PUBLIC_MESSAGE = Object.freeze({
  [CAPABILITY_RUNTIME_ERROR_CODE.ACTION_REQUIRED]: "Capability command requires a manual action.",
  [CAPABILITY_RUNTIME_ERROR_CODE.PACKAGE_NOT_FOUND]: "Capability package was not found.",
  [CAPABILITY_RUNTIME_ERROR_CODE.AMBIGUOUS_PACKAGE]: "Capability package selection is ambiguous.",
  [CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE]: "Capability service is unavailable.",
  [CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN]: "Capability plan is invalid.",
  [CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH]:
    "Capability request authority is invalid.",
  [CAPABILITY_RUNTIME_ERROR_CODE.AUTHORITY_HEAD_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.POLICY_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.GRANT_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.SOURCE_AUTHORITY_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.PERMISSION_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.USER_PREREQUISITE_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.PRIVATE_INPUT_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.ENFORCEMENT_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_BASE_STALE]: "Capability source digest changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.OWNED_PREIMAGE_STALE]: "Capability preimage changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.APPLY_FAILED]: "Capability service is unavailable.",
  [CAPABILITY_RUNTIME_ERROR_CODE.HEALTH_FAILED]: "Capability service is unavailable.",
  [CAPABILITY_RUNTIME_ERROR_CODE.ROLLBACK_FAILED]: "Capability service is unavailable.",
  [CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY]:
    PUBLIC_ERROR_CANONICAL_MESSAGE[PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY],
  [CAPABILITY_RUNTIME_ERROR_CODE.OPERATION_NOT_FOUND]: "Capability service is unavailable.",
  [CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE]: "Capability authority is corrupt.",
  [CAPABILITY_RUNTIME_ERROR_CODE.FAULT]: "Capability service is unavailable.",
} satisfies Readonly<Record<CapabilityRuntimeErrorCodeV1, string>>);

const UNSAFE_OPERATIONAL_MESSAGE =
  /\b(?:undefined|ENOENT|EACCES|EPERM|ENOTDIR|EISDIR)\b|\b(?:Assertion|Eval|Range|Reference|Syntax|Type|URI)?Error:/iu;

function safePublicMessage(code: PublicApiErrorV1["error"]["code"], message: string): string {
  const fallback = SAFE_FALLBACK_MESSAGE[code] ?? "Capability command failed.";
  const value = message.trim();
  if (
    !isBoundedWireText(value, { maxBytes: PUBLIC_API_ERROR_MESSAGE_MAX_BYTES }) ||
    UNSAFE_OPERATIONAL_MESSAGE.test(value) ||
    value.includes("/") ||
    value.includes("\\")
  )
    return fallback;
  return value;
}

function correlationId(code: string, message: string): string {
  return `vf-capability-cli-${digestHex(
    digestV1("VF-CAPABILITY-CLI-ERROR\0v1\0", { code, message }),
  )}`;
}

function apiError<Code extends PublicApiErrorV1["error"]["code"]>(
  code: Code,
  message: string,
  retryable = false,
  recovery_action: PublicApiErrorV1["error"]["recovery_action"] = null,
): Extract<PublicApiErrorV1["error"], { code: Code }> {
  const publicMessage = safePublicMessage(code, message);
  const details = code === PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY ? { operation_id: null } : null;
  return publicActionError({
    code,
    message: publicMessage,
    correlation_id: correlationId(code, publicMessage),
    retryable,
    recovery_action,
    details,
  } as Extract<PublicApiErrorV1["error"], { code: Code }>).error as Extract<
    PublicApiErrorV1["error"],
    { code: Code }
  >;
}

export function resultError(error: unknown): PublicApiErrorV1["error"] {
  if (error instanceof ActionConflictError) {
    const publicError = error.public_error.error;
    return apiError(
      publicError.code,
      publicError.message,
      publicError.retryable,
      publicError.recovery_action,
    );
  }
  if (error instanceof CapabilityCliUsageError)
    return apiError(PUBLIC_ERROR_CODE.INVALID_REQUEST, error.message);
  if (error instanceof ActionValidationError) {
    if (error.code === PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION)
      return apiError(PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION, error.message);
    if (error.code === PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED)
      return apiError(PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED, error.message);
    return apiError(PUBLIC_ERROR_CODE.INVALID_REQUEST, error.message);
  }
  if (error instanceof ActionAuthorityStaleError)
    return apiError(
      PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED,
      "Capability authority changed.",
      false,
      PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
    );
  if (error instanceof CapabilityRuntimeError) {
    if (!isCapabilityRuntimeErrorCode(error.runtime_code)) throw error;
    const message = CAPABILITY_RUNTIME_ERROR_PUBLIC_MESSAGE[error.runtime_code];
    switch (error.runtime_code) {
      case CAPABILITY_RUNTIME_ERROR_CODE.ACTION_REQUIRED:
        return apiError(
          PUBLIC_ERROR_CODE.MANUAL_ACTION_REQUIRED,
          message,
          false,
          PUBLIC_RECOVERY_ACTION.RESOLVE_AGAIN,
        );
      case CAPABILITY_RUNTIME_ERROR_CODE.PACKAGE_NOT_FOUND:
        return apiError(PUBLIC_ERROR_CODE.NOT_FOUND, message);
      case CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE:
      case CAPABILITY_RUNTIME_ERROR_CODE.APPLY_FAILED:
      case CAPABILITY_RUNTIME_ERROR_CODE.HEALTH_FAILED:
      case CAPABILITY_RUNTIME_ERROR_CODE.ROLLBACK_FAILED:
      case CAPABILITY_RUNTIME_ERROR_CODE.FAULT:
      case CAPABILITY_RUNTIME_ERROR_CODE.OPERATION_NOT_FOUND:
        return apiError(
          PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
          message,
          true,
          PUBLIC_RECOVERY_ACTION.RETRY,
        );
      case CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY:
        return apiError(
          PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
          message,
          false,
          PUBLIC_RECOVERY_ACTION.REPAIR,
        );
      case CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE:
        return apiError(
          PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT,
          message,
          false,
          PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY,
        );
      case CAPABILITY_RUNTIME_ERROR_CODE.OWNED_PREIMAGE_STALE:
        return apiError(
          PUBLIC_ERROR_CODE.PREIMAGE_CHANGED,
          message,
          false,
          PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
        );
      case CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_BASE_STALE:
      case CAPABILITY_RUNTIME_ERROR_CODE.AUTHORITY_HEAD_STALE:
      case CAPABILITY_RUNTIME_ERROR_CODE.POLICY_STALE:
      case CAPABILITY_RUNTIME_ERROR_CODE.GRANT_STALE:
      case CAPABILITY_RUNTIME_ERROR_CODE.SOURCE_AUTHORITY_STALE:
      case CAPABILITY_RUNTIME_ERROR_CODE.PERMISSION_STALE:
      case CAPABILITY_RUNTIME_ERROR_CODE.USER_PREREQUISITE_STALE:
      case CAPABILITY_RUNTIME_ERROR_CODE.PRIVATE_INPUT_STALE:
      case CAPABILITY_RUNTIME_ERROR_CODE.ENFORCEMENT_STALE:
        return apiError(
          PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED,
          message,
          false,
          PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
        );
      case CAPABILITY_RUNTIME_ERROR_CODE.AMBIGUOUS_PACKAGE:
      case CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN:
      case CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH:
        return apiError(PUBLIC_ERROR_CODE.INVALID_REQUEST, message);
      default:
        throw error;
    }
  }
  throw error;
}

function renderItem(item: CapabilityQueryItemV1): string {
  const version = item.version ? `@${item.version}` : "";
  const targets = item.targets
    .map((target) => `${target.engine ?? "host"}:${target.status}`)
    .join(", ");
  return `${item.package_id}${version}  ${item.status}${targets ? `  [${targets}]` : ""}`;
}

export function printResult(result: CapabilityCliResultV1, writer: CapabilityCliWriter): void {
  if (result.kind === "usage-error") {
    writer(result.error.message, LOG_LEVEL.ERROR);
    return;
  }
  if (result.kind === "query") {
    if (result.status === CAPABILITY_OPERATION_STATUS.FAILED) {
      writer(`${result.error.code}: ${result.error.message}`, LOG_LEVEL.ERROR);
      return;
    }
    if (result.items.length === 0) {
      writer("No capabilities matched.");
      return;
    }
    for (const item of result.items) writer(renderItem(item));
    if (result.next_cursor) writer(`next_cursor: ${result.next_cursor}`);
    return;
  }
  if (result.kind === "legacy-adopt-inspection") {
    if (result.status === CAPABILITY_OPERATION_STATUS.FAILED) {
      writer(`${result.error.code}: ${result.error.message}`, LOG_LEVEL.ERROR);
      return;
    }
    writer(
      `Found ${result.inspection.candidates.length} adoptable legacy candidate${result.inspection.candidates.length === 1 ? "" : "s"}.`,
    );
    for (const candidate of result.inspection.candidates)
      writer(
        `${candidate.package_pin.id}@${candidate.package_pin.version}  ${candidate.legacy_source}`,
      );
    return;
  }
  if (result.kind === "private-input-binding") {
    if (result.status === CAPABILITY_OPERATION_STATUS.FAILED) {
      writer(`${result.error.code}: ${result.error.message}`, LOG_LEVEL.ERROR);
      return;
    }
    writer(`Bound ${result.binding.input_ids.length} private input(s).`);
    writer(`binding_id: ${result.binding.private_binding_id}`);
    writer(`binding_digest: ${result.binding.binding_digest}`);
    return;
  }
  if (result.kind === "plan") {
    if (result.status === CAPABILITY_OPERATION_STATUS.FAILED) {
      writer(`${result.error.code}: ${result.error.message}`, LOG_LEVEL.ERROR);
      return;
    }
    writer(`${result.status}: ${result.preview.summary}`);
    writer(`plan_digest: ${result.plan_digest}`);
    return;
  }
  if (result.kind === "mutation") {
    if (result.error) writer(`${result.error.code}: ${result.error.message}`, LOG_LEVEL.ERROR);
    else writer(`${result.status}: ${result.command}`);
  }
}

export function resultExitCode(result: CapabilityCliResultV1): number {
  if (result.kind === "usage-error") return 2;
  if (result.kind === "query") {
    if (result.status === CAPABILITY_OPERATION_STATUS.FAILED)
      return ["scope_needs_recovery", "authority_corrupt"].includes(result.error.code) ? 4 : 1;
    if (result.command === CAPABILITY_CLI_COMMAND.STATUS) {
      if (result.status === CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY) return 4;
      if (result.status === CAPABILITY_OPERATION_STATUS.DEGRADED) return 1;
    }
    return 0;
  }
  if (result.kind === "legacy-adopt-inspection") {
    if (result.status === CAPABILITY_OPERATION_STATUS.SUCCEEDED) return 0;
    return ["scope_needs_recovery", "authority_corrupt"].includes(result.error.code) ? 4 : 1;
  }
  if (result.kind === "private-input-binding") {
    if (result.status === CAPABILITY_OPERATION_STATUS.SUCCEEDED) return 0;
    return ["scope_needs_recovery", "authority_corrupt"].includes(result.error.code) ? 4 : 1;
  }
  if (result.kind === "plan") {
    if (
      result.status === CAPABILITY_PLAN_STATUS.PLANNED ||
      result.status === CAPABILITY_PLAN_STATUS.NO_OP
    )
      return 0;
    if (result.status === CAPABILITY_PLAN_STATUS.ACTION_REQUIRED) return 3;
    return result.error && ["scope_needs_recovery", "authority_corrupt"].includes(result.error.code)
      ? 4
      : 1;
  }
  if (result.status === CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY) return 4;
  if (result.status === CAPABILITY_OPERATION_STATUS.DEGRADED) return 1;
  if (result.status === CAPABILITY_OPERATION_STATUS.FAILED) return 1;
  return 0;
}

export function emitCapabilityCliResult(
  result: CapabilityCliResultV1,
  json: boolean,
  writer: CapabilityCliWriter,
): number {
  if (json) writer(JSON.stringify(result));
  else printResult(result, writer);
  return resultExitCode(result);
}
