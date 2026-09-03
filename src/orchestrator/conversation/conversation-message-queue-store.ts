import { join } from "node:path";
import {
  type ProcessLock,
  acquireProcessLock,
  inspectProcessLockStatus,
} from "../../durability/index.js";
import {
  materializeConversationMessageQueueClaimOwnerV1,
  resolveQueuedMessageEffectiveAuthorityV1,
} from "./conversation-message-queue-authority.js";
import { assertQueueClaimLockMayAdvanceV1 } from "./conversation-message-queue-claim-authority.js";
import type {
  ConversationMessageQueueClaimResultV1,
  PrivateConversationMessageQueueClaimV1,
} from "./conversation-message-queue-claim-types.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS,
  CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS,
  CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "./conversation-message-queue-contract.js";
import type {
  FoldedConversationMessageQueueItemV1,
  FoldedConversationMessageQueueV1,
} from "./conversation-message-queue-fold.js";
import {
  type ConversationMessageQueueJournalFaultV1,
  ConversationMessageQueueJournalV1,
} from "./conversation-message-queue-journal.js";
import {
  type ConversationMessageQueueEditInputV1,
  type ConversationMessageQueueEnqueueInputV1,
  type ConversationMessageQueueMutationResultV1,
  editQueuedConversationUserMessageV1,
  enqueueConversationUserMessageV1,
} from "./conversation-message-queue-mutations.js";
import type { ConversationMessageQueuePrivateContextValidatorV1 } from "./conversation-message-queue-private-store.js";
import { assertQueueDeliveryProofV1 } from "./conversation-message-queue-private-validation.js";
import type {
  ConversationMessageQueueAuthorityV1,
  ConversationMessageQueueSnapshotV1,
  ConversationMessageQueueStaleReasonV1,
  PrivateConversationMessageQueueContextDispositionV1,
  PrivateConversationMessageQueueDeliveryProofV1,
  PublicQueuedUserMessageV1,
} from "./conversation-message-queue-records.js";
import {
  queuedMessageDurableOperationId,
  queuedMessagePublicEventId,
} from "./conversation-message-queue-records.js";
import { materializeConversationMessageQueueSnapshotV1 } from "./conversation-message-queue-snapshot.js";
import {
  assertQueuePrivateDispositionV1,
  transitionQueuedMessageItemV1,
} from "./conversation-message-queue-transitions.js";
import {
  ConversationMessageQueueConflictError,
  ConversationMessageQueueCorruptError,
  assertConversationMessageQueueAuthorityV1,
} from "./conversation-message-queue-validation.js";

export type {
  ConversationMessageQueueClaimResultV1,
  PrivateConversationMessageQueueClaimV1,
} from "./conversation-message-queue-claim-types.js";

export class ConversationMessageQueueStoreV1 {
  readonly journal: ConversationMessageQueueJournalV1;
  private readonly claimLocks = new WeakMap<object, ProcessLock>();
  private readonly activeClaims = new Map<string, PrivateConversationMessageQueueClaimV1>();
  private readonly uncertainClaimLocks: ProcessLock[] = [];

  constructor(options: {
    privateConversationRoot: string;
    rootSessionId: string;
    journalFault?: ConversationMessageQueueJournalFaultV1;
    validatePrivateContextBinding?: ConversationMessageQueuePrivateContextValidatorV1;
  }) {
    this.journal = new ConversationMessageQueueJournalV1({
      privateConversationRoot: options.privateConversationRoot,
      rootSessionId: options.rootSessionId,
      ...(options.journalFault ? { fault: options.journalFault } : {}),
      ...(options.validatePrivateContextBinding
        ? { validatePrivateContextBinding: options.validatePrivateContextBinding }
        : {}),
    });
  }

  readAuthorityFold(): FoldedConversationMessageQueueV1 {
    return this.journal.withLock("message-queue-read-authority", () => this.journal.readFold());
  }

