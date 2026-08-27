import { resolveQueuedMessageEffectiveAuthorityV1 } from "./conversation-message-queue-authority.js";
import { assertNextConversationMessageClientOrder } from "./conversation-message-queue-client-order.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS,
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  type ConversationMessageQueueMutationKindV1,
  type ConversationMessageQueueTargetParticipantsV1,
} from "./conversation-message-queue-contract.js";
import type { FoldedConversationMessageQueueV1 } from "./conversation-message-queue-fold.js";
import type { ConversationMessageQueueJournalV1 } from "./conversation-message-queue-journal.js";
import {
  assertQueueMutationPrincipal,
  assertQueueMutationPrivateBinding,
  assertQueueMutationResolvedTargets,
} from "./conversation-message-queue-mutation-validation.js";
import type {
  ConversationMessageQueueAuthorityV1,
  EditQueuedUserMessageRequestV1,
  EnqueueConversationUserMessageRequestV1,
  PrivateConversationMessageQueueContextBindingV1,
  PrivateConversationMessageQueueIdempotencyBindingV1,
  PublicQueuedUserMessageV1,
} from "./conversation-message-queue-records.js";
import {
  editQueueRequestDigest,
  enqueueQueueRequestDigest,
  queueIdempotencyKeyDigest,
  queuedMessageContentDigest,
  queuedMessageId,
  queuedMessageItemDigest,
} from "./conversation-message-queue-records.js";
import {
  ConversationMessageQueueConflictError,
  ConversationMessageQueueCorruptError,
  assertConversationMessageQueueAuthorityV1,
  assertEditQueuedUserMessageRequestV1,
  assertEnqueueConversationUserMessageRequestV1,
  assertPublicQueuedUserMessageV1,
} from "./conversation-message-queue-validation.js";

export interface ConversationMessageQueueMutationResultV1 {
  item: PublicQueuedUserMessageV1;
  replayed: boolean;
}

export interface ConversationMessageQueueEnqueueInputV1 {
  principal_digest: string;
  request: EnqueueConversationUserMessageRequestV1;
  recorded_at: string;
  resolve_private_context_binding: (authority: {
    root_session_id: string;
    owner_principal_digest: string;
    enqueue_idempotency_key_digest: string;
    queue_item_id: string;
    queue_sequence: number;
    admitted_authority: ConversationMessageQueueAuthorityV1;
    target_participants: ConversationMessageQueueTargetParticipantsV1;
    private_context_present: boolean;
  }) => {
    binding: PrivateConversationMessageQueueContextBindingV1 | null;
    resolved_target_participant_ids: string[];
  };
  resolve_authority: () => ConversationMessageQueueAuthorityV1;
  validate_targets?: (
    authority: ConversationMessageQueueAuthorityV1,
    targets: ConversationMessageQueueTargetParticipantsV1,
  ) => void;
}

export interface ConversationMessageQueueEditInputV1 {
  principal_digest: string;
  queue_item_id: string;
  request: EditQueuedUserMessageRequestV1;
  recorded_at: string;
  resolve_authority: () => ConversationMessageQueueAuthorityV1;
}

function replay(
  journal: ConversationMessageQueueJournalV1,
  binding: PrivateConversationMessageQueueIdempotencyBindingV1,
  canonicalRequestDigest: string,
  lock: Parameters<Parameters<ConversationMessageQueueJournalV1["withLock"]>[1]>[0],
): ConversationMessageQueueMutationResultV1 {
  journal.assertBindingRequest(binding, canonicalRequestDigest);
  const fold = journal.recoverBinding(binding, lock);
  const item = fold.items.find((row) => row.item.queue_item_id === binding.queue_item_id)?.item;
  if (!item)
    throw new ConversationMessageQueueCorruptError("queue idempotency winner has no folded item");
  return { item: structuredClone(item), replayed: true };
}

function bindingDraft(input: {
  mutationKind: ConversationMessageQueueMutationKindV1;
  principalDigest: string;
  rootSessionId: string;
  idempotencyKeyDigest: string;
  canonicalRequestDigest: string;
  itemId: string;
  eventDigest: string;
}): Omit<PrivateConversationMessageQueueIdempotencyBindingV1, "binding_digest"> {
  return {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    mutation_kind: input.mutationKind,
    principal_digest: input.principalDigest,
    root_session_id: input.rootSessionId,
    idempotency_key_digest: input.idempotencyKeyDigest,
    canonical_request_digest: input.canonicalRequestDigest,
    queue_item_id: input.itemId,
    winning_event_digest: input.eventDigest,
  };
}
function findBound(
  journal: ConversationMessageQueueJournalV1,
  input: {
    mutationKind: ConversationMessageQueueMutationKindV1;
    principalDigest: string;
    idempotencyKeyDigest: string;
  },
) {
  return journal.readBinding({
    mutation_kind: input.mutationKind,
    principal_digest: input.principalDigest,
    root_session_id: journal.rootSessionId,
    idempotency_key_digest: input.idempotencyKeyDigest,
  });
}

