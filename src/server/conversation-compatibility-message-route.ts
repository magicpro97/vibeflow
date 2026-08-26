import { validateIdempotencyKey } from "../actions/idempotency.js";
import type { PublicQueuedUserMessageV1 } from "../orchestrator/conversation/conversation-message-queue-records.js";
import type { MessageRequest, MessageResponse } from "../orchestrator/conversation/types.js";
import {
  invalidQueueRequest,
  messageQueueRouteError,
  queueNoStore,
  queuePrincipal,
  strictQueueBody,
} from "./conversation-message-queue-http.js";
import type { ConversationMessageQueueHttpAuthorityV1 } from "./conversation-message-queue-route.js";
import { decodeConversationMessageRequest } from "./conversation-message-request.js";

export interface ConversationCompatibilityMessageAuthorityV1 {
  principal?: ConversationMessageQueueHttpAuthorityV1["principal"];
  queue: {
    resolveCommittedConversation(conversationId: string): { root_session_id: string };
    enqueueCompatibility(
      conversationId: string,
      principalDigest: string,
      idempotencyKey: string,
      request: MessageRequest,
    ):
      | { item: PublicQueuedUserMessageV1; replayed: boolean }
      | Promise<{ item: PublicQueuedUserMessageV1; replayed: boolean }>;
    item(rootSessionId: string, queueItemId: string): PublicQueuedUserMessageV1 | null;
  };
}

function idempotencyHeader(request: Request): string | null {
  const raw = request.headers.get("idempotency-key");
  if (!raw || raw.includes(",")) return null;
  try {
    return validateIdempotencyKey(raw);
  } catch {
    return null;
  }
}

/** Former direct message route, now a bounded admission-only compatibility facade. */
export async function handleConversationCompatibilityMessageRoute(
  authority: ConversationCompatibilityMessageAuthorityV1,
  request: Request,
  conversationId: string,
): Promise<Response> {
  const idempotencyKey = idempotencyHeader(request);
  if (!idempotencyKey) return invalidQueueRequest();
  try {
    const body = await strictQueueBody(request);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.hasOwn(body, "private_file_range")
    )
      return invalidQueueRequest();
    const input = decodeConversationMessageRequest(body as Record<string, unknown>);
    if (!input || input.private_file_range) return invalidQueueRequest();
    const rootSessionId =
      authority.queue.resolveCommittedConversation(conversationId).root_session_id;
    const result = await authority.queue.enqueueCompatibility(
      conversationId,
      queuePrincipal(authority, request, rootSessionId),
      idempotencyKey,
      input,
    );
    const response: MessageResponse = {
      message_id: result.item.queue_item_id,
      accepted: true,
    };
    return queueNoStore(response, 202);
  } catch (error) {
    let rootSessionId: string | undefined;
    try {
      rootSessionId = authority.queue.resolveCommittedConversation(conversationId).root_session_id;
    } catch {
      rootSessionId = undefined;
    }
    return messageQueueRouteError(error, authority, rootSessionId);
  }
}
