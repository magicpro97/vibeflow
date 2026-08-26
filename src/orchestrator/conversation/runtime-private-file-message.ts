import type { ConversationQueuedMessageDeliveryAuthorityV1 } from "./conversation-message-queue-trace-authority.js";
import type { LiveConversation } from "./lifecycle-gate.js";
import { durableTraceEventAuthority } from "./private-file-range-commit-authority.js";
import type { ConversationRuntimeOptions } from "./runtime-options.js";
import type { MessageRequest } from "./types.js";

interface RuntimeUserMessageRequest {
  options: ConversationRuntimeOptions;
  live?: LiveConversation;
  conversationId: string;
  request: MessageRequest;
  messageKey: string;
  queueDelivery?: ConversationQueuedMessageDeliveryAuthorityV1;
  append(): Promise<unknown>;
}

/** Publishes one user message with its single-use private file-range authority, when present. */
export async function publishRuntimeUserMessage({
  options,
  live,
  conversationId,
  request,
  messageKey,
  queueDelivery,
  append,
}: RuntimeUserMessageRequest): Promise<void> {
  if (queueDelivery) {
    queueDelivery.assertChild(conversationId);
    queueDelivery.assertRequest(
      request as MessageRequest & { target_participants: "all" | string[] },
      messageKey,
    );
    if (live?.operationId !== queueDelivery.operationId)
      throw new Error("queued message operation authority changed");
  }
  const privateFileRange = request.private_file_range;
  const home = options.homeAuthorities;
  if (!privateFileRange || !home || !live) {
    await append();
    return;
  }
  const recordedAt = options.now?.() ?? new Date().toISOString();
  const targetParticipantIds =
    request.target_participants && request.target_participants !== "all"
      ? [...request.target_participants]
      : live.manifest.bindings.map((binding) => binding.participant_id);
  home.privateFileRanges.reserve(privateFileRange, messageKey, recordedAt);
  let publicMessageCommitted = false;
  try {
    home.privateTurnContexts.writeMessage({
      conversationId,
      messageKey,
      targetParticipantIds,
      createdAt: recordedAt,
      handoff: privateFileRange,
      fileRange: home.privateFileRanges.content(privateFileRange),
    });
    await append();
    publicMessageCommitted = true;
    home.privateFileRanges.consume(
      privateFileRange,
      messageKey,
      `conversation:${conversationId}:message:${messageKey}`,
      recordedAt,
    );
  } catch (error) {
    const authority = publicMessageCommitted
      ? "committed"
      : await durableTraceEventAuthority(
          options.traceStore,
          conversationId,
          messageKey,
          "user_message",
        );
    if (authority === "committed") {
      try {
        home.privateFileRanges.consume(
          privateFileRange,
          messageKey,
          `conversation:${conversationId}:message:${messageKey}`,
          recordedAt,
        );
      } catch {
        /* committed delivery remains reserved or consumed, never reusable */
      }
    } else if (authority === "proven-absent") {
      try {
        home.privateFileRanges.release(privateFileRange, messageKey, recordedAt);
      } catch {
        /* keep the original failure */
      }
    }
    /* unknown durable state stays reserved and fails closed */
    throw error;
  }
}