  readItemAuthority(queueItemId: string): FoldedConversationMessageQueueItemV1 | null {
    const row = this.readAuthorityFold().items.find(
      (candidate) => candidate.item.queue_item_id === queueItemId,
    );
    return row ? structuredClone(row) : null;
  }

  snapshot(
    currentAuthority: ConversationMessageQueueAuthorityV1,
  ): ConversationMessageQueueSnapshotV1 {
    assertConversationMessageQueueAuthorityV1(currentAuthority);
    if (currentAuthority.root_session_id !== this.journal.rootSessionId)
      throw new Error("queue snapshot authority crosses root boundary");
    return materializeConversationMessageQueueSnapshotV1(
      this.journal.rootSessionId,
      currentAuthority,
      this.readAuthorityFold().items.map((row) => row.item),
    );
  }

  enqueue(input: ConversationMessageQueueEnqueueInputV1): ConversationMessageQueueMutationResultV1 {
    return enqueueConversationUserMessageV1(this.journal, input);
  }

  edit(input: ConversationMessageQueueEditInputV1): ConversationMessageQueueMutationResultV1 {
    return editQueuedConversationUserMessageV1(this.journal, input);
  }

  private claimPath(queueItemId: string): string {
    return join(this.journal.paths.claims, `${queueItemId}.lock`);
  }

  private staleOldest(
    row: FoldedConversationMessageQueueItemV1,
    reason: ConversationMessageQueueStaleReasonV1,
    recordedAt: string,
    disposition: PrivateConversationMessageQueueContextDispositionV1 | null,
    lock: ProcessLock,
  ): PublicQueuedUserMessageV1 & {
    state: typeof CONVERSATION_MESSAGE_QUEUE_STATE.STALE;
    stale_reason: ConversationMessageQueueStaleReasonV1;
  } {
    assertQueuePrivateDispositionV1(row, CONVERSATION_MESSAGE_QUEUE_STATE.STALE, disposition, null);
    const item = transitionQueuedMessageItemV1(row.item, {
      state: CONVERSATION_MESSAGE_QUEUE_STATE.STALE,
      stale_reason: reason,
      updated_at: recordedAt,
    }) as PublicQueuedUserMessageV1 & {
      state: typeof CONVERSATION_MESSAGE_QUEUE_STATE.STALE;
      stale_reason: ConversationMessageQueueStaleReasonV1;
    };
    if (disposition) this.journal.privateObjects.writeDisposition(disposition, lock);
    const event = this.journal.materializeEvent(
      {
        kind: CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.STALE,
        item,
        prior_state: row.item.state as
          | typeof CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED
          | typeof CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
        claim_epoch: row.claim_epoch,
        claim_owner_digest: row.claim_owner?.owner_digest ?? null,
        private_context_binding_digest: row.private_context_binding_digest,
        private_context_disposition: disposition ? structuredClone(disposition) : null,
      },
      recordedAt,
    );
    this.journal.append(event, lock);
    return item;
  }