export function enqueueConversationUserMessageV1(
  journal: ConversationMessageQueueJournalV1,
  input: ConversationMessageQueueEnqueueInputV1,
): ConversationMessageQueueMutationResultV1 {
  assertQueueMutationPrincipal(input.principal_digest);
  assertEnqueueConversationUserMessageRequestV1(input.request);
  const { idempotency_key: _key, ...canonicalRequest } = structuredClone(input.request);
  const canonicalDigest = enqueueQueueRequestDigest({
    principal_digest: input.principal_digest,
    root_session_id: journal.rootSessionId,
    request: canonicalRequest,
  });
  const keyDigest = queueIdempotencyKeyDigest(input.request.idempotency_key);
  return journal.withLock(`message-queue-enqueue:${keyDigest}`, (lock) => {
    const bound = findBound(journal, {
      mutationKind: CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND.ENQUEUE,
      principalDigest: input.principal_digest,
      idempotencyKeyDigest: keyDigest,
    });
    if (bound) return replay(journal, bound, canonicalDigest, lock);
    const fold = journal.readFold();
    assertNextConversationMessageClientOrder({
      fold,
      principalDigest: input.principal_digest,
      request: input.request,
    });
    if (
      fold.items.filter(
        (row) =>
          row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
          row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
      ).length >= CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems
    )
      throw new ConversationMessageQueueConflictError(
        CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
        "conversation message queue is full",
        { root_session_id: journal.rootSessionId },
      );
    const authority = input.resolve_authority();
    assertConversationMessageQueueAuthorityV1(authority);
    if (
      authority.root_session_id !== journal.rootSessionId ||
      authority.authority_digest !== input.request.expected_authority_digest
    )
      throw new ConversationMessageQueueConflictError(
        CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE,
        "message admission authority changed",
      );
    input.validate_targets?.(authority, input.request.target_participants);
    const tail = fold.items
      .filter(
        (row) =>
          row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
          row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
      )
      .at(-1);
    const queueSequence = (fold.items.at(-1)?.item.queue_sequence ?? 0) + 1;
    const itemId = queuedMessageId(journal.rootSessionId, queueSequence, keyDigest);
    const privateContextAuthority = input.resolve_private_context_binding({
      root_session_id: journal.rootSessionId,
      owner_principal_digest: input.principal_digest,
      enqueue_idempotency_key_digest: keyDigest,
      queue_item_id: itemId,
      queue_sequence: queueSequence,
      admitted_authority: structuredClone(authority),
      target_participants: structuredClone(input.request.target_participants),
      private_context_present: input.request.private_context_present,
    });
    const privateContextBinding = privateContextAuthority.binding;
    assertQueueMutationPrivateBinding(input.request.private_context_present, privateContextBinding);
    assertQueueMutationResolvedTargets(
      input.request.target_participants,
      privateContextAuthority.resolved_target_participant_ids,
      privateContextBinding,
    );
    if (
      privateContextBinding &&
      (privateContextBinding.root_session_id !== journal.rootSessionId ||
        privateContextBinding.queue_item_id !== itemId ||
        privateContextBinding.queue_sequence !== queueSequence ||
        privateContextBinding.owner_principal_digest !== input.principal_digest ||
        privateContextBinding.enqueue_idempotency_key_digest !== keyDigest ||
        JSON.stringify(privateContextBinding.target_participant_ids) !==
          JSON.stringify(privateContextAuthority.resolved_target_participant_ids))
    )
      throw new Error("queue private context binding does not match admission authority");
    if (privateContextBinding) journal.privateObjects.writeBinding(privateContextBinding, lock);
    const privateContextBindingDigest =
      privateContextBinding?.private_context_binding_digest ?? null;
    const contentInput = {
      content: input.request.content,
      target_participants: structuredClone(input.request.target_participants),
      quote_refs: structuredClone(input.request.quote_refs),
      private_context_present: input.request.private_context_present,
    };
    const itemPreimage = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      queue_item_id: itemId,
      queue_sequence: queueSequence,
      root_session_id: journal.rootSessionId,
      author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
      ...contentInput,
      content_digest: queuedMessageContentDigest(contentInput),
      predecessor_queue_item_id: tail?.item.queue_item_id ?? null,
      admitted_authority_digest: authority.authority_digest,
      effective_authority_digest: authority.authority_digest,
      state: CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED,
      stale_reason: null,
      admitted_at: input.recorded_at,
      updated_at: input.recorded_at,
    };
    const item = { ...itemPreimage, item_digest: queuedMessageItemDigest(itemPreimage) };
    assertPublicQueuedUserMessageV1(item);
    const event = journal.materializeEvent(
      {
        kind: CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.ADMITTED,
        item,
        owner_principal_digest: input.principal_digest,
        admitted_authority: structuredClone(authority),
        client_instance_id: input.request.client_instance_id,
        client_order: input.request.client_order,
        private_context_binding_digest: privateContextBindingDigest,
        idempotency_key_digest: keyDigest,
        canonical_request_digest: canonicalDigest,
      },
      input.recorded_at,
    );
    journal.commitIdempotent(
      bindingDraft({
        mutationKind: CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND.ENQUEUE,
        principalDigest: input.principal_digest,
        rootSessionId: journal.rootSessionId,
        idempotencyKeyDigest: keyDigest,
        canonicalRequestDigest: canonicalDigest,
        itemId,
        eventDigest: event.event_digest,
      }),
      event,
      lock,
    );
    return { item: structuredClone(item), replayed: false };
  });
}

