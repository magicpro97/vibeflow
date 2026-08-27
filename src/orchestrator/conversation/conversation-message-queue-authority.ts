import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import type { ProcessLockOwnerV1 } from "../../durability/index.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS,
  type CONVERSATION_MESSAGE_QUEUE_FIELD,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STALE_REASON,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "./conversation-message-queue-contract.js";
import type { FoldedConversationMessageQueueItemV1 } from "./conversation-message-queue-fold.js";
import {
  assertQueueClaimOwnerV1,
  assertQueueContextBindingV1,
  assertQueueContextDispositionV1,
  assertQueueDeliveryProofV1,
} from "./conversation-message-queue-private-validation.js";
import type {
  ConversationMessageQueueAuthorityV1,
  ConversationMessageQueueStaleReasonV1,
  PrivateConversationMessageQueueClaimOwnerV1,
  PrivateConversationMessageQueueContextBindingV1,
  PrivateConversationMessageQueueContextDispositionV1,
  PrivateConversationMessageQueueDeliveryProofV1,
  PublicQueuedUserMessageV1,
} from "./conversation-message-queue-records.js";
import {
  queueAuthorityDigest,
  queueClaimOwnerDigest,
  queueDeliveryProofDigest,
  queuePrivateContextBindingDigest,
  queuePrivateContextDispositionDigest,
  queuedMessageDurableOperationId,
  queuedMessagePublicEventId,
} from "./conversation-message-queue-records.js";
import { assertConversationMessageQueueAuthorityV1 } from "./conversation-message-queue-validation.js";
import type { CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION } from "./conversation-private-context-broker-wire.js";

export function conversationParticipantBindingSetDigest(bindings: unknown[]): string {
  return digestV1("VF-CONVERSATION-PARTICIPANT-BINDING-SET\0v1\0", bindings);
}

export function ordinaryConversationOperationHeaderDigest(
  conversationId: string,
  activeOperationId: string,
): string {
  return digestV1("VF-EXISTING-CONVERSATION-OPERATION-AUTHORITY\0v1\0", {
    version: 1,
    conversation_id: conversationId,
    target_operation_id: activeOperationId,
  });
}

export function materializeConversationMessageQueueAuthorityV1(
  input: Omit<
    ConversationMessageQueueAuthorityV1,
    | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.SCHEMA_VERSION
    | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.AUTHORITY_DIGEST
  >,
): ConversationMessageQueueAuthorityV1 {
  const preimage = {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    ...structuredClone(input),
  };
  const authority = { ...preimage, authority_digest: queueAuthorityDigest(preimage) };
  assertConversationMessageQueueAuthorityV1(authority);
  return authority;
}

export function materializeConversationMessageQueueClaimOwnerV1(
  owner: ProcessLockOwnerV1,
  durableOperationId: string,
): PrivateConversationMessageQueueClaimOwnerV1 {
  const preimage = {
    ...structuredClone(owner),
    durable_operation_id: durableOperationId,
  };
  const claimOwner = { ...preimage, owner_digest: queueClaimOwnerDigest(preimage) };
  assertQueueClaimOwnerV1(claimOwner);
  return claimOwner;
}

export function materializeConversationMessageQueueContextBindingV1(
  input: Omit<
    PrivateConversationMessageQueueContextBindingV1,
    | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.SCHEMA_VERSION
    | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.PRIVATE_CONTEXT_BINDING_DIGEST
  >,
): PrivateConversationMessageQueueContextBindingV1 {
  const preimage = {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    ...structuredClone(input),
  };
  const binding = {
    ...preimage,
    private_context_binding_digest: queuePrivateContextBindingDigest(preimage),
  };
  assertQueueContextBindingV1(binding);
  return binding;
}

export function queueClaimOwnerMatchesProcessLock(
  claimOwner: PrivateConversationMessageQueueClaimOwnerV1,
  lockOwner: ProcessLockOwnerV1,
): boolean {
  const { durable_operation_id: _operation, owner_digest: _digest, ...processOwner } = claimOwner;
  return canonicalJsonBytes(processOwner).equals(canonicalJsonBytes(lockOwner));
}

export function classifyConversationMessageQueueAuthorityDrift(
  expected: ConversationMessageQueueAuthorityV1,
  current: ConversationMessageQueueAuthorityV1,
): ConversationMessageQueueStaleReasonV1 {
  if (
    expected.root_session_id !== current.root_session_id ||
    expected.conversation_id !== current.conversation_id ||
    expected.revision_id !== current.revision_id ||
    expected.lineage_head_digest !== current.lineage_head_digest ||
    expected.lineage_head_epoch !== current.lineage_head_epoch
  )
    return CONVERSATION_MESSAGE_QUEUE_STALE_REASON.LINEAGE_HEAD_CHANGED;
  if (expected.participant_set_digest !== current.participant_set_digest)
    return CONVERSATION_MESSAGE_QUEUE_STALE_REASON.PARTICIPANT_SET_CHANGED;
  if (expected.active_operation_digest !== current.active_operation_digest)
    return CONVERSATION_MESSAGE_QUEUE_STALE_REASON.OPERATION_CHANGED;
  return CONVERSATION_MESSAGE_QUEUE_STALE_REASON.CAUSAL_SUCCESSOR_MISMATCH;
}