  claimOldest(input: {
    resolve_authority: () => ConversationMessageQueueAuthorityV1;
    recorded_at: string;
    stale_private_context_disposition?: PrivateConversationMessageQueueContextDispositionV1 | null;
  }): ConversationMessageQueueClaimResultV1 {
    return this.journal.withLock("message-queue-claim-oldest", (writerLock) => {
      const fold = this.journal.readFold();
      const row = fold.items.find(
        (candidate) =>
          candidate.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
          candidate.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
      );
      if (!row) return { status: CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS.EMPTY };
      if (row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED && row.claim_owner) {
        const active = this.activeClaims.get(row.claim_owner.owner_digest);
        if (active)
          return {
            status: CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS.CLAIMED,
            claim: active,
            replayed: true,
          };
      }
      let effectiveAuthorityDigest = row.item.effective_authority_digest;
      if (row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED) {
        const current = input.resolve_authority();
        const resolution = resolveQueuedMessageEffectiveAuthorityV1(row, fold.items, current);
        if (resolution.status === CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS.STALE) {
          const item = this.staleOldest(
            row,
            resolution.stale_reason,
            input.recorded_at,
            input.stale_private_context_disposition ?? null,
            writerLock,
          );
          return { status: CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS.STALE, item };
        }
        effectiveAuthorityDigest = resolution.effective_authority.authority_digest;
      }
      const claimedItem = transitionQueuedMessageItemV1(row.item, {
        state: CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
        stale_reason: null,
        updated_at: input.recorded_at,
        effective_authority_digest: effectiveAuthorityDigest,
      }) as PrivateConversationMessageQueueClaimV1["item"];
      const durableOperationId = queuedMessageDurableOperationId(claimedItem);
      const claimPath = this.claimPath(claimedItem.queue_item_id);
      const status = inspectProcessLockStatus(claimPath);
      assertQueueClaimLockMayAdvanceV1(row, status, durableOperationId);
      const claimLock = acquireProcessLock(claimPath, {
        operation: `message-queue-claim:${durableOperationId}`,
        timeoutMs: 0,
      });
      const claimOwner = materializeConversationMessageQueueClaimOwnerV1(
        claimLock.owner,
        durableOperationId,
      );
      const claimEpoch = (row.claim_epoch ?? 0) + 1;
      const claim: PrivateConversationMessageQueueClaimV1 = Object.freeze({
        item: structuredClone(claimedItem),
        claim_epoch: claimEpoch,
        claim_owner: structuredClone(claimOwner),
        durable_operation_id: durableOperationId,
        public_event_id: queuedMessagePublicEventId(claimedItem),
        private_context_binding_digest: row.private_context_binding_digest,
      });
      try {
        const event = this.journal.materializeEvent(
          {
            kind: CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.CLAIMED,
            item: claimedItem,
            claim_epoch: claimEpoch,
            claim_owner: claimOwner,
            private_context_binding_digest: row.private_context_binding_digest,
          },
          input.recorded_at,
        );
        this.journal.append(event, writerLock);
      } catch (error) {
        try {
          const observed = this.journal
            .readFold()
            .items.find((candidate) => candidate.item.queue_item_id === claimedItem.queue_item_id);
          if (
            observed?.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED &&
            observed.item.item_digest === claimedItem.item_digest &&
            observed.claim_epoch === claimEpoch &&
            observed.claim_owner?.owner_digest === claimOwner.owner_digest
          ) {
            this.claimLocks.set(claim, claimLock);
            this.activeClaims.set(claimOwner.owner_digest, claim);
            return {
              status: CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS.CLAIMED,
              claim,
              replayed: false,
            };
          }
          if (
            row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED &&
            observed?.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED
          ) {
            claimLock.release();
          } else {
            this.uncertainClaimLocks.push(claimLock);
          }
        } catch {
          this.uncertainClaimLocks.push(claimLock);
        }
        throw error;
      }
      this.claimLocks.set(claim, claimLock);
      this.activeClaims.set(claimOwner.owner_digest, claim);
      return {
        status: CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS.CLAIMED,
        claim,
        replayed: false,
      };
    });
  }

  private currentClaim(claim: PrivateConversationMessageQueueClaimV1): {
    row: FoldedConversationMessageQueueItemV1;
    lock: ProcessLock;
  } {
    const lock = this.claimLocks.get(claim);
    if (!lock) throw new Error("queue claim token is not owned by this store process");
    lock.assertHeld();
    const row = this.journal
      .readFold()
      .items.find((candidate) => candidate.item.queue_item_id === claim.item.queue_item_id);
    if (
      !row ||
      row.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED ||
      row.item.item_digest !== claim.item.item_digest ||
      row.claim_epoch !== claim.claim_epoch ||
      row.claim_owner?.owner_digest !== claim.claim_owner.owner_digest
    )
      throw new ConversationMessageQueueCorruptError(
        "queue claim token no longer names current fold",
      );
    return { row, lock };
  }

