import { canonicalJsonBytes } from "../../durability/index.js";
import {
  CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "./conversation-message-queue-contract.js";
import { assertConversationMessageQueueEventV1 } from "./conversation-message-queue-event-validation.js";
import type {
  ConversationMessageQueueAuthorityV1,
  PrivateConversationMessageQueueClaimOwnerV1,
  PrivateConversationMessageQueueContextDispositionV1,
  PrivateConversationMessageQueueDeliveryProofV1,
  PrivateConversationMessageQueueEventPayloadV1,
  PrivateConversationMessageQueueEventV1,
  PublicQueuedUserMessageV1,
} from "./conversation-message-queue-records.js";
import {
  queuedMessageDurableOperationId,
  queuedMessageId,
  queuedMessagePublicEventId,
} from "./conversation-message-queue-records.js";
import { ConversationMessageQueueCorruptError } from "./conversation-message-queue-validation.js";

export interface FoldedConversationMessageQueueItemV1 {
  item: PublicQueuedUserMessageV1;
  owner_principal_digest: string;
  admitted_authority: ConversationMessageQueueAuthorityV1;
  client_instance_id: string;
  client_order: number;
  enqueue_idempotency_key_digest: string;
  private_context_binding_digest: string | null;
  claim_epoch: number | null;
  claim_owner: PrivateConversationMessageQueueClaimOwnerV1 | null;
  delivery_proof: PrivateConversationMessageQueueDeliveryProofV1 | null;
  private_context_disposition: PrivateConversationMessageQueueContextDispositionV1 | null;
}

export interface FoldedConversationMessageQueueV1 {
  root_session_id: string;
  events: PrivateConversationMessageQueueEventV1[];
  items: FoldedConversationMessageQueueItemV1[];
}

const same = (left: unknown, right: unknown): boolean =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

function immutableItem(item: PublicQueuedUserMessageV1) {
  return {
    schema_version: item.schema_version,
    queue_item_id: item.queue_item_id,
    queue_sequence: item.queue_sequence,
    root_session_id: item.root_session_id,
    author_public_id: item.author_public_id,
    target_participants: item.target_participants,
    quote_refs: item.quote_refs,
    private_context_present: item.private_context_present,
    predecessor_queue_item_id: item.predecessor_queue_item_id,
    admitted_authority_digest: item.admitted_authority_digest,
    admitted_at: item.admitted_at,
  };
}

function fail(message: string): never {
  throw new ConversationMessageQueueCorruptError(message);
}

function priorItem(
  items: Map<string, FoldedConversationMessageQueueItemV1>,
  event: PrivateConversationMessageQueueEventV1,
): FoldedConversationMessageQueueItemV1 {
  return (
    items.get(event.payload.item.queue_item_id) ?? fail("queue transition has no admitted item")
  );
}

function assertPrivateBinding(
  folded: FoldedConversationMessageQueueItemV1,
  payload: PrivateConversationMessageQueueEventPayloadV1,
): void {
  if (
    folded.private_context_binding_digest !== payload.private_context_binding_digest ||
    folded.item.private_context_present !== (payload.private_context_binding_digest !== null)
  )
    fail("queue private context binding changed");
}

function foldAdmitted(
  event: PrivateConversationMessageQueueEventV1,
  items: Map<string, FoldedConversationMessageQueueItemV1>,
): void {
  const payload = event.payload;
  if (payload.kind !== CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.ADMITTED) return;
  const ordered = [...items.values()].sort((a, b) => a.item.queue_sequence - b.item.queue_sequence);
  const sequence = (ordered.at(-1)?.item.queue_sequence ?? 0) + 1;
  const predecessor = ordered
    .filter(
      (row) =>
        row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
        row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
    )
    .at(-1);
  const priorClientOrder = ordered
    .filter(
      (row) =>
        row.owner_principal_digest === payload.owner_principal_digest &&
        row.client_instance_id === payload.client_instance_id,
    )
    .at(-1)?.client_order;
  if (
    items.has(payload.item.queue_item_id) ||
    payload.item.queue_sequence !== sequence ||
    payload.item.queue_item_id !==
      queuedMessageId(payload.item.root_session_id, sequence, payload.idempotency_key_digest) ||
    payload.item.predecessor_queue_item_id !== (predecessor?.item.queue_item_id ?? null) ||
    payload.admitted_authority.root_session_id !== payload.item.root_session_id ||
    payload.item.admitted_authority_digest !== payload.admitted_authority.authority_digest ||
    payload.item.effective_authority_digest !== payload.admitted_authority.authority_digest ||
    payload.item.private_context_present !== (payload.private_context_binding_digest !== null) ||
    payload.item.admitted_at !== event.recorded_at ||
    payload.client_order !== (priorClientOrder ?? 0) + 1
  )
    fail("queue admission authority changed");
  items.set(payload.item.queue_item_id, {
    item: structuredClone(payload.item),
    owner_principal_digest: payload.owner_principal_digest,
    admitted_authority: structuredClone(payload.admitted_authority),
    client_instance_id: payload.client_instance_id,
    client_order: payload.client_order,
    enqueue_idempotency_key_digest: payload.idempotency_key_digest,
    private_context_binding_digest: payload.private_context_binding_digest,
    claim_epoch: null,
    claim_owner: null,
    delivery_proof: null,
    private_context_disposition: null,
  });
}

function foldEdited(
  event: PrivateConversationMessageQueueEventV1,
  items: Map<string, FoldedConversationMessageQueueItemV1>,
): void {
  const payload = event.payload;
  if (payload.kind !== CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.EDITED) return;
  const prior = priorItem(items, event);
  const latestOwn = [...items.values()]
    .filter(
      (row) =>
        row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED &&
        row.owner_principal_digest === payload.owner_principal_digest,
    )
    .sort((a, b) => b.item.queue_sequence - a.item.queue_sequence)[0];
  assertPrivateBinding(prior, payload);
  if (
    prior.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
    latestOwn?.item.queue_item_id !== prior.item.queue_item_id ||
    payload.expected_item_digest !== prior.item.item_digest ||
    payload.owner_principal_digest !== prior.owner_principal_digest ||
    !same(immutableItem(payload.item), immutableItem(prior.item)) ||
    payload.item.effective_authority_digest !== prior.item.effective_authority_digest
  )
    fail("queue edit authority changed");
  prior.item = structuredClone(payload.item);
}

function foldClaimed(
  event: PrivateConversationMessageQueueEventV1,
  items: Map<string, FoldedConversationMessageQueueItemV1>,
): void {
  const payload = event.payload;
  if (payload.kind !== CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.CLAIMED) return;
  const prior = priorItem(items, event);
  const oldest = [...items.values()]
    .filter(
      (row) =>
        row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
        row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
    )
    .sort((a, b) => a.item.queue_sequence - b.item.queue_sequence)[0];
  assertPrivateBinding(prior, payload);
  if (
    oldest?.item.queue_item_id !== prior.item.queue_item_id ||
    (prior.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED &&
      prior.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED) ||
    payload.claim_epoch !== (prior.claim_epoch ?? 0) + 1 ||
    !same(immutableItem(payload.item), immutableItem(prior.item)) ||
    payload.item.content !== prior.item.content ||
    payload.item.content_digest !== prior.item.content_digest ||
    (prior.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED &&
      payload.item.effective_authority_digest !== prior.item.effective_authority_digest) ||
    payload.claim_owner.durable_operation_id !== queuedMessageDurableOperationId(payload.item)
  )
    fail("queue claim authority changed");
  prior.item = structuredClone(payload.item);
  prior.claim_epoch = payload.claim_epoch;
  prior.claim_owner = structuredClone(payload.claim_owner);
}

function foldTerminal(
  event: PrivateConversationMessageQueueEventV1,
  items: Map<string, FoldedConversationMessageQueueItemV1>,
): void {
  const payload = event.payload;
  if (
    payload.kind !== CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.DELIVERED &&
    payload.kind !== CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.STALE
  )
    return;
  const prior = priorItem(items, event);
  assertPrivateBinding(prior, payload);
  if (
    !same(immutableItem(payload.item), immutableItem(prior.item)) ||
    payload.item.content !== prior.item.content ||
    payload.item.content_digest !== prior.item.content_digest ||
    payload.item.effective_authority_digest !== prior.item.effective_authority_digest
  )
    fail("queue terminal item authority changed");
  if (payload.kind === CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.DELIVERED) {
    const proof = payload.delivery_proof;
    if (
      prior.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED ||
      payload.claim_epoch !== prior.claim_epoch ||
      payload.claim_owner_digest !== prior.claim_owner?.owner_digest ||
      proof.queue_item_id !== prior.item.queue_item_id ||
      proof.queue_sequence !== prior.item.queue_sequence ||
      proof.claimed_item_digest !== prior.item.item_digest ||
      proof.public_event_id !== queuedMessagePublicEventId(prior.item) ||
      proof.prior_effective_authority_digest !== prior.item.effective_authority_digest ||
      proof.successor_authority.root_session_id !== prior.item.root_session_id ||
      proof.private_context_binding_digest !== prior.private_context_binding_digest ||
      (payload.private_context_disposition?.disposition_digest ?? null) !==
        proof.private_context_disposition_digest ||
      (payload.private_context_disposition !== null &&
        payload.private_context_disposition.public_event_id !== proof.public_event_id)
    )
      fail("queue delivery proof changed");
    prior.delivery_proof = structuredClone(proof);
  } else if (
    payload.prior_state !== prior.item.state ||
    payload.claim_epoch !== prior.claim_epoch ||
    payload.claim_owner_digest !== (prior.claim_owner?.owner_digest ?? null)
  )
    fail("queue stale authority changed");
  const disposition = payload.private_context_disposition;
  if (
    prior.item.private_context_present !== (disposition !== null) ||
    (disposition &&
      (disposition.root_session_id !== prior.item.root_session_id ||
        disposition.queue_item_id !== prior.item.queue_item_id ||
        disposition.private_context_binding_digest !== prior.private_context_binding_digest ||
        disposition.queue_outcome !== payload.kind))
  )
    fail("queue terminal private context disposition changed");
  prior.private_context_disposition = disposition ? structuredClone(disposition) : null;
  prior.item = structuredClone(payload.item);
}

export function foldConversationMessageQueueV1(
  rootSessionId: string,
  events: readonly PrivateConversationMessageQueueEventV1[],
): FoldedConversationMessageQueueV1 {
  const items = new Map<string, FoldedConversationMessageQueueItemV1>();
  let priorDigest: string | null = null;
  events.forEach((event, journalSequence) => {
    assertConversationMessageQueueEventV1(event);
    if (
      event.root_session_id !== rootSessionId ||
      event.journal_sequence !== journalSequence ||
      event.previous_event_digest !== priorDigest
    )
      fail("queue event ancestry is not dense");
    foldAdmitted(event, items);
    foldEdited(event, items);
    foldClaimed(event, items);
    foldTerminal(event, items);
    priorDigest = event.event_digest;
  });
  return {
    root_session_id: rootSessionId,
    events: structuredClone([...events]),
    items: [...items.values()]
      .sort((left, right) => left.item.queue_sequence - right.item.queue_sequence)
      .map((item) => structuredClone(item)),
  };
}
