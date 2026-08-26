import { join } from "node:path";
import {
  type ProcessLock,
  atomicCompareAndSwap,
  canonicalJsonBytes,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import {
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
} from "./conversation-message-queue-contract.js";
import { assertConversationMessageQueueEventV1 } from "./conversation-message-queue-event-validation.js";
import type {
  PrivateConversationMessageQueueEventV1,
  PrivateConversationMessageQueueIdempotencyBindingV1,
} from "./conversation-message-queue-records.js";
import {
  assertQueueIdempotencyBindingV1,
  decodeCanonicalQueueRecord,
  isQueueDigest,
  isQueueReference,
  queueExactKeys,
  queueRecord,
} from "./conversation-message-queue-validation.js";

const PENDING_DOMAIN = "VF-CONVERSATION-MESSAGE-QUEUE-PENDING-MUTATION\0v1\0";

export type PrivateConversationMessageQueuePendingMutationV1 = {
  schema_version: typeof CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION;
  root_session_id: string;
  previous_slot_digest: string | null;
  winning_event_digest: string;
  slot_digest: string;
} & (
  | {
      state: typeof CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.PENDING;
      binding: PrivateConversationMessageQueueIdempotencyBindingV1;
      event: PrivateConversationMessageQueueEventV1;
    }
  | {
      state: typeof CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.SETTLED;
      binding: null;
      event: null;
    }
);

function slotDigest(
  value: Omit<PrivateConversationMessageQueuePendingMutationV1, "slot_digest">,
): string {
  return digestV1(PENDING_DOMAIN, value);
}

function assertPendingMutation(
  value: unknown,
): asserts value is PrivateConversationMessageQueuePendingMutationV1 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, [
      "schema_version",
      "root_session_id",
      "state",
      "binding",
      "event",
      "previous_slot_digest",
      "winning_event_digest",
      "slot_digest",
    ]) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    !isQueueReference(value.root_session_id) ||
    (value.state !== CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.PENDING &&
      value.state !== CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.SETTLED) ||
    (value.previous_slot_digest !== null && !isQueueDigest(value.previous_slot_digest)) ||
    !isQueueDigest(value.winning_event_digest) ||
    !isQueueDigest(value.slot_digest)
  )
    throw new Error("invalid queue pending mutation slot");
  if (value.state === CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.PENDING) {
    assertQueueIdempotencyBindingV1(value.binding);
    assertConversationMessageQueueEventV1(value.event);
    if (
      value.binding.root_session_id !== value.root_session_id ||
      value.event.root_session_id !== value.root_session_id ||
      value.binding.winning_event_digest !== value.winning_event_digest ||
      value.event.event_digest !== value.winning_event_digest
    )
      throw new Error("queue pending mutation authority changed");
  } else if (value.binding !== null || value.event !== null) {
    throw new Error("settled queue pending slot retains mutation authority");
  }
  const typed = value as unknown as PrivateConversationMessageQueuePendingMutationV1;
  const { slot_digest: _digest, ...preimage } = typed;
  if (slotDigest(preimage) !== typed.slot_digest)
    throw new Error("queue pending mutation digest changed");
}

function materialize(
  value: Omit<PrivateConversationMessageQueuePendingMutationV1, "slot_digest">,
): PrivateConversationMessageQueuePendingMutationV1 {
  return {
    ...value,
    slot_digest: slotDigest(value),
  } as PrivateConversationMessageQueuePendingMutationV1;
}

export class ConversationMessageQueuePendingMutationStoreV1 {
  readonly path: string;

  constructor(
    queueRoot: string,
    private readonly rootSessionId: string,
  ) {
    this.path = join(queueRoot, "pending-mutation.json");
  }

  read(): {
    bytes: Buffer | null;
    value: PrivateConversationMessageQueuePendingMutationV1 | null;
  } {
    const bytes = privateFileBytes(this.path, CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes);
    if (bytes === null) return { bytes, value: null };
    const value = decodeCanonicalQueueRecord<PrivateConversationMessageQueuePendingMutationV1>(
      bytes,
      assertPendingMutation,
    );
    if (value.root_session_id !== this.rootSessionId)
      throw new Error("queue pending mutation crosses root authority");
    return { bytes, value };
  }

  begin(
    binding: PrivateConversationMessageQueueIdempotencyBindingV1,
    event: PrivateConversationMessageQueueEventV1,
    lock: ProcessLock,
  ): PrivateConversationMessageQueuePendingMutationV1 & {
    state: typeof CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.PENDING;
  } {
    const prior = this.read();
    if (prior.value?.state === CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.PENDING)
      throw new Error("queue pending mutation must be reconciled before another writer");
    const next = materialize({
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      root_session_id: this.rootSessionId,
      state: CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.PENDING,
      binding: structuredClone(binding),
      event: structuredClone(event),
      previous_slot_digest: prior.value?.slot_digest ?? null,
      winning_event_digest: event.event_digest,
    });
    atomicCompareAndSwap(this.path, prior.bytes, canonicalJsonBytes(next), {
      lock,
      maxBytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes,
    });
    return next as PrivateConversationMessageQueuePendingMutationV1 & {
      state: typeof CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.PENDING;
    };
  }

  settle(
    pending: PrivateConversationMessageQueuePendingMutationV1 & {
      state: typeof CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.PENDING;
    },
    lock: ProcessLock,
  ): void {
    const current = this.read();
    if (!current.value || current.value.slot_digest !== pending.slot_digest)
      throw new Error("queue pending mutation slot changed before settlement");
    const settled = materialize({
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      root_session_id: this.rootSessionId,
      state: CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.SETTLED,
      binding: null,
      event: null,
      previous_slot_digest: pending.slot_digest,
      winning_event_digest: pending.winning_event_digest,
    });
    atomicCompareAndSwap(this.path, current.bytes, canonicalJsonBytes(settled), {
      lock,
      maxBytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes,
    });
  }
}
