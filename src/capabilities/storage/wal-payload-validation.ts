import type { CapabilityWalPayloadV1 } from "../wire/operation.js";
import {
  CapabilityValidationError,
  digest,
  enumeration,
  exactKeys,
  integer,
  rawSha256,
  text,
  timestamp,
} from "../wire/primitives.js";
import {
  boundedWalId,
  nullableWalDigest,
  validateAdapterReceipt,
  validatePreEffectRefusal,
} from "./wal-record-validation.js";

const OPERATION_STATES = ["committing", "succeeded", "failed", "needs_recovery"] as const;

function validateHealth(payload: CapabilityWalPayloadV1 & { kind: "health" }, path: string): void {
  exactKeys(
    payload,
    [
      "kind",
      "plan_id",
      "observation_digest",
      "target_id",
      "probe_id",
      "outcome",
      "checked_at",
      "expires_at",
      "evidence_digest",
    ],
    [],
    path,
  );
  boundedWalId(payload.plan_id, `${path}.plan_id`);
  digest(payload.observation_digest, `${path}.observation_digest`);
  boundedWalId(payload.target_id, `${path}.target_id`);
  boundedWalId(payload.probe_id, `${path}.probe_id`);
  enumeration(
    payload.outcome,
    ["ready", "degraded", "failed", "unknown", "stale"] as const,
    `${path}.outcome`,
  );
  if (
    timestamp(payload.expires_at, `${path}.expires_at`) <=
    timestamp(payload.checked_at, `${path}.checked_at`)
  )
    throw new CapabilityValidationError(
      "health expiry must follow observation",
      `${path}.expires_at`,
    );
  digest(payload.evidence_digest, `${path}.evidence_digest`);
}

function validatePublication(
  payload: CapabilityWalPayloadV1 & {
    kind: "health-inventory-prepared" | "lock-commit";
  },
  path: string,
): void {
  exactKeys(
    payload,
    [
      "kind",
      "generation_id",
      "lock_digest",
      "health_inventory_digest",
      "expected_health_pointer_digest",
      ...(payload.kind === "lock-commit" ? ["directory_fsync_completed"] : []),
    ],
    [],
    path,
  );
  boundedWalId(payload.generation_id, `${path}.generation_id`);
  digest(payload.lock_digest, `${path}.lock_digest`);
  digest(payload.health_inventory_digest, `${path}.health_inventory_digest`);
  nullableWalDigest(
    payload.expected_health_pointer_digest,
    `${path}.expected_health_pointer_digest`,
  );
  if (payload.kind === "lock-commit" && payload.directory_fsync_completed !== true)
    throw new CapabilityValidationError("lock commit lacks directory fsync proof", path);
}

function validateOutbox(payload: CapabilityWalPayloadV1 & { kind: "outbox" }, path: string): void {
  exactKeys(
    payload,
    [
      "kind",
      "outbox_event_id",
      "payload_ref",
      "phase",
      "phase_sequence",
      "public_payload_digest",
      "transition",
      "delivery",
    ],
    [],
    path,
  );
  if (!/^vf-outbox-[a-f0-9]{64}$/.test(payload.outbox_event_id))
    throw new CapabilityValidationError("invalid outbox event ID", `${path}.outbox_event_id`);
  if (!/^vf-outbox-payload-[a-f0-9]{64}$/.test(payload.payload_ref))
    throw new CapabilityValidationError("invalid outbox payload ref", `${path}.payload_ref`);
  enumeration(
    payload.phase,
    [
      "operation-started",
      "target-applied",
      "target-omitted",
      "target-reversed",
      "target-degraded",
      "target-failed",
      "target-blocked",
      "target-needs-recovery",
      "operation-succeeded",
      "operation-failed",
      "operation-needs-recovery",
    ] as const,
    `${path}.phase`,
  );
  integer(payload.phase_sequence, `${path}.phase_sequence`);
  digest(payload.public_payload_digest, `${path}.public_payload_digest`);
  enumeration(
    payload.transition,
    ["created", "delivered", "delivery-failed"] as const,
    `${path}.transition`,
  );
  enumeration(payload.delivery, ["pending", "delivered", "failed"] as const, `${path}.delivery`);
  if (
    !["created/pending", "delivered/delivered", "delivery-failed/failed"].includes(
      `${payload.transition}/${payload.delivery}`,
    )
  )
    throw new CapabilityValidationError("invalid outbox transition/delivery pair", path);
}

export function validateCapabilityWalPayload(
  payload: CapabilityWalPayloadV1,
  path = "event.payload",
): void {
  const outer = exactKeys(
    payload,
    ["kind"],
    [
      "from",
      "to",
      "reason_code",
      "receipt",
      "plan_id",
      "observation_digest",
      "target_id",
      "probe_id",
      "outcome",
      "checked_at",
      "expires_at",
      "evidence_digest",
      "refusal",
      "prior_generation_id",
      "prior_lock_digest",
      "checkpoint_bytes_sha256",
      "checkpoint_digest",
      "generation_id",
      "lock_digest",
      "health_inventory_digest",
      "expected_health_pointer_digest",
      "directory_fsync_completed",
      "outbox_event_id",
      "payload_ref",
      "phase",
      "phase_sequence",
      "public_payload_digest",
      "transition",
      "delivery",
    ],
    path,
  );
  text(outer.kind, `${path}.kind`, { min: 1, max: 64, ascii: true });
  if (payload.kind === "operation-transition") {
    exactKeys(payload, ["kind", "from", "to", "reason_code"], [], path);
    enumeration(payload.from, ["created", ...OPERATION_STATES] as const, `${path}.from`);
    enumeration(payload.to, OPERATION_STATES, `${path}.to`);
    if (payload.reason_code !== null)
      text(payload.reason_code, `${path}.reason_code`, { min: 1, max: 256, ascii: true });
  } else if (payload.kind === "adapter-step") {
    exactKeys(payload, ["kind", "receipt"], [], path);
    validateAdapterReceipt(payload.receipt, `${path}.receipt`);
  } else if (payload.kind === "health") validateHealth(payload, path);
  else if (payload.kind === "pre-effect-refusal") {
    exactKeys(payload, ["kind", "refusal"], [], path);
    validatePreEffectRefusal(payload.refusal, `${path}.refusal`);
  } else if (payload.kind === "lock-checkpoint") {
    exactKeys(
      payload,
      [
        "kind",
        "prior_generation_id",
        "prior_lock_digest",
        "checkpoint_bytes_sha256",
        "checkpoint_digest",
      ],
      [],
      path,
    );
    boundedWalId(payload.prior_generation_id, `${path}.prior_generation_id`);
    digest(payload.prior_lock_digest, `${path}.prior_lock_digest`);
    rawSha256(payload.checkpoint_bytes_sha256, `${path}.checkpoint_bytes_sha256`);
    digest(payload.checkpoint_digest, `${path}.checkpoint_digest`);
  } else if (payload.kind === "health-inventory-prepared" || payload.kind === "lock-commit")
    validatePublication(payload, path);
  else if (payload.kind === "outbox") validateOutbox(payload, path);
  else throw new CapabilityValidationError("unknown capability WAL payload kind", `${path}.kind`);
}
