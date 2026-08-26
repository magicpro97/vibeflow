import {
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "./conversation-message-queue-contract.js";
import type {
  PrivateConversationMessageQueueClaimOwnerV1,
  PrivateConversationMessageQueueContextBindingV1,
  PrivateConversationMessageQueueContextDispositionV1,
  PrivateConversationMessageQueueDeliveryProofV1,
} from "./conversation-message-queue-records.js";
import {
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  queueClaimOwnerDigest,
  queueDeliveryProofDigest,
  queuePrivateContextBindingDigest,
  queuePrivateContextDispositionDigest,
} from "./conversation-message-queue-records.js";
import {
  assertConversationMessageQueueAuthorityV1,
  isQueueDigest,
  isQueueReference,
  isQueueTimestamp,
  queueExactKeys,
  queueRecord,
} from "./conversation-message-queue-validation.js";

const QUEUE_ID = /^vf-queued-message-[0-9a-f]{64}$/;
const OPERATION_ID = /^vf-operation-[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertQueueClaimOwnerV1(
  value: unknown,
): asserts value is PrivateConversationMessageQueueClaimOwnerV1 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, [
      "schema_version",
      "pid",
      "process_start_identity",
      "host",
      "operation",
      "nonce",
      "durable_operation_id",
      "owner_digest",
    ]) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    !Number.isInteger(value.pid) ||
    (value.pid as number) < 1 ||
    (value.pid as number) > 2_147_483_647 ||
    !boundedOwnerAscii(value.process_start_identity, 512) ||
    !boundedOwnerAscii(value.host, 255) ||
    !boundedOwnerAscii(value.operation, 512) ||
    typeof value.nonce !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.nonce) ||
    typeof value.durable_operation_id !== "string" ||
    !OPERATION_ID.test(value.durable_operation_id) ||
    value.operation !== `message-queue-claim:${value.durable_operation_id}` ||
    !isQueueDigest(value.owner_digest)
  )
    throw new Error("invalid conversation message queue claim owner");
  const typed = value as unknown as PrivateConversationMessageQueueClaimOwnerV1;
  const { owner_digest: _digest, ...preimage } = typed;
  if (queueClaimOwnerDigest(preimage) !== typed.owner_digest)
    throw new Error("conversation message queue claim owner digest changed");
}

export function assertQueueContextDispositionV1(
  value: unknown,
): asserts value is PrivateConversationMessageQueueContextDispositionV1 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, [
      "schema_version",
      "root_session_id",
      "queue_item_id",
      "private_context_binding_digest",
      "recorded_at",
      "disposition_digest",
      "queue_outcome",
      "disposition",
      "public_event_id",
    ]) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    !isQueueReference(value.root_session_id) ||
    typeof value.queue_item_id !== "string" ||
    !QUEUE_ID.test(value.queue_item_id) ||
    !isQueueDigest(value.private_context_binding_digest) ||
    !isQueueTimestamp(value.recorded_at) ||
    !isQueueDigest(value.disposition_digest) ||
    !(
      (value.queue_outcome === CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED &&
        value.disposition === "consumed" &&
        typeof value.public_event_id === "string" &&
        UUID.test(value.public_event_id)) ||
      (value.queue_outcome === CONVERSATION_MESSAGE_QUEUE_STATE.STALE &&
        value.disposition === "released" &&
        value.public_event_id === null)
    )
  )
    throw new Error("invalid queued-message private context disposition");
  const typed = value as unknown as PrivateConversationMessageQueueContextDispositionV1;
  const { disposition_digest: _digest, ...preimage } = typed;
  if (queuePrivateContextDispositionDigest(preimage) !== typed.disposition_digest)
    throw new Error("queued-message private context disposition digest changed");
}

