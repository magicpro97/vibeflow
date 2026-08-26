import { canonicalJsonBytes } from "../../durability/index.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import {
  classifyConversationMessageQueueAuthorityDrift,
  materializeConversationMessageQueueDeliveryProofV1,
} from "./conversation-message-queue-authority.js";
import {
  CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "./conversation-message-queue-contract.js";
import type {
  PrivateConversationMessageQueueContextBindingV1,
  PrivateConversationMessageQueueDeliveryProofV1,
} from "./conversation-message-queue-records.js";
import type { ConversationMessageQueueRuntimeV1 } from "./conversation-message-queue-runtime.js";
import type { PrivateConversationMessageQueueClaimV1 } from "./conversation-message-queue-store.js";
import type { ConversationQueuedMessageDeliveryAuthorityV1 } from "./conversation-message-queue-trace-authority.js";
import type { ConversationPrivateContextBrokerV1 } from "./conversation-private-context-broker-store.js";
import type {
  ConversationUserMessageAuthorityV1,
  ResolvedConversationUserMessageAuthorityV1,
} from "./conversation-user-message-authority.js";
import type { MessageRequest } from "./types.js";

export interface ConversationQueuedMessageDeliveryHostV1 {
  queuedMessageReady(conversationId: string, revisionOperationId: string | null): boolean;
  deliverQueuedMessage(input: {
    conversation_id: string;
    request: MessageRequest & { target_participants: "all" | string[] };
    message_key: string;
    authority: ConversationQueuedMessageDeliveryAuthorityV1;
  }): Promise<{ childId: string }>;
}

type QueueRun = { dirty: boolean; promise: Promise<void> };

const same = (left: unknown, right: unknown): boolean =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

/** Drains one durable FIFO claim at a time and never advances past uncertainty. */
export class ConversationMessageQueueDispatcherV1 {
  private readonly runs = new Map<string, QueueRun>();

  constructor(
    private readonly input: {
      queue: ConversationMessageQueueRuntimeV1;
      messages: ConversationUserMessageAuthorityV1;
      broker: ConversationPrivateContextBrokerV1;
      home: ConversationHomeAuthorities;
      delivery: ConversationQueuedMessageDeliveryHostV1;
      now(): string;
      schedule(task: () => void): void;
    },
  ) {
    input.queue.bindDispatcher((root) => this.kick(root));
  }

  kick(rootSessionId: string): void {
    const active = this.runs.get(rootSessionId);
    if (active) {
      active.dirty = true;
      return;
    }
    const run = { dirty: true, promise: Promise.resolve() };
    run.promise = new Promise<void>((resolve) => {
      this.input.schedule(() => void this.drain(rootSessionId, run).finally(resolve));
    });
    this.runs.set(rootSessionId, run);
    void run.promise.finally(() => {
      if (this.runs.get(rootSessionId) !== run) return;
      this.runs.delete(rootSessionId);
      if (run.dirty) this.kick(rootSessionId);
    });
  }

  private async drain(rootSessionId: string, run: QueueRun): Promise<void> {
    while (run.dirty) {
      run.dirty = false;
      try {
        this.reconcilePrivateDispositions(rootSessionId);
        if (await this.dispatchOldest(rootSessionId)) run.dirty = true;
      } catch {
        // Durable claims remain exact and block successors until a later recovery kick.
      }
    }
  }

  private async dispatchOldest(rootSessionId: string): Promise<boolean> {
    const current = this.input.messages.resolveRoot(rootSessionId);
    const store = this.input.queue.storeAuthority(rootSessionId);
    const oldest = store
      .readAuthorityFold()
      .items.find(
        ({ item }) =>
          item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
          item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
      );
    if (oldest?.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED) {
      const recovery = store.claimOldest({
        resolve_authority: () => current.authority,
        recorded_at: this.input.now(),
      });
      if (recovery.status !== CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS.CLAIMED)
        throw new Error("claimed queue item could not recover its process-owned token");
      const claim = recovery.claim;
      const binding = claim.private_context_binding_digest
        ? store.journal.privateObjects.readBinding(claim.private_context_binding_digest)
        : null;
      if (claim.private_context_binding_digest && !binding)
        throw new Error("claimed private context binding disappeared");
      const token = this.input.queue.traceAuthority.issue(claim, (child, key) =>
        this.writePrivateContext(child, key, claim, binding),
      );
      if (this.completeIfStable(rootSessionId, claim, token, binding)) return true;
    }
    if (
      !current.stable ||
      !current.active_operation_id ||
      !this.input.delivery.queuedMessageReady(
        current.conversation_id,
        current.revision_operation_id,
      )
    )
      return false;
    if (!oldest) return false;
    const privateBinding = oldest.private_context_binding_digest
      ? store.journal.privateObjects.readBinding(oldest.private_context_binding_digest)
      : null;
    if (oldest.private_context_binding_digest && !privateBinding)
      throw new Error("queued private context binding disappeared");
    const staleDisposition = privateBinding
      ? this.input.broker.queueDisposition(
          privateBinding,
          CONVERSATION_MESSAGE_QUEUE_STATE.STALE,
          null,
          this.input.now(),
        )
      : null;
    const result = store.claimOldest({
      resolve_authority: () => this.input.messages.resolveRoot(rootSessionId).authority,
      recorded_at: this.input.now(),
      stale_private_context_disposition: staleDisposition,
    });
    if (result.status === CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS.EMPTY) return false;
    if (result.status === CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS.STALE) {
      if (privateBinding && staleDisposition)
        this.input.broker.applyQueueDisposition(privateBinding, staleDisposition);
      this.input.queue.notifyTransition(result.item);
      return true;
    }
    return this.dispatchClaim(rootSessionId, result.claim);
  }

  private async dispatchClaim(
    rootSessionId: string,
    claim: PrivateConversationMessageQueueClaimV1,
  ): Promise<boolean> {
    const store = this.input.queue.storeAuthority(rootSessionId);
    const binding = claim.private_context_binding_digest
      ? store.journal.privateObjects.readBinding(claim.private_context_binding_digest)
      : null;
    if (claim.private_context_binding_digest && !binding)
      throw new Error("claimed private context binding disappeared");
    const token = this.input.queue.traceAuthority.issue(claim, (child, key) =>
      this.writePrivateContext(child, key, claim, binding),
    );
    const completed = this.completeIfStable(rootSessionId, claim, token, binding);
    if (completed) return true;
    const current = this.input.messages.resolveRoot(rootSessionId);
    if (current.authority.authority_digest !== claim.item.effective_authority_digest) {
      if (this.input.home.lineage.readReservation(rootSessionId)?.status === "active") return false;
      const disposition = binding
        ? this.input.broker.queueDisposition(
            binding,
            CONVERSATION_MESSAGE_QUEUE_STATE.STALE,
            null,
            this.input.now(),
          )
        : null;
      const proveNoAcceptedEffect = () =>
        this.findPublicEffectAnywhere(rootSessionId, claim) === null;
      const item = store.markClaimStale({
        claim,
        stale_reason: classifyConversationMessageQueueAuthorityDrift(
          this.claimedAuthority(rootSessionId, claim),
          current.authority,
        ),
        private_context_disposition: disposition,
        recorded_at: this.input.now(),
        prove_no_accepted_effect: proveNoAcceptedEffect,
      });
      if (binding && disposition) this.input.broker.applyQueueDisposition(binding, disposition);
      this.input.queue.traceAuthority.settle(token);
      this.input.queue.notifyTransition(item);
      return true;
    }
    await this.input.delivery.deliverQueuedMessage({
      conversation_id: current.conversation_id,
      request: {
        content: claim.item.content,
        target_participants: structuredClone(claim.item.target_participants),
        ...(claim.item.quote_refs.length
          ? { quote_refs: structuredClone(claim.item.quote_refs) }
          : {}),
      },
      message_key: token.messageKey,
      authority: token,
    });
    return this.completeIfStable(rootSessionId, claim, token, binding);
  }

  private claimedAuthority(rootSessionId: string, claim: PrivateConversationMessageQueueClaimV1) {
    const rows = this.input.queue.storeAuthority(rootSessionId).readAuthorityFold().items;
    const current = rows.find(({ item }) => item.queue_item_id === claim.item.queue_item_id);
    if (!current) throw new Error("claimed queue authority disappeared");
    if (current.admitted_authority.authority_digest === claim.item.effective_authority_digest)
      return current.admitted_authority;
    const predecessor = rows.find(
      ({ item }) => item.queue_item_id === claim.item.predecessor_queue_item_id,
    );
    const successor = predecessor?.delivery_proof?.successor_authority;
    if (successor?.authority_digest !== claim.item.effective_authority_digest)
      throw new Error("claimed effective authority has no causal proof");
    return successor;
  }

  private completeIfStable(
    rootSessionId: string,
    claim: PrivateConversationMessageQueueClaimV1,
    token: ConversationQueuedMessageDeliveryAuthorityV1,
    binding: PrivateConversationMessageQueueContextBindingV1 | null,
  ): boolean {
    const resolved = this.input.messages.resolveRoot(rootSessionId);
    const effect = this.findPublicEffect(resolved, claim);
    if (!effect || !resolved.stable) return false;
    token.bindChild(resolved.conversation_id);
    const disposition = binding
      ? this.input.broker.queueDisposition(
          binding,
          CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED,
          claim.public_event_id,
          this.input.now(),
        )
      : null;
    const proof = this.proof(resolved, claim, effect.seq, disposition?.disposition_digest ?? null);
    const store = this.input.queue.storeAuthority(rootSessionId);
    const item = store.markDelivered({
      claim,
      proof,
      private_context_disposition: disposition,
      recorded_at: this.input.now(),
      validate_delivery_proof: (candidate) => this.validateProof(rootSessionId, claim, candidate),
    });
    this.input.queue.traceAuthority.settle(token);
    if (binding && disposition) this.input.broker.applyQueueDisposition(binding, disposition);
    this.input.queue.notifyTransition(item);
    return true;
  }

  private findPublicEffect(
    resolved: ResolvedConversationUserMessageAuthorityV1,
    claim: PrivateConversationMessageQueueClaimV1,
  ) {
    const matches = resolved.source.journal_records
      .map(({ stored_event }) => stored_event)
      .filter(({ event_id }) => event_id === claim.public_event_id);
    if (matches.length > 1) throw new Error("queued public event identity is duplicated");
    const event = matches[0];
    if (!event) return null;
    this.assertPublicEffect(event, claim);
    return event;
  }

  private findPublicEffectAnywhere(
    rootSessionId: string,
    claim: PrivateConversationMessageQueueClaimV1,
  ) {
    const matches = this.input.messages.publicEventsById(rootSessionId, claim.public_event_id);
    if (matches.length > 1) throw new Error("queued public event identity is duplicated");
    const event = matches[0];
    if (!event) return null;
    this.assertPublicEffect(event, claim);
    return event;
  }

  private assertPublicEffect(
    event: ReturnType<ConversationUserMessageAuthorityV1["publicEventsById"]>[number],
    claim: PrivateConversationMessageQueueClaimV1,
  ): void {
    if (
      event.operation_id !== claim.durable_operation_id ||
      event.idempotency_key !== `queue-message.${claim.item.queue_item_id}` ||
      event.event.type !== "user_message" ||
      event.event.payload.content !== claim.item.content ||
      !same(event.event.payload.target_participants, claim.item.target_participants) ||
      !same(event.event.payload.quote_refs ?? [], claim.item.quote_refs)
    )
      throw new Error("queued public event authority changed");
  }

  private proof(
    resolved: ResolvedConversationUserMessageAuthorityV1,
    claim: PrivateConversationMessageQueueClaimV1,
    publicSeq: number,
    dispositionDigest: string | null,
  ): PrivateConversationMessageQueueDeliveryProofV1 {
    if (resolved.active_operation_id !== claim.durable_operation_id)
      throw new Error("queued operation is not the active successor operation");
    return materializeConversationMessageQueueDeliveryProofV1({
      item: claim.item,
      public_seq: publicSeq,
      stable_operation_digest: this.input.messages.stableOperationDigest(resolved),
      successor_authority: resolved.authority,
      private_context_binding_digest: claim.private_context_binding_digest,
      private_context_disposition_digest: dispositionDigest,
    });
  }

  private validateProof(
    rootSessionId: string,
    claim: PrivateConversationMessageQueueClaimV1,
    proof: PrivateConversationMessageQueueDeliveryProofV1,
  ): boolean {
    const resolved = this.input.messages.resolveRoot(rootSessionId);
    const effect = this.findPublicEffect(resolved, claim);
    if (!effect || !resolved.stable) return false;
    return same(
      proof,
      this.proof(resolved, claim, effect.seq, proof.private_context_disposition_digest),
    );
  }

  private writePrivateContext(
    child: string,
    key: string,
    claim: PrivateConversationMessageQueueClaimV1,
    binding: PrivateConversationMessageQueueContextBindingV1 | null,
  ): void {
    if (!binding) return;
    const source = this.input.broker.mutations.queueSource(binding);
    this.input.home.privateTurnContexts.writeMessage({
      conversationId: child,
      messageKey: key,
      targetParticipantIds: binding.target_participant_ids,
      createdAt: claim.item.admitted_at,
      handoff: source.handoff,
      fileRange: source.file_range,
    });
  }

  private reconcilePrivateDispositions(rootSessionId: string): void {
    const store = this.input.queue.storeAuthority(rootSessionId);
    for (const row of store.readAuthorityFold().items) {
      const binding = row.private_context_binding_digest
        ? store.journal.privateObjects.readBinding(row.private_context_binding_digest)
        : null;
      if (binding && row.private_context_disposition)
        this.input.broker.applyQueueDisposition(binding, row.private_context_disposition);
    }
  }
}
