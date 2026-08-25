import { digestV1 } from "../../durability/index.js";
import type { CapabilityWalEventV1 } from "../wire/operation.js";
import {
  CapabilityValidationError,
  digest,
  exactKeys,
  integer,
  text,
  timestamp,
} from "../wire/primitives.js";
import { validateCapabilityWalPayload } from "./wal-payload-validation.js";

function boundedId(value: unknown, path: string): string {
  return text(value, path, { min: 1, max: 512, ascii: true });
}

export function capabilityWalEventDigest(value: CapabilityWalEventV1): string {
  const { event_digest: _, ...preimage } = value;
  return digestV1("VF-CAPABILITY-WAL-EVENT\0v1\0", preimage);
}

export function validateCapabilityWalEvent(
  value: CapabilityWalEventV1,
  expectedOperationId: string,
): void {
  exactKeys(
    value,
    [
      "schema_version",
      "operation_id",
      "sequence",
      "previous_event_digest",
      "payload",
      "recorded_at",
      "event_digest",
    ],
    [],
    "event",
  );
  if (value.schema_version !== "1.0" || value.operation_id !== expectedOperationId)
    throw new CapabilityValidationError("capability WAL owner/schema mismatch", "event");
  boundedId(value.operation_id, "event.operation_id");
  integer(value.sequence, "event.sequence");
  if (value.previous_event_digest !== null)
    digest(value.previous_event_digest, "event.previous_event_digest");
  validateCapabilityWalPayload(value.payload);
  timestamp(value.recorded_at, "event.recorded_at");
  if (value.event_digest !== capabilityWalEventDigest(value))
    throw new CapabilityValidationError(
      "capability WAL event digest mismatch",
      "event.event_digest",
      "integrity_failure",
    );
}

export { validateCapabilityWalPayload } from "./wal-payload-validation.js";
export { foldCapabilityWal } from "./wal-fold.js";
export type { CapabilityWalFoldV1 } from "./wal-fold.js";
