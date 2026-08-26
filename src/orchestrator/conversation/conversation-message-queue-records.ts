import { digestHex, digestV1 } from "../../durability/index.js";
import type { PublicQuoteReferenceV1 } from "./conversation-interaction-types.js";
import {
  type CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  type CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  type CONVERSATION_MESSAGE_QUEUE_STATE,
  type ConversationMessageQueueMutationKindV1,
  type ConversationMessageQueueSchemaVersionV1,
  type ConversationMessageQueueStaleReasonV1,
  type ConversationMessageQueueStateV1,
} from "./conversation-message-queue-contract.js";

export {
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  type ConversationMessageQueueStaleReasonV1,
  type ConversationMessageQueueStateV1,
} from "./conversation-message-queue-contract.js";

export interface ConversationMessageQueueAuthorityV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  lineage_head_digest: string;
  lineage_head_epoch: number;
  participant_set_digest: string;
  active_operation_digest: string | null;
  authority_digest: string;
}

export interface EnqueueConversationUserMessageRequestV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  idempotency_key: string;
  expected_authority_digest: string;
  content: string;
  target_participants: "all" | string[];
  quote_refs: PublicQuoteReferenceV1[];
  private_context_present: boolean;
}

export interface EditQueuedUserMessageRequestV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  idempotency_key: string;
  expected_item_digest: string;
  content: string;
}

export interface PublicQueuedUserMessageV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  queue_item_id: string;
  queue_sequence: number;
  root_session_id: string;
  author_public_id: "human";
  content: string;
  content_digest: string;
  target_participants: "all" | string[];
  quote_refs: PublicQuoteReferenceV1[];
  private_context_present: boolean;
  predecessor_queue_item_id: string | null;
  admitted_authority_digest: string;
  effective_authority_digest: string;
  state: ConversationMessageQueueStateV1;
  stale_reason: ConversationMessageQueueStaleReasonV1 | null;
  admitted_at: string;
  updated_at: string;
  item_digest: string;
}

export interface ConversationMessageQueueSnapshotV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  root_session_id: string;
  current_authority_digest: string;
  max_nonterminal_items: typeof CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems;
  items: PublicQueuedUserMessageV1[];
}

export interface PublicConversationMessageQueueInvalidationV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  root_session_id: string;
  queue_item_id: string;
  state: ConversationMessageQueueStateV1;
  item_digest: string;
}

export interface PrivateConversationMessageQueueClaimOwnerV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  pid: number;
  process_start_identity: string;
  host: string;
  operation: string;
  nonce: string;
  durable_operation_id: string;
  owner_digest: string;
}

export interface PrivateConversationMessageQueueDeliveryProofV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  queue_item_id: string;
  queue_sequence: number;
  claimed_item_digest: string;
  public_event_id: string;
  public_seq: number;
  stable_operation_digest: string;
  prior_effective_authority_digest: string;
  successor_authority: ConversationMessageQueueAuthorityV1;
  private_context_binding_digest: string | null;
  private_context_disposition_digest: string | null;
  proof_digest: string;
}

export interface PrivateConversationMessageQueueContextBindingV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  root_session_id: string;
  queue_item_id: string;
  queue_sequence: number;
  owner_principal_digest: string;
  enqueue_idempotency_key_digest: string;
  source_kind: "private-file-range";
  source_record_ref: string;
  source_record_digest: string;
  source_reservation_digest: string;
  target_participant_ids: string[];
  retained_at: string;
  private_context_binding_digest: string;
}

export type PrivateConversationMessageQueueContextDispositionV1 = {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  root_session_id: string;
  queue_item_id: string;
  private_context_binding_digest: string;
  recorded_at: string;
  disposition_digest: string;
} & (
  | {
      queue_outcome: typeof CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED;
      disposition: "consumed";
      public_event_id: string;
    }
  | {
      queue_outcome: typeof CONVERSATION_MESSAGE_QUEUE_STATE.STALE;
      disposition: "released";
      public_event_id: null;
    }
);

type QueueItemWith<State extends ConversationMessageQueueStateV1> = PublicQueuedUserMessageV1 & {
  state: State;
};

