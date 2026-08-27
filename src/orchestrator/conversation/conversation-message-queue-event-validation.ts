import {
  CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "./conversation-message-queue-contract.js";
import {
  assertQueueClaimOwnerV1,
  assertQueueContextDispositionV1,
  assertQueueDeliveryProofV1,
} from "./conversation-message-queue-private-validation.js";
import type {
  PrivateConversationMessageQueueEventPayloadV1,
  PrivateConversationMessageQueueEventV1,
} from "./conversation-message-queue-records.js";
import {
  editQueueRequestDigest,
  enqueueQueueRequestDigest,
  queueEventDigest,
} from "./conversation-message-queue-records.js";
import {
  assertConversationMessageQueueAuthorityV1,
  assertPublicQueuedUserMessageV1,
  isQueueDigest,
  isQueueReference,
  isQueueTimestamp,
  queueExactKeys,
  queueRecord,
} from "./conversation-message-queue-validation.js";

function assertPayload(
  value: unknown,
): asserts value is PrivateConversationMessageQueueEventPayloadV1 {
  if (!queueRecord(value) || typeof value.kind !== "string")
    throw new Error("invalid queue event payload");
  if (value.kind === CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.ADMITTED) {
    if (
      !queueExactKeys(value, CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EVENT_ADMITTED_PAYLOAD) ||
      !isQueueDigest(value.owner_principal_digest) ||
      (value.private_context_binding_digest !== null &&
        !isQueueDigest(value.private_context_binding_digest)) ||
      !isQueueDigest(value.idempotency_key_digest) ||
      !isQueueDigest(value.canonical_request_digest)
    )
      throw new Error("invalid queue admitted payload");
    assertPublicQueuedUserMessageV1(value.item);
    assertConversationMessageQueueAuthorityV1(value.admitted_authority);
    if (
      value.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
      value.item.stale_reason !== null ||
      enqueueQueueRequestDigest({
        principal_digest: value.owner_principal_digest,
        root_session_id: value.item.root_session_id,
        request: {
          schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
          expected_authority_digest: value.admitted_authority.authority_digest,
          content: value.item.content,
          target_participants: value.item.target_participants,
          quote_refs: value.item.quote_refs,
          private_context_present: value.item.private_context_present,
        },
      }) !== value.canonical_request_digest
    )
      throw new Error("queue admitted payload has invalid state");
    return;
  }
  if (value.kind === CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.EDITED) {
    if (
      !queueExactKeys(value, CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EVENT_EDITED_PAYLOAD) ||
      !isQueueDigest(value.expected_item_digest) ||
      !isQueueDigest(value.owner_principal_digest) ||
      (value.private_context_binding_digest !== null &&
        !isQueueDigest(value.private_context_binding_digest)) ||
      !isQueueDigest(value.idempotency_key_digest) ||
      !isQueueDigest(value.canonical_request_digest)
    )
      throw new Error("invalid queue edited payload");
    assertPublicQueuedUserMessageV1(value.item);
    if (
      value.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
      value.item.stale_reason !== null ||
      editQueueRequestDigest({
        principal_digest: value.owner_principal_digest,
        root_session_id: value.item.root_session_id,
        queue_item_id: value.item.queue_item_id,
        request: {
          schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
          expected_item_digest: value.expected_item_digest,
          content: value.item.content,
        },
      }) !== value.canonical_request_digest
    )
      throw new Error("queue edited payload has invalid state");
    return;
  }
  if (value.kind === CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.CLAIMED) {
    if (
      !queueExactKeys(value, CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EVENT_CLAIMED_PAYLOAD) ||
      !Number.isSafeInteger(value.claim_epoch) ||
      (value.claim_epoch as number) < 1 ||
      (value.private_context_binding_digest !== null &&
        !isQueueDigest(value.private_context_binding_digest))
    )
      throw new Error("invalid queue claimed payload");
    assertPublicQueuedUserMessageV1(value.item);
    assertQueueClaimOwnerV1(value.claim_owner);
    if (
      value.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED ||
      value.item.stale_reason !== null
    )
      throw new Error("queue claimed payload has invalid state");
    return;
  }
  if (value.kind === CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.DELIVERED) {
    if (
      !queueExactKeys(value, CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EVENT_DELIVERED_PAYLOAD) ||
      !Number.isSafeInteger(value.claim_epoch) ||
      (value.claim_epoch as number) < 1 ||
      !isQueueDigest(value.claim_owner_digest) ||
      (value.private_context_binding_digest !== null &&
        !isQueueDigest(value.private_context_binding_digest))
    )
      throw new Error("invalid queue delivered payload");
    assertPublicQueuedUserMessageV1(value.item);
    assertQueueDeliveryProofV1(value.delivery_proof);
    if (value.private_context_disposition)
      assertQueueContextDispositionV1(value.private_context_disposition);
    if (
      value.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED ||
      value.item.stale_reason !== null
    )
      throw new Error("queue delivered payload has invalid state");
    return;
  }
  if (value.kind === CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.STALE) {
    if (
      !queueExactKeys(value, CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EVENT_STALE_PAYLOAD) ||
      (value.prior_state !== CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED &&
        value.prior_state !== CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED) ||
      (value.claim_epoch !== null &&
        (!Number.isSafeInteger(value.claim_epoch) || (value.claim_epoch as number) < 1)) ||
      (value.claim_owner_digest !== null && !isQueueDigest(value.claim_owner_digest)) ||
      (value.private_context_binding_digest !== null &&
        !isQueueDigest(value.private_context_binding_digest))
    )
      throw new Error("invalid queue stale payload");
    assertPublicQueuedUserMessageV1(value.item);
    if (value.private_context_disposition)
      assertQueueContextDispositionV1(value.private_context_disposition);
    if (
      value.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.STALE ||
      value.item.stale_reason === null
    )
      throw new Error("queue stale payload has invalid state");
    return;
  }
  throw new Error("unknown queue event payload kind");
}

export function assertConversationMessageQueueEventV1(
  value: unknown,
): asserts value is PrivateConversationMessageQueueEventV1 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EVENT) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    !isQueueReference(value.root_session_id) ||
    !Number.isSafeInteger(value.journal_sequence) ||
    (value.journal_sequence as number) < 0 ||
    (value.previous_event_digest !== null && !isQueueDigest(value.previous_event_digest)) ||
    !isQueueTimestamp(value.recorded_at) ||
    !isQueueDigest(value.event_digest)
  )
    throw new Error("invalid conversation message queue event");
  assertPayload(value.payload);
  const typed = value as unknown as PrivateConversationMessageQueueEventV1;
  const { event_digest: _digest, ...preimage } = typed;
  if (
    typed.payload.item.root_session_id !== typed.root_session_id ||
    typed.payload.item.updated_at !== typed.recorded_at ||
    queueEventDigest(preimage) !== typed.event_digest
  )
    throw new Error("conversation message queue event binding changed");
}
