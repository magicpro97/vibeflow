import { join } from "node:path";
import {
  type ProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import {
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
} from "./conversation-message-queue-contract.js";
import type { FoldedConversationMessageQueueV1 } from "./conversation-message-queue-fold.js";
import {
  assertQueueContextBindingV1,
  assertQueueContextDispositionV1,
} from "./conversation-message-queue-private-validation.js";
import type {
  PrivateConversationMessageQueueContextBindingV1,
  PrivateConversationMessageQueueContextDispositionV1,
} from "./conversation-message-queue-records.js";
import {
  ConversationMessageQueueCorruptError,
  decodeCanonicalQueueRecord,
} from "./conversation-message-queue-validation.js";

const same = (left: unknown, right: unknown): boolean =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

export interface RevalidatedConversationMessageQueuePrivateContextV1 {
  source_record_digest: string;
  source_reservation_digest: string;
  target_participant_ids: string[];
}

export type ConversationMessageQueuePrivateContextValidatorV1 = (
  binding: PrivateConversationMessageQueueContextBindingV1,
) => RevalidatedConversationMessageQueuePrivateContextV1 | null;

export class ConversationMessageQueuePrivateObjectStoreV1 {
  readonly paths: { bindings: string; dispositions: string };

  constructor(
    queueRoot: string,
    private readonly validateAuthority:
      | ConversationMessageQueuePrivateContextValidatorV1
      | undefined = undefined,
  ) {
    this.paths = Object.freeze({
      bindings: ensurePrivateDirectory(join(queueRoot, "private-contexts")),
      dispositions: ensurePrivateDirectory(join(queueRoot, "private-context-dispositions")),
    });
  }

  private bindingPath(digest: string): string {
    return join(this.paths.bindings, `${digestHex(digest)}.json`);
  }

  private dispositionPath(digest: string): string {
    return join(this.paths.dispositions, `${digestHex(digest)}.json`);
  }

  writeBinding(binding: PrivateConversationMessageQueueContextBindingV1, lock: ProcessLock): void {
    assertQueueContextBindingV1(binding);
    createOrVerifyPrivateFile(
      this.bindingPath(binding.private_context_binding_digest),
      canonicalJsonBytes(binding),
      { lock, maxBytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes },
    );
  }

  writeDisposition(
    disposition: PrivateConversationMessageQueueContextDispositionV1,
    lock: ProcessLock,
  ): void {
    assertQueueContextDispositionV1(disposition);
    createOrVerifyPrivateFile(
      this.dispositionPath(disposition.disposition_digest),
      canonicalJsonBytes(disposition),
      { lock, maxBytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes },
    );
  }

  readBinding(digest: string): PrivateConversationMessageQueueContextBindingV1 | null {
    const bytes = privateFileBytes(
      this.bindingPath(digest),
      CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes,
    );
    if (bytes === null) return null;
    const binding = decodeCanonicalQueueRecord<PrivateConversationMessageQueueContextBindingV1>(
      bytes,
      assertQueueContextBindingV1,
    );
    if (binding.private_context_binding_digest !== digest)
      throw new ConversationMessageQueueCorruptError(
        "queue private context binding content address changed",
      );
    return binding;
  }

  readDisposition(digest: string): PrivateConversationMessageQueueContextDispositionV1 | null {
    const bytes = privateFileBytes(
      this.dispositionPath(digest),
      CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes,
    );
    if (bytes === null) return null;
    const disposition =
      decodeCanonicalQueueRecord<PrivateConversationMessageQueueContextDispositionV1>(
        bytes,
        assertQueueContextDispositionV1,
      );
    if (disposition.disposition_digest !== digest)
      throw new ConversationMessageQueueCorruptError(
        "queue private context disposition content address changed",
      );
    return disposition;
  }

  validateFold(fold: FoldedConversationMessageQueueV1): void {
    for (const row of fold.items) {
      if (!row.private_context_binding_digest) {
        if (row.item.private_context_present || row.private_context_disposition)
          throw new ConversationMessageQueueCorruptError(
            "queue item exposes private context without binding authority",
          );
        continue;
      }
      const binding = this.readBinding(row.private_context_binding_digest);
      const revalidated = binding
        ? (this.validateAuthority?.(structuredClone(binding)) ?? null)
        : null;
      if (
        !binding ||
        !revalidated ||
        binding.private_context_binding_digest !== row.private_context_binding_digest ||
        binding.root_session_id !== row.item.root_session_id ||
        binding.queue_item_id !== row.item.queue_item_id ||
        binding.queue_sequence !== row.item.queue_sequence ||
        binding.owner_principal_digest !== row.owner_principal_digest ||
        binding.enqueue_idempotency_key_digest !== row.enqueue_idempotency_key_digest ||
        binding.source_record_digest !== revalidated.source_record_digest ||
        binding.source_reservation_digest !== revalidated.source_reservation_digest ||
        !same(binding.target_participant_ids, revalidated.target_participant_ids) ||
        (row.item.target_participants !== CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL &&
          !same(revalidated.target_participant_ids, row.item.target_participants))
      )
        throw new ConversationMessageQueueCorruptError(
          "queue private context binding is missing or changed",
        );
      if (
        row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
        row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED
      ) {
        if (row.private_context_disposition)
          throw new ConversationMessageQueueCorruptError(
            "nonterminal queue item has a private context disposition",
          );
        continue;
      }
      const expected = row.private_context_disposition;
      const durable = expected ? this.readDisposition(expected.disposition_digest) : null;
      if (
        !expected ||
        !durable ||
        durable.disposition_digest !== expected.disposition_digest ||
        !same(expected, durable)
      )
        throw new ConversationMessageQueueCorruptError(
          "terminal queue private context disposition is missing or changed",
        );
    }
  }
}