export type PrivateConversationMessageQueueEventPayloadV1 =
  | {
      kind: typeof CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.ADMITTED;
      item: QueueItemWith<typeof CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED> & {
        stale_reason: null;
      };
      owner_principal_digest: string;
      admitted_authority: ConversationMessageQueueAuthorityV1;
      private_context_binding_digest: string | null;
      idempotency_key_digest: string;
      canonical_request_digest: string;
    }
  | {
      kind: typeof CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.EDITED;
      item: QueueItemWith<typeof CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED> & {
        stale_reason: null;
      };
      expected_item_digest: string;
      owner_principal_digest: string;
      private_context_binding_digest: string | null;
      idempotency_key_digest: string;
      canonical_request_digest: string;
    }
  | {
      kind: typeof CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.CLAIMED;
      item: QueueItemWith<typeof CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED> & {
        stale_reason: null;
      };
      claim_epoch: number;
      claim_owner: PrivateConversationMessageQueueClaimOwnerV1;
      private_context_binding_digest: string | null;
    }
  | {
      kind: typeof CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.DELIVERED;
      item: QueueItemWith<typeof CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED> & {
        stale_reason: null;
      };
      claim_epoch: number;
      claim_owner_digest: string;
      private_context_binding_digest: string | null;
      private_context_disposition: PrivateConversationMessageQueueContextDispositionV1 | null;
      delivery_proof: PrivateConversationMessageQueueDeliveryProofV1;
    }
  | {
      kind: typeof CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.STALE;
      item: QueueItemWith<typeof CONVERSATION_MESSAGE_QUEUE_STATE.STALE> & {
        stale_reason: ConversationMessageQueueStaleReasonV1;
      };
      prior_state:
        | typeof CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED
        | typeof CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED;
      claim_epoch: number | null;
      claim_owner_digest: string | null;
      private_context_binding_digest: string | null;
      private_context_disposition: PrivateConversationMessageQueueContextDispositionV1 | null;
    };

export interface PrivateConversationMessageQueueEventV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  root_session_id: string;
  journal_sequence: number;
  payload: PrivateConversationMessageQueueEventPayloadV1;
  previous_event_digest: string | null;
  recorded_at: string;
  event_digest: string;
}

export interface PrivateConversationMessageQueueCurrentV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  root_session_id: string;
  last_journal_sequence: number;
  head_event_digest: string;
}

export interface PrivateConversationMessageQueueIdempotencyBindingV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  mutation_kind: ConversationMessageQueueMutationKindV1;
  principal_digest: string;
  root_session_id: string;
  idempotency_key_digest: string;
  canonical_request_digest: string;
  queue_item_id: string;
  winning_event_digest: string;
  binding_digest: string;
}

export const queueAuthorityDigest = (
  value: Omit<ConversationMessageQueueAuthorityV1, "authority_digest">,
): string => digestV1("VF-CONVERSATION-MESSAGE-QUEUE-AUTHORITY\0v1\0", value);

export const queuedMessageContentDigest = (input: {
  content: string;
  target_participants: "all" | string[];
  quote_refs: PublicQuoteReferenceV1[];
  private_context_present: boolean;
}): string =>
  digestV1("VF-QUEUED-USER-MESSAGE-CONTENT\0v1\0", {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    ...input,
  });

export const queuedMessageItemDigest = (
  value: Omit<PublicQueuedUserMessageV1, "item_digest">,
): string => digestV1("VF-QUEUED-USER-MESSAGE\0v1\0", value);

export const queueIdempotencyKeyDigest = (idempotencyKey: string): string =>
  digestV1("VF-CONVERSATION-MESSAGE-QUEUE-IDEMPOTENCY\0v1\0", {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    idempotency_key: idempotencyKey,
  });

export function queuedMessageId(
  rootSessionId: string,
  queueSequence: number,
  enqueueIdempotencyKeyDigest: string,
): string {
  return `vf-queued-message-${digestHex(
    digestV1("VF-CONVERSATION-MESSAGE-QUEUE-ID\0v1\0", {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      root_session_id: rootSessionId,
      queue_sequence: queueSequence,
      enqueue_idempotency_key_digest: enqueueIdempotencyKeyDigest,
    }),
  )}`;
}