export function assertQueueDeliveryProofV1(
  value: unknown,
): asserts value is PrivateConversationMessageQueueDeliveryProofV1 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, [
      "schema_version",
      "queue_item_id",
      "queue_sequence",
      "claimed_item_digest",
      "public_event_id",
      "public_seq",
      "stable_operation_digest",
      "prior_effective_authority_digest",
      "successor_authority",
      "private_context_binding_digest",
      "private_context_disposition_digest",
      "proof_digest",
    ]) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    typeof value.queue_item_id !== "string" ||
    !QUEUE_ID.test(value.queue_item_id) ||
    !Number.isSafeInteger(value.queue_sequence) ||
    (value.queue_sequence as number) < 1 ||
    !isQueueDigest(value.claimed_item_digest) ||
    typeof value.public_event_id !== "string" ||
    !UUID.test(value.public_event_id) ||
    !Number.isSafeInteger(value.public_seq) ||
    (value.public_seq as number) < 0 ||
    !isQueueDigest(value.stable_operation_digest) ||
    !isQueueDigest(value.prior_effective_authority_digest) ||
    (value.private_context_binding_digest !== null &&
      !isQueueDigest(value.private_context_binding_digest)) ||
    (value.private_context_disposition_digest !== null &&
      !isQueueDigest(value.private_context_disposition_digest)) ||
    (value.private_context_binding_digest === null) !==
      (value.private_context_disposition_digest === null) ||
    !isQueueDigest(value.proof_digest)
  )
    throw new Error("invalid queued-message delivery proof");
  assertConversationMessageQueueAuthorityV1(value.successor_authority);
  const typed = value as unknown as PrivateConversationMessageQueueDeliveryProofV1;
  const { proof_digest: _digest, ...preimage } = typed;
  if (queueDeliveryProofDigest(preimage) !== typed.proof_digest)
    throw new Error("queued-message delivery proof digest changed");
}

export function assertQueueContextBindingV1(
  value: unknown,
): asserts value is PrivateConversationMessageQueueContextBindingV1 {
  if (!queueRecord(value)) throw new Error("invalid queue private context binding");
  const typed = value as unknown as PrivateConversationMessageQueueContextBindingV1;
  const { private_context_binding_digest: _digest, ...preimage } = typed;
  if (
    !queueExactKeys(value, [
      "schema_version",
      "root_session_id",
      "queue_item_id",
      "queue_sequence",
      "owner_principal_digest",
      "enqueue_idempotency_key_digest",
      "source_kind",
      "source_record_ref",
      "source_record_digest",
      "source_reservation_digest",
      "target_participant_ids",
      "retained_at",
      "private_context_binding_digest",
    ]) ||
    typed.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    !isQueueReference(typed.root_session_id) ||
    !QUEUE_ID.test(typed.queue_item_id) ||
    !Number.isSafeInteger(typed.queue_sequence) ||
    typed.queue_sequence < 1 ||
    !isQueueDigest(typed.owner_principal_digest) ||
    !isQueueDigest(typed.enqueue_idempotency_key_digest) ||
    typed.source_kind !== "private-file-range" ||
    !isQueueReference(typed.source_record_ref, 4_096) ||
    !isQueueDigest(typed.source_record_digest) ||
    !isQueueDigest(typed.source_reservation_digest) ||
    !Array.isArray(typed.target_participant_ids) ||
    typed.target_participant_ids.length < 1 ||
    typed.target_participant_ids.length > CONVERSATION_MESSAGE_QUEUE_LIMITS.maxTargets ||
    typed.target_participant_ids.some((item) => !isQueueReference(item)) ||
    new Set(typed.target_participant_ids).size !== typed.target_participant_ids.length ||
    !isQueueTimestamp(typed.retained_at) ||
    !isQueueDigest(typed.private_context_binding_digest) ||
    queuePrivateContextBindingDigest(preimage) !== typed.private_context_binding_digest
  )
    throw new Error("invalid queue private context binding");
}
import { boundedOwnerAscii } from "../../durability/lock-owner.js";
