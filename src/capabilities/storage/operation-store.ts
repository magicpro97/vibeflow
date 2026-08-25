import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import {
  appendVffrFrame,
  createOrVerifyPrivateFile,
  readVffrFile,
} from "../../durability/index.js";
import type { JsonValue } from "../../durability/index.js";
import type { CapabilityOperationV1, CapabilityWalEventV1 } from "../wire/operation.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  digest,
  integer,
  timestamp,
} from "../wire/primitives.js";
import { type CapabilityStorePathsV1, capabilityOperationPaths } from "./paths.js";
import type { CapabilityScopeLockV1 } from "./scope-lock.js";

export function capabilityOperationDigest(value: CapabilityOperationV1): string {
  const { header_digest: _, ...preimage } = value;
  return digestV1("VF-CAPABILITY-OPERATION\0v1\0", preimage);
}

export function capabilityWalEventDigest(value: CapabilityWalEventV1): string {
  const { event_digest: _, ...preimage } = value;
  return digestV1("VF-CAPABILITY-WAL-EVENT\0v1\0", preimage);
}

export function validateCapabilityOperation(value: CapabilityOperationV1): void {
  if (value.schema_version !== "1.0")
    throw new CapabilityValidationError(
      "unsupported capability operation schema",
      "operation.schema_version",
      "unsupported_schema_version",
    );
  digest(value.scope_identity_digest, "operation.scope_identity_digest");
  digest(value.execution_object_closure_digest, "operation.execution_object_closure_digest");
  for (const field of [
    "proposal_digest",
    "approval_digest",
    "plan_digest",
    "source_authority_set_digest",
    "authority_head_digest",
    "policy_digest",
    "grant_digest",
    "permission_digest",
  ] as const)
    digest(value[field], `operation.${field}`);
  if (value.base_lock_digest !== null) digest(value.base_lock_digest, "operation.base_lock_digest");
  assertSortedUnique(
    value.parent_generation_digests,
    bytewise,
    "operation.parent_generation_digests",
  );
  assertSortedUnique(value.plan_ids, bytewise, "operation.plan_ids");
  assertSortedUnique(
    value.target_set,
    (a, b) => bytewise(a.target_id, b.target_id),
    "operation.target_set",
  );
  integer(value.authority_epoch, "operation.authority_epoch");
  timestamp(value.created_at, "operation.created_at");
  if (
    value.action_root_locator.kind === "capability" &&
    (value.action_root_locator.scope !== value.scope ||
      value.action_root_locator.scope_identity_digest !== value.scope_identity_digest)
  )
    throw new CapabilityValidationError(
      "operation action-root locator scope mismatch",
      "operation.action_root_locator",
    );
  if (value.header_digest !== capabilityOperationDigest(value))
    throw new CapabilityValidationError(
      "capability operation header digest mismatch",
      "operation.header_digest",
      "integrity_failure",
    );
}

export function validateCapabilityWalEvent(
  value: CapabilityWalEventV1,
  expectedOperationId: string,
): void {
  if (value.schema_version !== "1.0" || value.operation_id !== expectedOperationId)
    throw new CapabilityValidationError("capability WAL owner/schema mismatch", "event");
  integer(value.sequence, "event.sequence");
  if (value.previous_event_digest !== null)
    digest(value.previous_event_digest, "event.previous_event_digest");
  timestamp(value.recorded_at, "event.recorded_at");
  if (value.event_digest !== capabilityWalEventDigest(value))
    throw new CapabilityValidationError(
      "capability WAL event digest mismatch",
      "event.event_digest",
      "integrity_failure",
    );
  if (value.sequence === 0) {
    const payload = value.payload;
    if (
      payload.kind !== "operation-transition" ||
      payload.from !== "created" ||
      payload.to !== "committing" ||
      payload.reason_code !== null
    )
      throw new CapabilityValidationError(
        "capability WAL sequence zero has wrong transition",
        "event.payload",
      );
  }
}

function codec(operationId: string) {
  return {
    domain: "capability-operation" as const,
    maxFrames: 100_000,
    maxPayloadBytes: 2 * 1024 * 1024,
    maxAggregateBytes: 256 * 1024 * 1024,
    validatePayload: (payload: Record<string, unknown>) =>
      validateCapabilityWalEvent(payload as unknown as CapabilityWalEventV1, operationId),
    computePayloadDigest: (payload: Record<string, unknown>) =>
      capabilityWalEventDigest(payload as unknown as CapabilityWalEventV1),
    validateJournalIdentity: (payload: Record<string, unknown>) =>
      payload.operation_id === operationId,
  };
}

export function writeCapabilityOperationHeader(
  paths: CapabilityStorePathsV1,
  operation: CapabilityOperationV1,
  lock: CapabilityScopeLockV1,
): void {
  validateCapabilityOperation(operation);
  const target = capabilityOperationPaths(paths, operation.operation_id).header;
  createOrVerifyPrivateFile(target, canonicalJsonBytes(operation), {
    lock: lock.processLock,
    maxBytes: 2 * 1024 * 1024,
  });
}

export function appendCapabilityWalEvent(
  paths: CapabilityStorePathsV1,
  event: CapabilityWalEventV1,
  lock: CapabilityScopeLockV1,
): void {
  validateCapabilityWalEvent(event, event.operation_id);
  appendVffrFrame(
    capabilityOperationPaths(paths, event.operation_id).events,
    "capability-operation",
    event as unknown as JsonValue,
    { ...codec(event.operation_id), lock: lock.processLock },
  );
}

export function readCapabilityWal(
  paths: CapabilityStorePathsV1,
  operationId: string,
): CapabilityWalEventV1[] {
  return readVffrFile(capabilityOperationPaths(paths, operationId).events, codec(operationId)).map(
    (frame) => frame.payload as unknown as CapabilityWalEventV1,
  );
}