export function queuedMessageDurableOperationId(item: PublicQueuedUserMessageV1): string {
  return `vf-operation-${digestHex(
    digestV1("VF-CONVERSATION-MESSAGE-QUEUE-DURABLE-OPERATION-ID\0v1\0", {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      root_session_id: item.root_session_id,
      queue_item_id: item.queue_item_id,
      content_digest: item.content_digest,
      effective_authority_digest: item.effective_authority_digest,
    }),
  )}`;
}

export function queuedMessagePublicEventId(item: PublicQueuedUserMessageV1): string {
  const seed = digestHex(
    digestV1("VF-CONVERSATION-MESSAGE-QUEUE-PUBLIC-TRACE-EVENT\0v1\0", {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      queue_item_id: item.queue_item_id,
      content_digest: item.content_digest,
    }),
  );
  const bytes = Buffer.from(seed, "hex").subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const queueClaimOwnerDigest = (
  value: Omit<PrivateConversationMessageQueueClaimOwnerV1, "owner_digest">,
): string => digestV1("VF-CONVERSATION-MESSAGE-QUEUE-CLAIM-OWNER\0v1\0", value);

export const queuePrivateContextBindingDigest = (
  value: Omit<PrivateConversationMessageQueueContextBindingV1, "private_context_binding_digest">,
): string => digestV1("VF-CONVERSATION-MESSAGE-QUEUE-PRIVATE-CONTEXT\0v1\0", value);

export const queuePrivateContextDispositionDigest = (
  value: Omit<PrivateConversationMessageQueueContextDispositionV1, "disposition_digest">,
): string => digestV1("VF-CONVERSATION-MESSAGE-QUEUE-PRIVATE-CONTEXT-DISPOSITION\0v1\0", value);

export const queueDeliveryProofDigest = (
  value: Omit<PrivateConversationMessageQueueDeliveryProofV1, "proof_digest">,
): string => digestV1("VF-CONVERSATION-MESSAGE-QUEUE-DELIVERY-PROOF\0v1\0", value);

export const queueEventDigest = (
  value: Omit<PrivateConversationMessageQueueEventV1, "event_digest">,
): string => digestV1("VF-CONVERSATION-MESSAGE-QUEUE-EVENT\0v1\0", value);

export const queueIdempotencyFileKey = (input: {
  mutation_kind: ConversationMessageQueueMutationKindV1;
  principal_digest: string;
  root_session_id: string;
  idempotency_key_digest: string;
}): string =>
  digestV1("VF-CONVERSATION-MESSAGE-QUEUE-IDEMPOTENCY-FILE-KEY\0v1\0", {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    mutation_kind: input.mutation_kind,
    principal_digest: input.principal_digest,
    root_session_id: input.root_session_id,
    idempotency_key_digest: input.idempotency_key_digest,
  });

export const queueIdempotencyBindingDigest = (
  value: Omit<PrivateConversationMessageQueueIdempotencyBindingV1, "binding_digest">,
): string => digestV1("VF-CONVERSATION-MESSAGE-QUEUE-IDEMPOTENCY-BINDING\0v1\0", value);

export const enqueueQueueRequestDigest = (input: {
  principal_digest: string;
  root_session_id: string;
  request: Omit<EnqueueConversationUserMessageRequestV1, "idempotency_key">;
}): string =>
  digestV1("VF-CONVERSATION-MESSAGE-QUEUE-ENQUEUE-REQUEST\0v1\0", {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    ...input,
  });

export const editQueueRequestDigest = (input: {
  principal_digest: string;
  root_session_id: string;
  queue_item_id: string;
  request: Omit<EditQueuedUserMessageRequestV1, "idempotency_key">;
}): string =>
  digestV1("VF-CONVERSATION-MESSAGE-QUEUE-EDIT-REQUEST\0v1\0", {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    ...input,
  });
