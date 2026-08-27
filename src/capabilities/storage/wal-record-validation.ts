import { digestV1 } from "../../durability/index.js";
import {
  type AdapterReceiptV1,
  CAPABILITY_ADAPTER_RECEIPT_ERROR_STATES,
  CAPABILITY_ADAPTER_RECEIPT_STATE,
  CAPABILITY_ADAPTER_RECEIPT_STATES,
  CAPABILITY_ADAPTER_RECEIPT_UNOBSERVED_STATES,
  CAPABILITY_PRE_EFFECT_FRONTIER,
  CAPABILITY_PRE_EFFECT_FRONTIERS,
  CAPABILITY_PRE_EFFECT_OBSERVED_STATES,
  CAPABILITY_PRE_EFFECT_REFUSAL_REASONS,
  type CapabilityPreEffectRefusalV1,
  isCapabilityAdapterReceiptStateIn,
} from "../wire/operation.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  digest,
  enumeration,
  exactKeys,
  integer,
  rawSha256,
  text,
  timestamp,
} from "../wire/primitives.js";

export function nullableWalDigest(value: unknown, path: string): void {
  if (value !== null) digest(value, path);
}

export function boundedWalId(value: unknown, path: string): string {
  return text(value, path, { min: 1, max: 512, ascii: true });
}

function validateEmbeddedOperationId(
  value: unknown,
  expectedOperationId: string,
  path: string,
): void {
  const operationId = boundedWalId(value, path);
  if (operationId !== expectedOperationId)
    throw new CapabilityValidationError("embedded operation identity mismatch", path);
}

export function validateAdapterReceipt(
  receipt: AdapterReceiptV1,
  path: string,
  expectedOperationId: string,
): void {
  exactKeys(
    receipt,
    [
      "schema_version",
      "operation_id",
      "plan_id",
      "step_id",
      "target_ids",
      "source_authority_binding_digest",
      "private_input_binding_digest",
      "attempt",
      "state",
      "authority_epoch",
      "authority_head_digest",
      "policy_digest",
      "grant_digest",
      "permission_digest",
      "observed_preimage_sha256",
      "observed_postimage_sha256",
      "private_evidence_ref",
      "bounded_evidence_digest",
      "native_identifier_producer_receipt_digests",
      "error_code",
      "prepared_at",
      "observed_at",
      "receipt_digest",
    ],
    [],
    path,
  );
  if (receipt.schema_version !== "1.0")
    throw new CapabilityValidationError("unsupported adapter receipt schema", path);
  validateEmbeddedOperationId(receipt.operation_id, expectedOperationId, `${path}.operation_id`);
  boundedWalId(receipt.plan_id, `${path}.plan_id`);
  boundedWalId(receipt.step_id, `${path}.step_id`);
  if (!Array.isArray(receipt.target_ids) || receipt.target_ids.length === 0)
    throw new CapabilityValidationError("receipt target set is empty", `${path}.target_ids`);
  receipt.target_ids.forEach((value, index) => boundedWalId(value, `${path}.target_ids[${index}]`));
  assertSortedUnique(receipt.target_ids, bytewise, `${path}.target_ids`);
  for (const field of [
    "source_authority_binding_digest",
    "private_input_binding_digest",
    "authority_head_digest",
    "policy_digest",
    "grant_digest",
    "permission_digest",
  ] as const)
    digest(receipt[field], `${path}.${field}`);
  if (receipt.attempt !== 0)
    throw new CapabilityValidationError(
      "only receipt attempt zero is supported",
      `${path}.attempt`,
    );
  enumeration(receipt.state, CAPABILITY_ADAPTER_RECEIPT_STATES, `${path}.state`);
  integer(receipt.authority_epoch, `${path}.authority_epoch`);
  rawSha256(receipt.observed_preimage_sha256, `${path}.observed_preimage_sha256`);
  if (receipt.observed_postimage_sha256 !== null)
    rawSha256(receipt.observed_postimage_sha256, `${path}.observed_postimage_sha256`);
  if (receipt.private_evidence_ref !== null)
    text(receipt.private_evidence_ref, `${path}.private_evidence_ref`, {
      min: 1,
      max: 4_096,
      ascii: true,
    });
  nullableWalDigest(receipt.bounded_evidence_digest, `${path}.bounded_evidence_digest`);
  if (!Array.isArray(receipt.native_identifier_producer_receipt_digests))
    throw new CapabilityValidationError(
      "invalid producer receipt digest set",
      `${path}.native_identifier_producer_receipt_digests`,
    );
  receipt.native_identifier_producer_receipt_digests.forEach((value, index) =>
    digest(value, `${path}.native_identifier_producer_receipt_digests[${index}]`),
  );
  assertSortedUnique(
    receipt.native_identifier_producer_receipt_digests,
    bytewise,
    `${path}.native_identifier_producer_receipt_digests`,
  );
  if (receipt.error_code !== null)
    text(receipt.error_code, `${path}.error_code`, { min: 1, max: 256, ascii: true });
  timestamp(receipt.prepared_at, `${path}.prepared_at`);
  if (receipt.observed_at !== null) timestamp(receipt.observed_at, `${path}.observed_at`);
  const unobserved = isCapabilityAdapterReceiptStateIn(
    CAPABILITY_ADAPTER_RECEIPT_UNOBSERVED_STATES,
    receipt.state,
  );
  const requiresError = isCapabilityAdapterReceiptStateIn(
    CAPABILITY_ADAPTER_RECEIPT_ERROR_STATES,
    receipt.state,
  );
  if (
    unobserved !== (receipt.observed_at === null) ||
    (unobserved &&
      (receipt.observed_postimage_sha256 !== null ||
        receipt.bounded_evidence_digest !== null ||
        receipt.error_code !== null)) ||
    (!unobserved && receipt.bounded_evidence_digest === null) ||
    (receipt.state === CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED &&
      receipt.observed_postimage_sha256 === null) ||
    (receipt.state === CAPABILITY_ADAPTER_RECEIPT_STATE.FAILED &&
      receipt.observed_postimage_sha256 !== null) ||
    requiresError !== (receipt.error_code !== null)
  )
    throw new CapabilityValidationError("receipt state/nullability mismatch", path);
  const { receipt_digest: _, ...preimage } = receipt;
  if (receipt.receipt_digest !== digestV1("VF-ADAPTER-RECEIPT\0v1\0", preimage))
    throw new CapabilityValidationError(
      "adapter receipt digest mismatch",
      path,
      "integrity_failure",
    );
}