  markDelivered(input: {
    claim: PrivateConversationMessageQueueClaimV1;
    proof: PrivateConversationMessageQueueDeliveryProofV1;
    private_context_disposition: PrivateConversationMessageQueueContextDispositionV1 | null;
    recorded_at: string;
    validate_delivery_proof: (proof: PrivateConversationMessageQueueDeliveryProofV1) => boolean;
  }): PublicQueuedUserMessageV1 & {
    state: typeof CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED;
  } {
    assertQueueDeliveryProofV1(input.proof);
    const result = this.journal.withLock("message-queue-delivered", (writerLock) => {
      const { row } = this.currentClaim(input.claim);
      assertQueuePrivateDispositionV1(
        row,
        CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED,
        input.private_context_disposition,
        input.claim.public_event_id,
      );
      if (
        input.proof.queue_item_id !== row.item.queue_item_id ||
        input.proof.queue_sequence !== row.item.queue_sequence ||
        input.proof.claimed_item_digest !== row.item.item_digest ||
        input.proof.public_event_id !== input.claim.public_event_id ||
        input.proof.prior_effective_authority_digest !== row.item.effective_authority_digest ||
        input.proof.successor_authority.root_session_id !== row.item.root_session_id ||
        input.proof.private_context_binding_digest !== row.private_context_binding_digest ||
        input.proof.private_context_disposition_digest !==
          (input.private_context_disposition?.disposition_digest ?? null) ||
        input.validate_delivery_proof(input.proof) !== true
      )
        throw new Error("queue delivery proof lacks exact successor authority");
      const item = transitionQueuedMessageItemV1(row.item, {
        state: CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED,
        stale_reason: null,
        updated_at: input.recorded_at,
      }) as PublicQueuedUserMessageV1 & {
        state: typeof CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED;
        stale_reason: null;
      };
      if (input.private_context_disposition)
        this.journal.privateObjects.writeDisposition(input.private_context_disposition, writerLock);
      const event = this.journal.materializeEvent(
        {
          kind: CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.DELIVERED,
          item,
          claim_epoch: input.claim.claim_epoch,
          claim_owner_digest: input.claim.claim_owner.owner_digest,
          private_context_binding_digest: row.private_context_binding_digest,
          private_context_disposition: input.private_context_disposition,
          delivery_proof: structuredClone(input.proof),
        },
        input.recorded_at,
      );
      this.journal.append(event, writerLock);
      return item;
    });
    this.releaseClaim(input.claim);
    return result;
  }

  markClaimStale(input: {
    claim: PrivateConversationMessageQueueClaimV1;
    stale_reason: ConversationMessageQueueStaleReasonV1;
    private_context_disposition: PrivateConversationMessageQueueContextDispositionV1 | null;
    recorded_at: string;
    prove_no_accepted_effect: () => boolean;
  }): PublicQueuedUserMessageV1 & {
    state: typeof CONVERSATION_MESSAGE_QUEUE_STATE.STALE;
  } {
    const result = this.journal.withLock("message-queue-claimed-stale", (writerLock) => {
      const { row } = this.currentClaim(input.claim);
      if (!input.prove_no_accepted_effect())
        throw new Error("claimed queue item cannot be staled without no-effect proof");
      return this.staleOldest(
        row,
        input.stale_reason,
        input.recorded_at,
        input.private_context_disposition,
        writerLock,
      );
    });
    this.releaseClaim(input.claim);
    return result;
  }

  private releaseClaim(claim: PrivateConversationMessageQueueClaimV1): void {
    const lock = this.claimLocks.get(claim);
    if (!lock) throw new Error("queue claim lock is absent");
    lock.release();
    this.claimLocks.delete(claim);
    this.activeClaims.delete(claim.claim_owner.owner_digest);
  }
}
