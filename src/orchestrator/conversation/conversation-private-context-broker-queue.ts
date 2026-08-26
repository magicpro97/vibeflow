import type { ProcessLock } from "../../durability/index.js";
import {
  materializeConversationMessageQueueContextBindingV1,
  materializeQueuePrivateContextDispositionV1,
} from "./conversation-message-queue-authority.js";
import type { RevalidatedConversationMessageQueuePrivateContextV1 } from "./conversation-message-queue-private-store.js";
import {
  assertQueueContextBindingV1,
  assertQueueContextDispositionV1,
} from "./conversation-message-queue-private-validation.js";
import type {
  PrivateConversationMessageQueueContextBindingV1,
  PrivateConversationMessageQueueContextDispositionV1,
} from "./conversation-message-queue-records.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS,
  CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION,
  CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_CONSUMER_KIND,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATE,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND,
  type ConversationPrivateContextQueueOutcomeV1,
} from "./conversation-private-context-broker-contract.js";
import { messageStageRecordDigest } from "./conversation-private-context-broker-records.js";
import type { PrivateConversationMessageContextStageV1 } from "./conversation-private-context-broker-types.js";
import { ConversationPrivateContextBrokerConflictError } from "./conversation-private-context-broker-validation.js";
import type {
  PrivateFileRangeHandoffBindingV1,
  PrivateFileRangeStagingStoreV1,
  ResolvedPrivateFileRangeV1,
} from "./private-file-range-staging-store.js";

export interface ConversationPrivateContextQueueHostV1 {
  sources: PrivateFileRangeStagingStoreV1;
  now(): string;
  withLock<T>(operation: string, run: (lock: ProcessLock) => T): T;
  messageDirectory(principal: string, root: string, keyDigest: string): string;
  readMessage(path: string): PrivateConversationMessageContextStageV1 | null;
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
}

export interface PreparedConversationPrivateContextAdmissionV1 {
  binding: PrivateConversationMessageQueueContextBindingV1 | null;
  commit(): void;
  /** Caller must first prove that neither a queue event nor idempotency winner exists. */
  rollbackProvenAbsent(): void;
}

const reservationKey = (queueItemId: string) =>
  `${CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND.MESSAGE_QUEUE}:${queueItemId}`;

function transition(
  current: PrivateConversationMessageContextStageV1,
  patch: Pick<
    PrivateConversationMessageContextStageV1,
    "stage_state" | "queue_item_id" | "private_context_binding_digest"
  >,
  at: string,
): PrivateConversationMessageContextStageV1 {
  const { record_digest: _digest, ...prior } = current;
  const preimage = {
    ...prior,
    ...patch,
    stage_sequence: current.stage_sequence + 1,
    previous_record_digest: current.record_digest,
    updated_at: at,
  };
  return { ...preimage, record_digest: messageStageRecordDigest(preimage) };
}

export class ConversationPrivateContextQueueMutationsV1 {
  constructor(private readonly host: ConversationPrivateContextQueueHostV1) {}