export function validatePreEffectRefusal(
  refusal: CapabilityPreEffectRefusalV1,
  path: string,
  expectedOperationId: string,
): void {
  exactKeys(
    refusal,
    [
      "schema_version",
      "operation_id",
      "frontier_kind",
      "plan_id",
      "step_id",
      "target_ids",
      "reason_code",
      "binding_key",
      "expected_digest",
      "observed_digest",
      "observed_state",
      "checked_at",
      "observation_digest",
    ],
    [],
    path,
  );
  if (refusal.schema_version !== "1.0")
    throw new CapabilityValidationError("unsupported refusal schema", path);
  validateEmbeddedOperationId(refusal.operation_id, expectedOperationId, `${path}.operation_id`);
  enumeration(refusal.frontier_kind, CAPABILITY_PRE_EFFECT_FRONTIERS, `${path}.frontier_kind`);
  if (refusal.plan_id !== null) boundedWalId(refusal.plan_id, `${path}.plan_id`);
  if (refusal.step_id !== null) boundedWalId(refusal.step_id, `${path}.step_id`);
  if (!Array.isArray(refusal.target_ids) || refusal.target_ids.length === 0)
    throw new CapabilityValidationError("refusal target set is empty", `${path}.target_ids`);
  refusal.target_ids.forEach((value, index) => boundedWalId(value, `${path}.target_ids[${index}]`));
  assertSortedUnique(refusal.target_ids, bytewise, `${path}.target_ids`);
  enumeration(refusal.reason_code, CAPABILITY_PRE_EFFECT_REFUSAL_REASONS, `${path}.reason_code`);
  text(refusal.binding_key, `${path}.binding_key`, { min: 1, max: 512, ascii: true });
  nullableWalDigest(refusal.expected_digest, `${path}.expected_digest`);
  nullableWalDigest(refusal.observed_digest, `${path}.observed_digest`);
  enumeration(
    refusal.observed_state,
    CAPABILITY_PRE_EFFECT_OBSERVED_STATES,
    `${path}.observed_state`,
  );
  timestamp(refusal.checked_at, `${path}.checked_at`);
  digest(refusal.observation_digest, `${path}.observation_digest`);
  if (
    (refusal.frontier_kind === CAPABILITY_PRE_EFFECT_FRONTIER.OPERATION ||
      refusal.frontier_kind === CAPABILITY_PRE_EFFECT_FRONTIER.LOCK_PUBLICATION) &&
    (refusal.plan_id !== null || refusal.step_id !== null)
  )
    throw new CapabilityValidationError("refusal frontier IDs are non-canonical", path);
  if (
    refusal.frontier_kind === CAPABILITY_PRE_EFFECT_FRONTIER.HEALTH_BATCH &&
    (refusal.plan_id === null || refusal.step_id !== null)
  )
    throw new CapabilityValidationError("health refusal IDs are non-canonical", path);
  if (
    refusal.frontier_kind === CAPABILITY_PRE_EFFECT_FRONTIER.ADAPTER_STEP &&
    (refusal.plan_id === null || refusal.step_id === null)
  )
    throw new CapabilityValidationError("adapter refusal IDs are non-canonical", path);
}
