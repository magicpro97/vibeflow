import type { ProcessLock } from "../../durability/index.js";
import { digestHex } from "../../durability/index.js";
import type { RevalidatedConversationMessageQueuePrivateContextV1 } from "./conversation-message-queue-private-store.js";
import type {
  PrivateConversationMessageQueueContextBindingV1,
  PrivateConversationMessageQueueContextDispositionV1,
} from "./conversation-message-queue-records.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_CONSUMER_KIND,
  type ConversationPrivateContextQueueOutcomeV1,
} from "./conversation-private-context-broker-contract.js";
import { ConversationPrivateContextDiscardMutationsV1 } from "./conversation-private-context-broker-discard.js";
import {
  type ConversationDraftTransferAllocationV1,
  ConversationPrivateContextDraftTransferV1,
} from "./conversation-private-context-broker-draft-transfer.js";
import {
  ConversationPrivateContextQueueMutationsV1,
  type PreparedConversationPrivateContextAdmissionV1,
} from "./conversation-private-context-broker-queue.js";
import {
  createIdempotencyKeyDigest,
  draftStageRecordDigest,
  queueIdempotencyKeyDigest,
} from "./conversation-private-context-broker-records.js";
import type {
  DiscardConversationDraftPrivateContextRequestV1,
  DiscardConversationMessagePrivateContextRequestV1,
  PrivateConversationDraftContextStageV1,
  PrivateConversationMessageContextStageV1,
  PublicConversationPrivateContextPresenceV1,
} from "./conversation-private-context-broker-types.js";
import type {
  PrivateFileRangeHandoffBindingV1,
  PrivateFileRangeStagingStoreV1,
} from "./private-file-range-staging-store.js";

export interface ConversationPrivateContextBrokerMutationHostV1 {
  messages: string;
  drafts: string;
  discards: string;
  sources: PrivateFileRangeStagingStoreV1;
  now(): string;
  withLock<T>(operation: string, run: (lock: ProcessLock) => T): T;
  messageDirectory(principal: string, root: string, keyDigest: string, create?: boolean): string;
  draftDirectory(principal: string, keyDigest: string, create?: boolean): string;
  readMessage(path: string): PrivateConversationMessageContextStageV1 | null;
  readDraft(path: string): PrivateConversationDraftContextStageV1 | null;
  publish(
    path: string,
    prior: unknown | null,
    next: { record_digest: string },
    lock: ProcessLock,
  ): void;
  sourceBinding(stage: {
    source_record_ref: string;
    source_record_digest: string;
  }): PrivateFileRangeHandoffBindingV1;
  hasDraftCreateBinding(principalDigest: string, createIdempotencyKey: string): boolean;
}

function transitionDraft(
  current: PrivateConversationDraftContextStageV1,
  patch: Pick<
    PrivateConversationDraftContextStageV1,
    | "stage_state"
    | "allocated_root_session_id"
    | "allocated_conversation_id"
    | "allocated_revision_id"
    | "initial_turn_context_digest"
  >,
  at: string,
): PrivateConversationDraftContextStageV1 {
  const { record_digest: _digest, ...prior } = current;
  const preimage = {
    ...prior,
    ...patch,
    stage_sequence: current.stage_sequence + 1,
    previous_record_digest: current.record_digest,
    updated_at: at,
  };
  return { ...preimage, record_digest: draftStageRecordDigest(preimage) };
}

export class ConversationPrivateContextBrokerMutationsV1 {
  private readonly queue: ConversationPrivateContextQueueMutationsV1;
  private readonly draftTransfer: ConversationPrivateContextDraftTransferV1;
  private readonly discard: ConversationPrivateContextDiscardMutationsV1;

  constructor(private readonly host: ConversationPrivateContextBrokerMutationHostV1) {
    this.queue = new ConversationPrivateContextQueueMutationsV1(host);
    this.draftTransfer = new ConversationPrivateContextDraftTransferV1(host);
    this.discard = new ConversationPrivateContextDiscardMutationsV1(host);
  }

  discardMessage(input: {
    root_session_id: string;
    principal_digest: string;
    request: DiscardConversationMessagePrivateContextRequestV1;
  }): { presence: PublicConversationPrivateContextPresenceV1; replayed: boolean } {
    return this.discard.message(input);
  }

