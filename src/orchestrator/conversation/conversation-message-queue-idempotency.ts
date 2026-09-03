import {
  CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
} from "./conversation-message-queue-contract.js";
import type {
  PrivateConversationMessageQueueEventV1,
  PrivateConversationMessageQueueIdempotencyBindingV1,
} from "./conversation-message-queue-records.js";
import {
  editQueueRequestDigest,
  enqueueQueueRequestDigest,
} from "./conversation-message-queue-records.js";
import { ConversationMessageQueueCorruptError } from "./conversation-message-queue-validation.js";

export function assertQueueIdempotencyWinnerV1(
  binding: PrivateConversationMessageQueueIdempotencyBindingV1,
  event: PrivateConversationMessageQueueEventV1,
): void {
  const payload = event.payload;
  const matchesCommon =
    event.root_session_id === binding.root_session_id &&
    event.event_digest === binding.winning_event_digest &&
    payload.item.queue_item_id === binding.queue_item_id;
  let expectedDigest: string | null = null;
  let winnerPrincipal: string | null = null;
  let winnerKeyDigest: string | null = null;
  let winnerRequestDigest: string | null = null;
  if (
    binding.mutation_kind === CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND.ENQUEUE &&
    payload.kind === CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.ADMITTED
  ) {
    expectedDigest = enqueueQueueRequestDigest({
      principal_digest: payload.owner_principal_digest,
      root_session_id: binding.root_session_id,
      request: {
        schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
        expected_authority_digest: payload.admitted_authority.authority_digest,
        client_instance_id: payload.client_instance_id,
        client_order: payload.client_order,
        content: payload.item.content,
        target_participants: payload.item.target_participants,
        quote_refs: payload.item.quote_refs,
        private_context_present: payload.item.private_context_present,
      },
    });
    winnerPrincipal = payload.owner_principal_digest;
    winnerKeyDigest = payload.idempotency_key_digest;
    winnerRequestDigest = payload.canonical_request_digest;
  } else if (
    binding.mutation_kind === CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND.EDIT &&
    payload.kind === CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.EDITED
  ) {
    expectedDigest = editQueueRequestDigest({
      principal_digest: payload.owner_principal_digest,
      root_session_id: binding.root_session_id,
      queue_item_id: payload.item.queue_item_id,
      request: {
        schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
        expected_item_digest: payload.expected_item_digest,
        content: payload.item.content,
      },
    });
    winnerPrincipal = payload.owner_principal_digest;
    winnerKeyDigest = payload.idempotency_key_digest;
    winnerRequestDigest = payload.canonical_request_digest;
  }
  if (
    !matchesCommon ||
    expectedDigest === null ||
    winnerPrincipal !== binding.principal_digest ||
    winnerKeyDigest !== binding.idempotency_key_digest ||
    winnerRequestDigest !== binding.canonical_request_digest ||
    expectedDigest !== binding.canonical_request_digest
  )
    throw new ConversationMessageQueueCorruptError(
      "queue idempotency binding does not name its exact winning event",
    );
}