export type QueueAuthorityResolutionV1 =
  | {
      status: typeof CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS.CURRENT;
      effective_authority: ConversationMessageQueueAuthorityV1;
    }
  | {
      status: typeof CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS.STALE;
      stale_reason: ConversationMessageQueueStaleReasonV1;
    };

export function resolveQueuedMessageEffectiveAuthorityV1(
  row: FoldedConversationMessageQueueItemV1,
  allItems: readonly FoldedConversationMessageQueueItemV1[],
  current: ConversationMessageQueueAuthorityV1,
): QueueAuthorityResolutionV1 {
  assertConversationMessageQueueAuthorityV1(current);
  if (current.root_session_id !== row.item.root_session_id)
    return {
      status: CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS.STALE,
      stale_reason: CONVERSATION_MESSAGE_QUEUE_STALE_REASON.LINEAGE_HEAD_CHANGED,
    };
  if (row.item.predecessor_queue_item_id === null) {
    return current.authority_digest === row.admitted_authority.authority_digest
      ? {
          status: CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS.CURRENT,
          effective_authority: structuredClone(current),
        }
      : {
          status: CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS.STALE,
          stale_reason: classifyConversationMessageQueueAuthorityDrift(
            row.admitted_authority,
            current,
          ),
        };
  }
  const predecessor = allItems.find(
    (candidate) => candidate.item.queue_item_id === row.item.predecessor_queue_item_id,
  );
  if (
    !predecessor ||
    predecessor.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED ||
    !predecessor.delivery_proof
  )
    return {
      status: CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS.STALE,
      stale_reason: CONVERSATION_MESSAGE_QUEUE_STALE_REASON.PREDECESSOR_NOT_DELIVERED,
    };
  const proof = predecessor.delivery_proof;
  if (
    predecessor.item.queue_sequence >= row.item.queue_sequence ||
    proof.queue_item_id !== predecessor.item.queue_item_id ||
    proof.queue_sequence !== predecessor.item.queue_sequence ||
    proof.prior_effective_authority_digest !== predecessor.item.effective_authority_digest
  )
    return {
      status: CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS.STALE,
      stale_reason: CONVERSATION_MESSAGE_QUEUE_STALE_REASON.CAUSAL_SUCCESSOR_MISMATCH,
    };
  return proof.successor_authority.authority_digest === current.authority_digest
    ? {
        status: CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS.CURRENT,
        effective_authority: structuredClone(current),
      }
    : {
        status: CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS.STALE,
        stale_reason: classifyConversationMessageQueueAuthorityDrift(
          proof.successor_authority,
          current,
        ),
      };
}

export function materializeConversationMessageQueueDeliveryProofV1(input: {
  item: PublicQueuedUserMessageV1 & {
    state: typeof CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED;
  };
  public_seq: number;
  stable_operation_digest: string;
  successor_authority: ConversationMessageQueueAuthorityV1;
  private_context_binding_digest: string | null;
  private_context_disposition_digest: string | null;
}): PrivateConversationMessageQueueDeliveryProofV1 {
  const preimage = {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    queue_item_id: input.item.queue_item_id,
    queue_sequence: input.item.queue_sequence,
    claimed_item_digest: input.item.item_digest,
    public_event_id: queuedMessagePublicEventId(input.item),
    public_seq: input.public_seq,
    stable_operation_digest: input.stable_operation_digest,
    prior_effective_authority_digest: input.item.effective_authority_digest,
    successor_authority: structuredClone(input.successor_authority),
    private_context_binding_digest: input.private_context_binding_digest,
    private_context_disposition_digest: input.private_context_disposition_digest,
  };
  const proof = { ...preimage, proof_digest: queueDeliveryProofDigest(preimage) };
  assertQueueDeliveryProofV1(proof);
  return proof;
}

export function materializeQueuePrivateContextDispositionV1(
  input:
    | {
        root_session_id: string;
        queue_item_id: string;
        private_context_binding_digest: string;
        recorded_at: string;
        queue_outcome: typeof CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED;
        disposition: typeof CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION.CONSUMED;
        public_event_id: string;
      }
    | {
        root_session_id: string;
        queue_item_id: string;
        private_context_binding_digest: string;
        recorded_at: string;
        queue_outcome: typeof CONVERSATION_MESSAGE_QUEUE_STATE.STALE;
        disposition: typeof CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION.RELEASED;
        public_event_id: null;
      },
): PrivateConversationMessageQueueContextDispositionV1 {
  const preimage = {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    ...structuredClone(input),
  };
  const disposition = {
    ...preimage,
    disposition_digest: queuePrivateContextDispositionDigest(preimage),
  } as PrivateConversationMessageQueueContextDispositionV1;
  assertQueueContextDispositionV1(disposition);
  return disposition;
}

export function queueClaimOperationId(item: PublicQueuedUserMessageV1): string {
  return queuedMessageDurableOperationId(item);
}