  discardDraft(input: {
    principal_digest: string;
    request: DiscardConversationDraftPrivateContextRequestV1;
  }): { presence: PublicConversationPrivateContextPresenceV1; replayed: boolean } {
    return this.discard.draft(input);
  }

  prepareAdmission(input: {
    root_session_id: string;
    principal_digest: string;
    enqueue_idempotency_key: string;
    private_context_present: boolean;
    staged_authority_digest: string;
    queue_item_id: string;
    queue_sequence: number;
    target_participant_ids: string[];
  }): PreparedConversationPrivateContextAdmissionV1 {
    return this.queue.prepareAdmission({
      root_session_id: input.root_session_id,
      principal_digest: input.principal_digest,
      enqueue_idempotency_key_digest: queueIdempotencyKeyDigest(input.enqueue_idempotency_key),
      private_context_present: input.private_context_present,
      staged_authority_digest: input.staged_authority_digest,
      queue_item_id: input.queue_item_id,
      queue_sequence: input.queue_sequence,
      target_participant_ids: [...input.target_participant_ids],
    });
  }

  validateQueueBinding(
    binding: PrivateConversationMessageQueueContextBindingV1,
  ): RevalidatedConversationMessageQueuePrivateContextV1 | null {
    return this.queue.validateQueueBinding(binding);
  }

  queueSource(binding: PrivateConversationMessageQueueContextBindingV1) {
    return this.queue.source(binding);
  }

  queueDisposition(
    binding: PrivateConversationMessageQueueContextBindingV1,
    outcome: ConversationPrivateContextQueueOutcomeV1,
    publicEventId: string | null,
    recordedAt: string,
  ): PrivateConversationMessageQueueContextDispositionV1 {
    return this.queue.disposition(binding, outcome, publicEventId, recordedAt);
  }

  applyQueueDisposition(
    binding: PrivateConversationMessageQueueContextBindingV1,
    disposition: PrivateConversationMessageQueueContextDispositionV1,
  ): void {
    this.queue.applyDisposition(binding, disposition);
  }

  prepareDraftTransfer<T>(input: {
    principal_digest: string;
    create_idempotency_key: string;
    prepare_create(): {
      allocation: ConversationDraftTransferAllocationV1;
      prepared: T;
    };
  }) {
    return this.draftTransfer.inspect(input);
  }

  transferDraftContext(input: {
    principal_digest: string;
    create_idempotency_key: string;
    expected_stage_record_digest: string;
    allocation: ConversationDraftTransferAllocationV1;
    initial_context_record_digest: string;
    assert_create(): ConversationDraftTransferAllocationV1;
  }): void {
    this.draftTransfer.transfer(input);
  }

  consumeDraftTransfer(input: {
    principal_digest: string;
    create_idempotency_key: string;
    conversation_id: string;
    initial_context_record_digest: string;
  }): void {
    const selected = createIdempotencyKeyDigest(input.create_idempotency_key);
    this.host.withLock(`draft-private-context-consume:${digestHex(selected)}`, (lock) => {
      const path = this.host.draftDirectory(input.principal_digest, selected);
      const current = this.host.readDraft(path);
      if (
        !current ||
        current.allocated_conversation_id !== input.conversation_id ||
        current.initial_turn_context_digest !== input.initial_context_record_digest
      )
        throw new Error("draft transfer authority changed");
      if (current.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.CONSUMED) return;
      if (current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.TRANSFER_OWNED)
        throw new Error("draft transfer is not owned");
      const at = this.host.now();
      this.host.sources.consume(
        this.host.sourceBinding(current),
        `${CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND.CONVERSATION_CREATE}:${input.conversation_id}`,
        `${CONVERSATION_PRIVATE_CONTEXT_SOURCE_CONSUMER_KIND.CONVERSATION}:${input.conversation_id}:create`,
        at,
      );
      const next = transitionDraft(
        current,
        {
          stage_state: CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.CONSUMED,
          allocated_root_session_id: current.allocated_root_session_id,
          allocated_conversation_id: current.allocated_conversation_id,
          allocated_revision_id: current.allocated_revision_id,
          initial_turn_context_digest: current.initial_turn_context_digest,
        },
        at,
      );
      this.host.publish(path, current, next, lock);
    });
  }

  withDraftAbsent<T>(input: {
    principal_digest: string;
    create_idempotency_key: string;
    prepare_create(): T;
  }): T {
    return this.draftTransfer.withAbsent(input);
  }
}