  prepareAdmission(input: {
    root_session_id: string;
    principal_digest: string;
    enqueue_idempotency_key_digest: string;
    private_context_present: boolean;
    staged_authority_digest: string;
    queue_item_id: string;
    queue_sequence: number;
    target_participant_ids: string[];
  }): PreparedConversationPrivateContextAdmissionV1 {
    return this.host.withLock(`message-private-context-reserve:${input.queue_item_id}`, (lock) => {
      const path = this.host.messageDirectory(
        input.principal_digest,
        input.root_session_id,
        input.enqueue_idempotency_key_digest,
      );
      const current = this.host.readMessage(path);
      if (!input.private_context_present) {
        if (
          current &&
          current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.DISCARDED
        )
          throw new ConversationPrivateContextBrokerConflictError(
            CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
            "private context authority must be selected or explicitly discarded",
            current.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE ||
              current.stage_state ===
                CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.ADMISSION_OWNED,
            current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE,
          );
        return {
          binding: null,
          commit: () => undefined,
          rollbackProvenAbsent: () => undefined,
        };
      }
      if (!current || current.staged_authority_digest !== input.staged_authority_digest)
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "private context authority changed",
          !!current,
          false,
        );
      const key = reservationKey(input.queue_item_id);
      const retainedAt =
        current.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE
          ? this.host.now()
          : current.updated_at;
      const source = this.host.sourceBinding(current);
      if (current.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE) {
        const projectedTerminalFrameCount =
          current.stage_sequence +
          1 +
          CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.queueAdmissionRequiredFrameHeadroom;
        if (
          projectedTerminalFrameCount > CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxStageRecords
        )
          throw new ConversationPrivateContextBrokerConflictError(
            CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.RATE_LIMITED,
            "private context retry budget exhausted",
            true,
          );
        this.host.sources.reserve(source, key, retainedAt);
      }
      const frame = this.host.sources.readFrames(source.handoff_id).at(-1);
      if (
        frame?.state !== CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATE.RESERVED ||
        frame.reservation_key !== key
      )
        throw new Error("queue private context reservation was not established");
      const binding = materializeConversationMessageQueueContextBindingV1({
        root_session_id: input.root_session_id,
        queue_item_id: input.queue_item_id,
        queue_sequence: input.queue_sequence,
        owner_principal_digest: input.principal_digest,
        enqueue_idempotency_key_digest: input.enqueue_idempotency_key_digest,
        source_kind: CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND.PRIVATE_FILE_RANGE,
        source_record_ref: current.source_record_ref,
        source_record_digest: current.source_record_digest,
        source_reservation_digest: frame.frame_digest,
        target_participant_ids: [...input.target_participant_ids],
        retained_at: retainedAt,
      });
      if (current.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE) {
        this.host.publish(
          path,
          current,
          transition(
            current,
            {
              stage_state: CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.ADMISSION_OWNED,
              queue_item_id: input.queue_item_id,
              private_context_binding_digest: binding.private_context_binding_digest,
            },
            retainedAt,
          ),
          lock,
        );
      } else if (
        current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.ADMISSION_OWNED ||
        current.queue_item_id !== input.queue_item_id ||
        current.private_context_binding_digest !== binding.private_context_binding_digest
      ) {
        throw new ConversationPrivateContextBrokerConflictError(
          CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
          "private context is owned by another queue item",
          true,
          true,
        );
      }
      return {
        binding,
        commit: () => {
          this.validateQueueBinding(binding);
        },
        rollbackProvenAbsent: () => this.rollback(binding),
      };
    });
  }

  validateQueueBinding(
    binding: PrivateConversationMessageQueueContextBindingV1,
  ): RevalidatedConversationMessageQueuePrivateContextV1 | null {
    try {
      assertQueueContextBindingV1(binding);
      const current = this.host.readMessage(
        this.host.messageDirectory(
          binding.owner_principal_digest,
          binding.root_session_id,
          binding.enqueue_idempotency_key_digest,
        ),
      );
      if (
        !current ||
        (current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.ADMISSION_OWNED &&
          current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.CONSUMED &&
          current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.RELEASED) ||
        current.queue_item_id !== binding.queue_item_id ||
        current.private_context_binding_digest !== binding.private_context_binding_digest ||
        current.source_record_ref !== binding.source_record_ref ||
        current.source_record_digest !== binding.source_record_digest
      )
        return null;
      const source = this.host.sourceBinding(current);
      const reserved = this.host.sources
        .readFrames(source.handoff_id)
        .find((frame) => frame.frame_digest === binding.source_reservation_digest);
      if (
        reserved?.state !== CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATE.RESERVED ||
        reserved.reservation_key !== reservationKey(binding.queue_item_id)
      )
        return null;
      this.host.sources.content(source);
      return {
        source_record_digest: current.source_record_digest,
        source_reservation_digest: reserved.frame_digest,
        target_participant_ids: [...binding.target_participant_ids],
      };
    } catch {
      return null;
    }
  }

  source(binding: PrivateConversationMessageQueueContextBindingV1): {
    handoff: PrivateFileRangeHandoffBindingV1;
    file_range: ResolvedPrivateFileRangeV1;
  } {
    if (!this.validateQueueBinding(binding))
      throw new Error("queue private context source authority changed");
    const current = this.host.readMessage(
      this.host.messageDirectory(
        binding.owner_principal_digest,
        binding.root_session_id,
        binding.enqueue_idempotency_key_digest,
      ),
    );
    if (!current) throw new Error("queue private context stage is absent");
    const handoff = this.host.sourceBinding(current);
    return { handoff, file_range: this.host.sources.content(handoff) };
  }

  disposition(
    binding: PrivateConversationMessageQueueContextBindingV1,
    outcome: ConversationPrivateContextQueueOutcomeV1,
    publicEventId: string | null,
    recordedAt: string,
  ): PrivateConversationMessageQueueContextDispositionV1 {
    if (!this.validateQueueBinding(binding))
      throw new Error("queue private context binding is not current");
    return outcome === CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME.DELIVERED && publicEventId
      ? materializeQueuePrivateContextDispositionV1({
          root_session_id: binding.root_session_id,
          queue_item_id: binding.queue_item_id,
          private_context_binding_digest: binding.private_context_binding_digest,
          recorded_at: recordedAt,
          queue_outcome: CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME.DELIVERED,
          disposition: CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION.CONSUMED,
          public_event_id: publicEventId,
        })
      : outcome === CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME.STALE && publicEventId === null
        ? materializeQueuePrivateContextDispositionV1({
            root_session_id: binding.root_session_id,
            queue_item_id: binding.queue_item_id,
            private_context_binding_digest: binding.private_context_binding_digest,
            recorded_at: recordedAt,
            queue_outcome: CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME.STALE,
            disposition: CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION.RELEASED,
            public_event_id: null,
          })
        : (() => {
            throw new Error("private context disposition outcome is invalid");
          })();
  }

  applyDisposition(
    binding: PrivateConversationMessageQueueContextBindingV1,
    disposition: PrivateConversationMessageQueueContextDispositionV1,
  ): void {
    assertQueueContextBindingV1(binding);
    assertQueueContextDispositionV1(disposition);
    if (
      disposition.root_session_id !== binding.root_session_id ||
      disposition.queue_item_id !== binding.queue_item_id ||
      disposition.private_context_binding_digest !== binding.private_context_binding_digest
    )
      throw new Error("private context disposition does not match binding");
    this.host.withLock(`message-private-context-disposition:${binding.queue_item_id}`, (lock) => {
      const path = this.host.messageDirectory(
        binding.owner_principal_digest,
        binding.root_session_id,
        binding.enqueue_idempotency_key_digest,
      );
      const current = this.host.readMessage(path);
      const targetState =
        disposition.disposition === CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION.CONSUMED
          ? CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.CONSUMED
          : CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.RELEASED;
      if (
        !current ||
        current.queue_item_id !== binding.queue_item_id ||
        current.private_context_binding_digest !== binding.private_context_binding_digest
      )
        throw new Error("private context disposition stage changed");
      if (current.stage_state === targetState) return;
      if (current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.ADMISSION_OWNED)
        throw new Error("private context disposition conflicts with terminal state");
      const source = this.host.sourceBinding(current);
      const key = reservationKey(binding.queue_item_id);
      if (disposition.disposition === CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION.CONSUMED) {
        this.host.sources.consume(
          source,
          key,
          `${CONVERSATION_PRIVATE_CONTEXT_SOURCE_CONSUMER_KIND.QUEUE}:${binding.queue_item_id}:${disposition.public_event_id}`,
          disposition.recorded_at,
        );
      } else {
        this.host.sources.release(source, key, disposition.recorded_at);
      }
      this.host.publish(
        path,
        current,
        transition(
          current,
          {
            stage_state: targetState,
            queue_item_id: current.queue_item_id,
            private_context_binding_digest: current.private_context_binding_digest,
          },
          disposition.recorded_at,
        ),
        lock,
      );
    });
  }

  private rollback(binding: PrivateConversationMessageQueueContextBindingV1): void {
    this.host.withLock(`message-private-context-rollback:${binding.queue_item_id}`, (lock) => {
      const path = this.host.messageDirectory(
        binding.owner_principal_digest,
        binding.root_session_id,
        binding.enqueue_idempotency_key_digest,
      );
      const current = this.host.readMessage(path);
      if (
        !current ||
        current.stage_state !== CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.ADMISSION_OWNED ||
        current.queue_item_id !== binding.queue_item_id ||
        current.private_context_binding_digest !== binding.private_context_binding_digest
      )
        throw new Error("private context rollback authority changed");
      const at = this.host.now();
      this.host.sources.release(
        this.host.sourceBinding(current),
        reservationKey(binding.queue_item_id),
        at,
      );
      this.host.publish(
        path,
        current,
        transition(
          current,
          {
            stage_state: CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE,
            queue_item_id: null,
            private_context_binding_digest: null,
          },
          at,
        ),
        lock,
      );
    });
  }
}
