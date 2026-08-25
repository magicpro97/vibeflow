import {
  ActionConflictError,
  type PublicApiErrorV1,
  publicActionError,
} from "../../actions/errors.js";
import { ActionValidationError } from "../../actions/strict-json.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import type { CapabilityCliResultV1 } from "../../capabilities/wire/cli.js";
import type { CapabilityQueryItemV1 } from "../../capabilities/wire/query.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import { CapabilityCliUsageError } from "./parser-types.js";

export type CapabilityCliWriter = (message: string, level?: "info" | "error") => void;

const SAFE_FALLBACK_MESSAGE: Partial<Record<PublicApiErrorV1["error"]["code"], string>> = {
  invalid_request: "Capability request is invalid.",
  unsupported_schema_version: "Capability request schema is unsupported.",
  target_unsupported: "Capability target is unsupported.",
  not_found: "Capability package was not found.",
  service_unavailable: "Capability service is unavailable.",
  manual_action_required: "Capability command requires a manual action.",
  scope_needs_recovery: "Capability scope needs recovery.",
  authority_corrupt: "Capability authority is corrupt.",
  preimage_changed: "Capability preimage changed.",
  source_digest_changed: "Capability source digest changed.",
};

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
  try {
    return publicActionError({
      code,
      message,
      correlation_id: correlationId(code, message),
      retryable,
      recovery_action,
      details: null,
    } as Extract<PublicApiErrorV1["error"], { code: Code }>).error as Extract<
      PublicApiErrorV1["error"],
      { code: Code }
    >;
  } catch {
    const fallback = SAFE_FALLBACK_MESSAGE[code] ?? "Capability command failed.";
    return publicActionError({
      code,
      message: fallback,
      correlation_id: correlationId(code, fallback),
      retryable,
      recovery_action,
      details: null,
    } as Extract<PublicApiErrorV1["error"], { code: Code }>).error as Extract<
      PublicApiErrorV1["error"],
      { code: Code }
    >;
  }
}

export function resultError(error: unknown): PublicApiErrorV1["error"] {
  if (error instanceof ActionConflictError) return error.public_error.error;
  if (error instanceof CapabilityCliUsageError) return apiError("invalid_request", error.message);
  if (error instanceof ActionValidationError) {
    if (error.code === "unsupported_schema_version")
      return apiError("unsupported_schema_version", error.message);
    if (error.code === "target_unsupported") return apiError("target_unsupported", error.message);
    return apiError("invalid_request", error.message);
  }
  if (error instanceof CapabilityRuntimeError) {
    switch (error.runtime_code) {
      case "action-required":
        return apiError("manual_action_required", error.message, false, "resolve-again");
      case "package-not-found":
        return apiError("not_found", error.message);
      case "service-unavailable":
      case "apply-failed":
      case "health-failed":
      case "rollback-failed":
      case "fault":
      case "operation-not-found":
        return apiError("service_unavailable", error.message, true, "retry");
      case "scope-needs-recovery":
        return apiError("scope_needs_recovery", error.message, false, "repair");
      case "integrity-failure":
        return apiError("authority_corrupt", error.message, false, "repair-authority");
      case "owned-preimage-stale":
        return apiError("preimage_changed", error.message, false, "refresh-proposal");
      case "scope-base-stale":
      case "authority-head-stale":
      case "policy-stale":
      case "grant-stale":
      case "source-authority-stale":
      case "permission-stale":
      case "user-prerequisite-stale":
      case "private-input-stale":
      case "enforcement-stale":
        return apiError("source_digest_changed", error.message, false, "refresh-proposal");
      default:
        return apiError("invalid_request", error.message);
    }
  }
  if (error instanceof Error) return apiError("service_unavailable", error.message, true, "retry");
  return apiError("service_unavailable", "Unknown capability command failure.", true, "retry");
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
    writer(result.error.message, "error");
    return;
  }
  if (result.kind === "query") {
    if (result.status === "failed") {
      writer(`${result.error.code}: ${result.error.message}`, "error");
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
    if (result.status === "failed") {
      writer(`${result.error.code}: ${result.error.message}`, "error");
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
    if (result.status === "failed") {
      writer(`${result.error.code}: ${result.error.message}`, "error");
      return;
    }
    writer(`Bound ${result.binding.input_ids.length} private input(s).`);
    writer(`binding_id: ${result.binding.private_binding_id}`);
    writer(`binding_digest: ${result.binding.binding_digest}`);
    return;
  }
  if (result.kind === "plan") {
    if (result.status === "failed") {
      writer(`${result.error.code}: ${result.error.message}`, "error");
      return;
    }
    writer(`${result.status}: ${result.preview.summary}`);
    writer(`plan_digest: ${result.plan_digest}`);
    return;
  }
  if (result.kind === "mutation") {
    if (result.error) writer(`${result.error.code}: ${result.error.message}`, "error");
    else writer(`${result.status}: ${result.command}`);
  }
}

export function resultExitCode(result: CapabilityCliResultV1): number {
  if (result.kind === "usage-error") return 2;
  if (result.kind === "query") {
    if (result.status === "failed")
      return ["scope_needs_recovery", "authority_corrupt"].includes(result.error.code) ? 4 : 1;
    if (result.command === "capability.status") {
      if (result.status === "needs-recovery") return 4;
      if (result.status === "degraded") return 1;
    }
    return 0;
  }
  if (result.kind === "legacy-adopt-inspection") {
    if (result.status === "succeeded") return 0;
    return ["scope_needs_recovery", "authority_corrupt"].includes(result.error.code) ? 4 : 1;
  }
  if (result.kind === "private-input-binding") {
    if (result.status === "succeeded") return 0;
    return ["scope_needs_recovery", "authority_corrupt"].includes(result.error.code) ? 4 : 1;
  }
  if (result.kind === "plan") {
    if (result.status === "planned" || result.status === "no-op") return 0;
    if (result.status === "action-required") return 3;
    return result.error && ["scope_needs_recovery", "authority_corrupt"].includes(result.error.code)
      ? 4
      : 1;
  }
  if (result.status === "needs-recovery") return 4;
  if (result.status === "degraded") return 1;
  if (result.status === "failed") return 1;
  return 0;
}
