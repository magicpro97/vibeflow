import { ACTION_OPERATION_DISPATCH_REPLAY_STATES } from "../../actions/protocol-contract.js";
import {
  CAPABILITY_HEALTH_OUTCOMES,
  CAPABILITY_OUTBOX_DELIVERIES,
  CAPABILITY_OUTBOX_DELIVERY_BY_TRANSITION,
  CAPABILITY_OUTBOX_PHASES,
  CAPABILITY_OUTBOX_TRANSITIONS,
  CAPABILITY_WAL_OPERATION_TRANSITION_FROM_STATES,
  CAPABILITY_WAL_PAYLOAD_KIND,
  type CapabilityWalPayloadV1,
  isCapabilityWalPayloadKind,
} from "../wire/operation.js";
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

function validateHealth(
  payload: Extract<CapabilityWalPayloadV1, { kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.HEALTH }>,
  path: string,
): void {
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
  enumeration(payload.outcome, CAPABILITY_HEALTH_OUTCOMES, `${path}.outcome`);
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
  payload: Extract<
    CapabilityWalPayloadV1,
    {
      kind:
        | typeof CAPABILITY_WAL_PAYLOAD_KIND.HEALTH_INVENTORY_PREPARED
        | typeof CAPABILITY_WAL_PAYLOAD_KIND.LOCK_COMMIT;
    }
  >,
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
      ...(payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.LOCK_COMMIT
        ? ["directory_fsync_completed"]
        : []),
    ],
    ["expected_health_pointer_epoch", "next_health_pointer_epoch", "next_health_pointer_digest"],
    path,
  );
  boundedWalId(payload.generation_id, `${path}.generation_id`);
  digest(payload.lock_digest, `${path}.lock_digest`);
  digest(payload.health_inventory_digest, `${path}.health_inventory_digest`);
  nullableWalDigest(
    payload.expected_health_pointer_digest,
    `${path}.expected_health_pointer_digest`,
  );
  const hasExpectedEpoch = payload.expected_health_pointer_epoch !== undefined;
  const hasNextEpoch = payload.next_health_pointer_epoch !== undefined;
  const hasNextDigest = payload.next_health_pointer_digest !== undefined;
  if (hasExpectedEpoch !== hasNextEpoch || hasExpectedEpoch !== hasNextDigest)
    throw new CapabilityValidationError(
      "health pointer publication identity must contain prior epoch, next epoch, and next digest",
      path,
    );
  if (hasExpectedEpoch) {
    if (payload.expected_health_pointer_epoch !== null)
      integer(payload.expected_health_pointer_epoch, `${path}.expected_health_pointer_epoch`);
    if (
      (payload.expected_health_pointer_epoch === null) !==
      (payload.expected_health_pointer_digest === null)
    )
      throw new CapabilityValidationError(
        "health pointer prior epoch/digest nullability differs",
        path,
      );
    integer(payload.next_health_pointer_epoch, `${path}.next_health_pointer_epoch`);
    digest(payload.next_health_pointer_digest, `${path}.next_health_pointer_digest`);
    if (payload.next_health_pointer_epoch !== (payload.expected_health_pointer_epoch ?? -1) + 1)
      throw new CapabilityValidationError(
        "health pointer successor epoch is not monotonic",
        `${path}.next_health_pointer_epoch`,
      );
  }
  if (
    payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.LOCK_COMMIT &&
    payload.directory_fsync_completed !== true
  )
    throw new CapabilityValidationError("lock commit lacks directory fsync proof", path);
}

function validateOutbox(
  payload: Extract<CapabilityWalPayloadV1, { kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.OUTBOX }>,
  path: string,
): void {
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
  enumeration(payload.phase, CAPABILITY_OUTBOX_PHASES, `${path}.phase`);
  integer(payload.phase_sequence, `${path}.phase_sequence`);
  digest(payload.public_payload_digest, `${path}.public_payload_digest`);
  enumeration(payload.transition, CAPABILITY_OUTBOX_TRANSITIONS, `${path}.transition`);
  enumeration(payload.delivery, CAPABILITY_OUTBOX_DELIVERIES, `${path}.delivery`);
  if (CAPABILITY_OUTBOX_DELIVERY_BY_TRANSITION[payload.transition] !== payload.delivery)
    throw new CapabilityValidationError("invalid outbox transition/delivery pair", path);
}

export function validateCapabilityWalPayload(
  payload: CapabilityWalPayloadV1,
  expectedOperationId: string,
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
      "expected_health_pointer_epoch",
      "next_health_pointer_epoch",
      "next_health_pointer_digest",
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
  if (!isCapabilityWalPayloadKind(outer.kind))
    throw new CapabilityValidationError("unknown capability WAL payload kind", `${path}.kind`);
  if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.OPERATION_TRANSITION) {
    exactKeys(payload, ["kind", "from", "to", "reason_code"], [], path);
    enumeration(payload.from, CAPABILITY_WAL_OPERATION_TRANSITION_FROM_STATES, `${path}.from`);
    enumeration(payload.to, ACTION_OPERATION_DISPATCH_REPLAY_STATES, `${path}.to`);
    if (payload.reason_code !== null)
      text(payload.reason_code, `${path}.reason_code`, { min: 1, max: 256, ascii: true });
  } else if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.ADAPTER_STEP) {
    exactKeys(payload, ["kind", "receipt"], [], path);
    validateAdapterReceipt(payload.receipt, `${path}.receipt`, expectedOperationId);
  } else if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.HEALTH) validateHealth(payload, path);
  else if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.PRE_EFFECT_REFUSAL) {
    exactKeys(payload, ["kind", "refusal"], [], path);
    validatePreEffectRefusal(payload.refusal, `${path}.refusal`, expectedOperationId);
  } else if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.LOCK_CHECKPOINT) {
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
  } else if (
    payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.HEALTH_INVENTORY_PREPARED ||
    payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.LOCK_COMMIT
  )
    validatePublication(payload, path);
  else if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.OUTBOX) validateOutbox(payload, path);
  else throw new CapabilityValidationError("unknown capability WAL payload kind", `${path}.kind`);
}
