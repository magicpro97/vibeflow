import { CAPABILITY_CLI_COMMAND } from "../../actions/capability-cli-contract.js";
import type { CapabilityCliResultV1 } from "../../capabilities/wire/cli.js";
import { CAPABILITY_OPERATION_STATUS } from "../../capabilities/wire/operation-state-contract.js";
import type { CapabilityQueryItemV1 } from "../../capabilities/wire/query.js";
import { CAPABILITY_PLAN_STATUS } from "../../core/capability-contract.js";
import { LOG_CHANNEL, LOG_LEVEL } from "../../core/log-contract.js";
import { c, out } from "../_shared.js";

export { resultError } from "./result-error.js";

export type CapabilityCliOutputLevel = typeof LOG_LEVEL.INFO | typeof LOG_LEVEL.ERROR;
export type CapabilityCliWriter = (message: string, level?: CapabilityCliOutputLevel) => void;

export const defaultCapabilityCliWriter: CapabilityCliWriter = (message, level) => {
  const rendered = level === LOG_LEVEL.ERROR ? c.red(message) : message;
  // `out` treats an unrecognized trailing value as message content, so never pass
  // an `undefined` options sentinel.
  if (level === undefined) return out(LOG_CHANNEL.VIBE_FLOW, rendered);
  out(LOG_CHANNEL.VIBE_FLOW, rendered, { level });
};

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
