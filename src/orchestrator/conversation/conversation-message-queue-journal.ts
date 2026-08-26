import { join, resolve } from "node:path";
import {
  type ProcessLock,
  acquireProcessLock,
  atomicCompareAndSwap,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  type ConversationMessageQueueMutationKindV1,
} from "./conversation-message-queue-contract.js";
import { assertConversationMessageQueueEventV1 } from "./conversation-message-queue-event-validation.js";
import {
  type FoldedConversationMessageQueueV1,
  foldConversationMessageQueueV1,
} from "./conversation-message-queue-fold.js";
import { assertQueueIdempotencyWinnerV1 } from "./conversation-message-queue-idempotency.js";
import {
  ConversationMessageQueuePendingMutationStoreV1,
  type PrivateConversationMessageQueuePendingMutationV1,
} from "./conversation-message-queue-pending.js";
import { ConversationMessageQueuePrivateObjectStoreV1 } from "./conversation-message-queue-private-store.js";
import type {
  PrivateConversationMessageQueueCurrentV1,
  PrivateConversationMessageQueueEventPayloadV1,
  PrivateConversationMessageQueueEventV1,
  PrivateConversationMessageQueueIdempotencyBindingV1,
} from "./conversation-message-queue-records.js";
import {
  queueEventDigest,
  queueIdempotencyBindingDigest,
  queueIdempotencyFileKey,
} from "./conversation-message-queue-records.js";
import {
  ConversationMessageQueueConflictError,
  ConversationMessageQueueCorruptError,
  assertQueueCurrentV1,
  assertQueueIdempotencyBindingV1,
  decodeCanonicalQueueRecord,
  isQueueReference,
} from "./conversation-message-queue-validation.js";

export function assertQueueJournalAppendCapacity(journalSequence: number): void {
  if (!Number.isSafeInteger(journalSequence) || journalSequence < 0)
    throw new Error("invalid queue journal append sequence");
  if (journalSequence >= CONVERSATION_MESSAGE_QUEUE_LIMITS.maxJournalEvents)
    throw new ConversationMessageQueueConflictError(
      CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
      "conversation message queue journal reached its lifetime capacity",
    );
}

export type ConversationMessageQueueJournalFaultV1 = (
  point: "after-event" | "after-idempotency" | "after-current",
) => void;

export class ConversationMessageQueueJournalV1 {
  readonly rootSessionId: string;
  readonly privateObjects: ConversationMessageQueuePrivateObjectStoreV1;
  readonly pendingMutations: ConversationMessageQueuePendingMutationStoreV1;
  readonly paths: {
    root: string;
    events: string;
    idempotency: string;
    claims: string;
    current: string;
    pendingMutation: string;
    writerLock: string;
  };
  private readonly fault?: ConversationMessageQueueJournalFaultV1;

  constructor(options: {
    privateConversationRoot: string;
    rootSessionId: string;
    fault?: ConversationMessageQueueJournalFaultV1;
    validatePrivateContextBinding?: ConstructorParameters<
      typeof ConversationMessageQueuePrivateObjectStoreV1
    >[1];
  }) {
    if (!isQueueReference(options.rootSessionId)) throw new Error("invalid queue root authority");
    const root = ensurePrivateDirectory(
      join(resolve(options.privateConversationRoot), "message-queue", "v1"),
    );
    this.rootSessionId = options.rootSessionId;
    this.paths = Object.freeze({
      root,
      events: ensurePrivateDirectory(join(root, "events")),
      idempotency: ensurePrivateDirectory(join(root, "idempotency")),
      claims: ensurePrivateDirectory(join(root, "claims")),
      current: join(root, "current.json"),
      pendingMutation: join(root, "pending-mutation.json"),
      writerLock: join(root, "writer.lock"),
    });
    this.privateObjects = new ConversationMessageQueuePrivateObjectStoreV1(
      root,
      options.validatePrivateContextBinding,
    );
    this.pendingMutations = new ConversationMessageQueuePendingMutationStoreV1(
      root,
      this.rootSessionId,
    );
    this.fault = options.fault;
  }

  withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.paths.writerLock, { operation });
    try {
      this.reconcilePendingMutation(lock);
      return run(lock);
    } finally {
      lock.release();
    }
  }

  private reconcilePendingMutation(lock: ProcessLock): void {
    const slot = this.pendingMutations.read().value;
    if (!slot || slot.state === CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.SETTLED) return;
    const pending = slot as PrivateConversationMessageQueuePendingMutationV1 & {
      state: typeof CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE.PENDING;
    };
    assertQueueIdempotencyWinnerV1(pending.binding, pending.event);
    assertQueueJournalAppendCapacity(pending.event.journal_sequence);
    createOrVerifyPrivateFile(
      this.eventPath(pending.event.event_digest),
      canonicalJsonBytes(pending.event),
      { lock, maxBytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes },
    );
    createOrVerifyPrivateFile(
      this.bindingPath(pending.binding),
      canonicalJsonBytes(pending.binding),
      { lock, maxBytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes },
    );
    const events = this.readEvents();
    const winnerIndex = events.findIndex(
      (event) => event.event_digest === pending.winning_event_digest,
    );
    if (winnerIndex >= 0) {
      if (winnerIndex !== events.length - 1)
        throw new ConversationMessageQueueCorruptError(
          "settling queue mutation is not the current journal head",
        );
    } else {
      const current = this.readCurrent().value;
      if (
        pending.event.journal_sequence !== (current?.last_journal_sequence ?? -1) + 1 ||
        pending.event.previous_event_digest !== (current?.head_event_digest ?? null)
      )
        throw new ConversationMessageQueueCorruptError(
          "pending queue mutation does not extend the current head",
        );
      foldConversationMessageQueueV1(this.rootSessionId, [...events, pending.event]);
      this.publishCurrent(pending.event, lock);
    }
    this.readFold();
    this.pendingMutations.settle(pending, lock);
  }

  private eventPath(digest: string): string {
    return join(this.paths.events, `${digestHex(digest)}.json`);
  }

  private bindingPath(input: {
    mutation_kind: ConversationMessageQueueMutationKindV1;
    principal_digest: string;
    root_session_id: string;
    idempotency_key_digest: string;
  }): string {
    return join(this.paths.idempotency, `${digestHex(queueIdempotencyFileKey(input))}.json`);
  }

  private readCurrent(): {
    bytes: Buffer | null;
    value: PrivateConversationMessageQueueCurrentV1 | null;
  } {
    const bytes = privateFileBytes(
      this.paths.current,
      CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes,
    );
    if (bytes === null) return { bytes, value: null };
    const value = decodeCanonicalQueueRecord<PrivateConversationMessageQueueCurrentV1>(
      bytes,
      assertQueueCurrentV1,
    );
    if (value.root_session_id !== this.rootSessionId)
      throw new ConversationMessageQueueCorruptError(
        "queue current pointer crosses root authority",
      );
    return { bytes, value };
  }

  readEvent(eventDigest: string): PrivateConversationMessageQueueEventV1 | null {
    const bytes = privateFileBytes(
      this.eventPath(eventDigest),
      CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes,
    );
    if (bytes === null) return null;
    const event = decodeCanonicalQueueRecord<PrivateConversationMessageQueueEventV1>(
      bytes,
      assertConversationMessageQueueEventV1,
    );
    if (event.event_digest !== eventDigest || event.root_session_id !== this.rootSessionId)
      throw new ConversationMessageQueueCorruptError("queue event storage identity changed");
    return event;
  }

  readEvents(): PrivateConversationMessageQueueEventV1[] {
    const current = this.readCurrent().value;
    if (!current) return [];
    if (current.last_journal_sequence >= CONVERSATION_MESSAGE_QUEUE_LIMITS.maxJournalEvents)
      throw new ConversationMessageQueueCorruptError("queue journal exceeds validation bound");
    const descending: PrivateConversationMessageQueueEventV1[] = [];
    let digest: string | null = current.head_event_digest;
    for (let sequence = current.last_journal_sequence; sequence >= 0; sequence -= 1) {
      if (!digest)
        throw new ConversationMessageQueueCorruptError("queue event ancestry ended early");
      const event = this.readEvent(digest);
      if (!event || event.journal_sequence !== sequence)
        throw new ConversationMessageQueueCorruptError("queue event ancestry is missing or sparse");
      descending.push(event);
      digest = event.previous_event_digest;
    }
    if (digest !== null)
      throw new ConversationMessageQueueCorruptError(
        "queue event ancestry has an unreachable prefix",
      );
    const events = descending.reverse();
    foldConversationMessageQueueV1(this.rootSessionId, events);
    return events;
  }

  readFold(): FoldedConversationMessageQueueV1 {
    const fold = foldConversationMessageQueueV1(this.rootSessionId, this.readEvents());
    this.privateObjects.validateFold(fold);
    return fold;
  }

  materializeEvent(
    payload: PrivateConversationMessageQueueEventPayloadV1,
    recordedAt: string,
  ): PrivateConversationMessageQueueEventV1 {
    const current = this.readCurrent().value;
    assertQueueJournalAppendCapacity((current?.last_journal_sequence ?? -1) + 1);
    const preimage = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      root_session_id: this.rootSessionId,
      journal_sequence: (current?.last_journal_sequence ?? -1) + 1,
      payload: structuredClone(payload),
      previous_event_digest: current?.head_event_digest ?? null,
      recorded_at: recordedAt,
    };
    const event = { ...preimage, event_digest: queueEventDigest(preimage) };
    assertConversationMessageQueueEventV1(event);
    return event;
  }

  private publishCurrent(event: PrivateConversationMessageQueueEventV1, lock: ProcessLock): void {
    assertQueueJournalAppendCapacity(event.journal_sequence);
    const prior = this.readCurrent();
    if (
      event.journal_sequence !== (prior.value?.last_journal_sequence ?? -1) + 1 ||
      event.previous_event_digest !== (prior.value?.head_event_digest ?? null)
    )
      throw new ConversationMessageQueueCorruptError("queue event does not extend current head");
    const current: PrivateConversationMessageQueueCurrentV1 = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      root_session_id: this.rootSessionId,
      last_journal_sequence: event.journal_sequence,
      head_event_digest: event.event_digest,
    };
    atomicCompareAndSwap(this.paths.current, prior.bytes, canonicalJsonBytes(current), {
      lock,
      maxBytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes,
    });
    this.fault?.("after-current");
  }

  append(event: PrivateConversationMessageQueueEventV1, lock: ProcessLock): void {
    assertConversationMessageQueueEventV1(event);
    assertQueueJournalAppendCapacity(event.journal_sequence);
    const existing = this.readEvents();
    foldConversationMessageQueueV1(this.rootSessionId, [...existing, event]);
    createOrVerifyPrivateFile(this.eventPath(event.event_digest), canonicalJsonBytes(event), {
      lock,
      maxBytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes,
    });
    this.fault?.("after-event");
    this.publishCurrent(event, lock);
    this.readFold();
  }

  readBinding(input: {
    mutation_kind: ConversationMessageQueueMutationKindV1;
    principal_digest: string;
    root_session_id: string;
    idempotency_key_digest: string;
  }): PrivateConversationMessageQueueIdempotencyBindingV1 | null {
    const bytes = privateFileBytes(
      this.bindingPath(input),
      CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes,
    );
    if (bytes === null) return null;
    const binding = decodeCanonicalQueueRecord<PrivateConversationMessageQueueIdempotencyBindingV1>(
      bytes,
      assertQueueIdempotencyBindingV1,
    );
    if (
      binding.mutation_kind !== input.mutation_kind ||
      binding.principal_digest !== input.principal_digest ||
      binding.root_session_id !== input.root_session_id ||
      binding.idempotency_key_digest !== input.idempotency_key_digest
    )
      throw new ConversationMessageQueueCorruptError("queue idempotency storage key changed");
    const event = this.readEvent(binding.winning_event_digest);
    if (!event)
      throw new ConversationMessageQueueCorruptError("queue idempotency winner is missing");
    assertQueueIdempotencyWinnerV1(binding, event);
    return binding;
  }

  commitIdempotent(
    draft: Omit<PrivateConversationMessageQueueIdempotencyBindingV1, "binding_digest">,
    event: PrivateConversationMessageQueueEventV1,
    lock: ProcessLock,
  ): void {
    const binding = { ...draft, binding_digest: queueIdempotencyBindingDigest(draft) };
    assertQueueIdempotencyBindingV1(binding);
    assertQueueIdempotencyWinnerV1(binding, event);
    assertQueueJournalAppendCapacity(event.journal_sequence);
    const existing = this.readEvents();
    foldConversationMessageQueueV1(this.rootSessionId, [...existing, event]);
    const pending = this.pendingMutations.begin(binding, event, lock);
    createOrVerifyPrivateFile(this.eventPath(event.event_digest), canonicalJsonBytes(event), {
      lock,
      maxBytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes,
    });
    this.fault?.("after-event");
    createOrVerifyPrivateFile(this.bindingPath(binding), canonicalJsonBytes(binding), {
      lock,
      maxBytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes,
    });
    this.fault?.("after-idempotency");
    this.publishCurrent(event, lock);
    this.readFold();
    this.pendingMutations.settle(pending, lock);
  }

  recoverBinding(
    binding: PrivateConversationMessageQueueIdempotencyBindingV1,
    lock: ProcessLock,
  ): FoldedConversationMessageQueueV1 {
    const fold = this.readFold();
    if (fold.events.some((event) => event.event_digest === binding.winning_event_digest))
      return fold;
    const event = this.readEvent(binding.winning_event_digest);
    if (!event)
      throw new ConversationMessageQueueCorruptError("queue idempotency winner is missing");
    assertQueueIdempotencyWinnerV1(binding, event);
    assertQueueJournalAppendCapacity(event.journal_sequence);
    const current = this.readCurrent().value;
    if (
      event.journal_sequence !== (current?.last_journal_sequence ?? -1) + 1 ||
      event.previous_event_digest !== (current?.head_event_digest ?? null)
    )
      throw new ConversationMessageQueueCorruptError(
        "queue idempotency winner cannot be recovered",
      );
    foldConversationMessageQueueV1(this.rootSessionId, [...fold.events, event]);
    this.publishCurrent(event, lock);
    return this.readFold();
  }

  assertBindingRequest(
    binding: PrivateConversationMessageQueueIdempotencyBindingV1,
    canonicalRequestDigest: string,
  ): void {
    if (binding.canonical_request_digest !== canonicalRequestDigest)
      throw new ConversationMessageQueueConflictError(
        CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT,
        "queue idempotency key is already bound to another request",
      );
  }
}
