import { canonicalJsonBytes } from "../../durability/index.js";
import type { TraceRequestedEventAppendV1, TraceStore } from "../trace/store.js";
import { CONVERSATION_MESSAGE_QUEUE_STATE } from "./conversation-message-queue-contract.js";
import {
  queuedMessageDurableOperationId,
  queuedMessagePublicEventId,
} from "./conversation-message-queue-records.js";
import type { PrivateConversationMessageQueueClaimV1 } from "./conversation-message-queue-store.js";
import { assertPublicQueuedUserMessageV1 } from "./conversation-message-queue-validation.js";
import type { MessageRequest } from "./types.js";

const same = (left: unknown, right: unknown): boolean =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

export const queuedMessageDeliveryKey = (queueItemId: string): string =>
  `queue-message.${queueItemId}`;

function assertClaim(claim: PrivateConversationMessageQueueClaimV1): void {
  assertPublicQueuedUserMessageV1(claim.item);
  if (
    claim.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED ||
    claim.item.stale_reason !== null ||
    claim.durable_operation_id !== queuedMessageDurableOperationId(claim.item) ||
    claim.claim_owner.durable_operation_id !== claim.durable_operation_id ||
    claim.public_event_id !== queuedMessagePublicEventId(claim.item) ||
    claim.private_context_binding_digest === undefined
  )
    throw new Error("queued message delivery claim is invalid");
}

export class ConversationQueuedMessageDeliveryAuthorityV1 {
  private childConversationId: string | null = null;

  constructor(
    private readonly host: ConversationMessageQueueTraceAuthorityV1,
    readonly claim: PrivateConversationMessageQueueClaimV1,
    private readonly beforeAppend: (conversationId: string, messageKey: string) => void,
  ) {
    assertClaim(claim);
  }

  get operationId(): string {
    return this.claim.durable_operation_id;
  }

  get publicEventId(): string {
    return this.claim.public_event_id;
  }

  get messageKey(): string {
    return queuedMessageDeliveryKey(this.claim.item.queue_item_id);
  }

  assertRequest(
    request: MessageRequest & { target_participants: "all" | string[] },
    messageKey: string,
  ): void {
    if (
      messageKey !== this.messageKey ||
      request.content !== this.claim.item.content ||
      !same(request.target_participants, this.claim.item.target_participants) ||
      !same(request.quote_refs ?? [], this.claim.item.quote_refs)
    )
      throw new Error("queued message delivery request changed");
  }

  bindChild(conversationId: string): void {
    if (this.childConversationId && this.childConversationId !== conversationId)
      throw new Error("queued message delivery child changed");
    this.beforeAppend(conversationId, this.messageKey);
    this.childConversationId = conversationId;
    this.host.activate(this, conversationId);
  }

  assertChild(conversationId: string): void {
    if (this.childConversationId !== conversationId)
      throw new Error("queued message delivery child authority is absent");
  }
}

interface ActiveQueuedTraceAuthorityV1 {
  token: ConversationQueuedMessageDeliveryAuthorityV1;
  conversation_id: string;
}

/** The sole validator allowed to unlock caller-selected trace event identities. */
export class ConversationMessageQueueTraceAuthorityV1 {
  private readonly issued = new WeakSet<ConversationQueuedMessageDeliveryAuthorityV1>();
  private readonly active = new Map<string, ActiveQueuedTraceAuthorityV1>();

  constructor(traceStore: TraceStore) {
    const bind = traceStore.bindRequestedEventAuthority;
    if (!bind) throw new Error("trace requested event authority is unavailable");
    bind.call(traceStore, (input) => this.assertTraceAppend(input));
  }

  issue(
    claim: PrivateConversationMessageQueueClaimV1,
    beforeAppend: (conversationId: string, messageKey: string) => void = () => undefined,
  ): ConversationQueuedMessageDeliveryAuthorityV1 {
    const token = new ConversationQueuedMessageDeliveryAuthorityV1(
      this,
      structuredClone(claim),
      beforeAppend,
    );
    this.issued.add(token);
    return token;
  }

  activate(token: ConversationQueuedMessageDeliveryAuthorityV1, conversationId: string): void {
    if (!this.issued.has(token)) throw new Error("queued trace authority was not issued here");
    const prior = this.active.get(token.operationId);
    if (
      prior &&
      (prior.conversation_id !== conversationId || !same(prior.token.claim, token.claim))
    )
      throw new Error("queued trace operation authority changed");
    this.active.set(token.operationId, { token, conversation_id: conversationId });
  }

  settle(token: ConversationQueuedMessageDeliveryAuthorityV1): void {
    const prior = this.active.get(token.operationId);
    if (prior?.token === token) this.active.delete(token.operationId);
  }

  private assertTraceAppend(input: TraceRequestedEventAppendV1): void {
    const selected = this.active.get(input.correlation.operation_id);
    if (!selected) throw new Error("queued trace append authority is absent");
    const token = selected.token;
    const item = token.claim.item;
    if (
      input.native !== null ||
      input.requested_event_id !== token.publicEventId ||
      input.correlation.conversation_id !== selected.conversation_id ||
      input.input.idempotency_key !== token.messageKey ||
      input.input.event.type !== "user_message" ||
      input.input.event.payload.content !== item.content ||
      !same(input.input.event.payload.target_participants, item.target_participants) ||
      !same(input.input.event.payload.quote_refs ?? [], item.quote_refs)
    )
      throw new Error("queued trace append authority changed");
  }
}
