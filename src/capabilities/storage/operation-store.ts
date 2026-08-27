import { existsSync } from "node:fs";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import { parseStrictJson } from "../../actions/strict-json.js";
import { canonicalJsonBytes, digestV1, privateFileBytes } from "../../durability/index.js";
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
  text,
  timestamp,
} from "../wire/primitives.js";
import { type CapabilityStorePathsV1, capabilityOperationPaths } from "./paths.js";
import type { CapabilityScopeLockV1 } from "./scope-lock.js";
import {
  capabilityWalEventDigest,
  foldCapabilityWal,
  validateCapabilityWalEvent,
} from "./wal-validation.js";

export {
  capabilityWalEventDigest,
  foldCapabilityWal,
  validateCapabilityWalEvent,
  validateCapabilityWalPayload,
} from "./wal-validation.js";

export function capabilityOperationDigest(value: CapabilityOperationV1): string {
  const { header_digest: _, ...preimage } = value;
  return digestV1("VF-CAPABILITY-OPERATION\0v1\0", preimage);
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
  if (!Array.isArray(value.plan_ids) || value.plan_ids.length === 0)
    throw new CapabilityValidationError("operation plan order is empty", "operation.plan_ids");
  const planIds = new Set<string>();
  value.plan_ids.forEach((planId, index) => {
    const validated = text(planId, `operation.plan_ids[${index}]`, {
      min: 1,
      max: 512,
      ascii: true,
    });
    if (planIds.has(validated))
      throw new CapabilityValidationError(
        "operation plan order contains a duplicate",
        `operation.plan_ids[${index}]`,
      );
    planIds.add(validated);
  });
  assertSortedUnique(
    value.target_set,
    (a, b) => bytewise(a.target_id, b.target_id),
    "operation.target_set",
  );
  integer(value.authority_epoch, "operation.authority_epoch");
  timestamp(value.created_at, "operation.created_at");
  if (
    value.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY &&
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

export function readCapabilityOperationHeader(
  paths: CapabilityStorePathsV1,
  operationId: string,
): CapabilityOperationV1 | null {
  const bytes = privateFileBytes(
    capabilityOperationPaths(paths, operationId).header,
    2 * 1024 * 1024,
  );
  if (bytes === null) return null;
  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError(
      "capability operation header is corrupt",
      "operation.header",
      "integrity_failure",
    );
  }
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(parsed, { maxBytes: 2 * 1024 * 1024 })))
    throw new CapabilityValidationError(
      "capability operation header is not canonical",
      "operation.header",
      "integrity_failure",
    );
  validateCapabilityOperation(parsed as CapabilityOperationV1);
  return structuredClone(parsed as CapabilityOperationV1);
}

export function appendCapabilityWalEvent(
  paths: CapabilityStorePathsV1,
  event: CapabilityWalEventV1,
  lock: CapabilityScopeLockV1,
): void {
  validateCapabilityWalEvent(event, event.operation_id);
  const eventsPath = capabilityOperationPaths(paths, event.operation_id).events;
  const prior = existsSync(eventsPath) ? readCapabilityWal(paths, event.operation_id) : [];
  foldCapabilityWal([...prior, event]);
  appendVffrFrame(eventsPath, "capability-operation", event as unknown as JsonValue, {
    ...codec(event.operation_id),
    lock: lock.processLock,
  });
}

export function readCapabilityWal(
  paths: CapabilityStorePathsV1,
  operationId: string,
): CapabilityWalEventV1[] {
  const events = readVffrFile(
    capabilityOperationPaths(paths, operationId).events,
    codec(operationId),
  ).map((frame) => frame.payload as unknown as CapabilityWalEventV1);
  foldCapabilityWal(events);
  return events;
}