export function editQueuedConversationUserMessageV1(
  journal: ConversationMessageQueueJournalV1,
  input: ConversationMessageQueueEditInputV1,
): ConversationMessageQueueMutationResultV1 {
  assertQueueMutationPrincipal(input.principal_digest);
  assertEditQueuedUserMessageRequestV1(input.request);
  const { idempotency_key: _key, ...canonicalRequest } = structuredClone(input.request);
  const canonicalDigest = editQueueRequestDigest({
    principal_digest: input.principal_digest,
    root_session_id: journal.rootSessionId,
    queue_item_id: input.queue_item_id,
    request: canonicalRequest,
  });
  const keyDigest = queueIdempotencyKeyDigest(input.request.idempotency_key);
  return journal.withLock(`message-queue-edit:${keyDigest}`, (lock) => {
    const bound = findBound(journal, {
      mutationKind: CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND.EDIT,
      principalDigest: input.principal_digest,
      idempotencyKeyDigest: keyDigest,
    });
    if (bound) return replay(journal, bound, canonicalDigest, lock);
    const fold: FoldedConversationMessageQueueV1 = journal.readFold();
    const row = fold.items.find(
      (candidate) => candidate.item.queue_item_id === input.queue_item_id,
    );
    const latestOwn = fold.items
      .filter(
        (candidate) =>
          candidate.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED &&
          candidate.owner_principal_digest === input.principal_digest,
      )
      .at(-1);
    if (
      !row ||
      row.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
      row.owner_principal_digest !== input.principal_digest ||
      latestOwn?.item.queue_item_id !== input.queue_item_id ||
      row.item.item_digest !== input.request.expected_item_digest
    )
      throw new ConversationMessageQueueConflictError(
        CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE,
        "queued message changed before edit commit",
      );
    const currentAuthority = input.resolve_authority();
    assertConversationMessageQueueAuthorityV1(currentAuthority);
    const authorityResolution =
      currentAuthority.authority_digest === row.admitted_authority.authority_digest
        ? { status: CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS.CURRENT }
        : resolveQueuedMessageEffectiveAuthorityV1(row, fold.items, currentAuthority);
    if (authorityResolution.status === CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS.STALE)
      throw new ConversationMessageQueueConflictError(
        CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE,
        "queued message authority changed before edit commit",
      );
    const contentDigest = queuedMessageContentDigest({
      content: input.request.content,
      target_participants: row.item.target_participants,
      quote_refs: row.item.quote_refs,
      private_context_present: row.item.private_context_present,
    });
    const { item_digest: _digest, ...prior } = row.item;
    const itemPreimage = {
      ...prior,
      content: input.request.content,
      content_digest: contentDigest,
      updated_at: input.recorded_at,
    };
    const item = { ...itemPreimage, item_digest: queuedMessageItemDigest(itemPreimage) };
    assertPublicQueuedUserMessageV1(item);
    const queuedItem = item as PublicQueuedUserMessageV1 & {
      state: typeof CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED;
      stale_reason: null;
    };
    const event = journal.materializeEvent(
      {
        kind: CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.EDITED,
        item: queuedItem,
        expected_item_digest: input.request.expected_item_digest,
        owner_principal_digest: input.principal_digest,
        private_context_binding_digest: row.private_context_binding_digest,
        idempotency_key_digest: keyDigest,
        canonical_request_digest: canonicalDigest,
      },
      input.recorded_at,
    );
    journal.commitIdempotent(
      bindingDraft({
        mutationKind: CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND.EDIT,
        principalDigest: input.principal_digest,
        rootSessionId: journal.rootSessionId,
        idempotencyKeyDigest: keyDigest,
        canonicalRequestDigest: canonicalDigest,
        itemId: item.queue_item_id,
        eventDigest: event.event_digest,
      }),
      event,
      lock,
    );
    return { item: structuredClone(queuedItem), replayed: false };
  });
}
