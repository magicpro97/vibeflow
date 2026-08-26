import type { ActionRequestAuthorityV1 } from "../actions/index.js";
import type { ConversationHomeCreateRequestV1 } from "../orchestrator/conversation/conversation-private-context-broker-types.js";
import { assertConversationHomeCreateRequestV1 } from "../orchestrator/conversation/conversation-private-context-broker-validation.js";
import type { ConversationCreateResponse } from "../orchestrator/conversation/types.js";
import type {
  ConversationSessionAuthority,
  ConversationStreamTokenAuthority,
} from "./conversation-auth.js";
import {
  authorizeMessageQueueRoute,
  messageQueueRouteError,
  queueNoStore,
  queuePrincipal,
  strictQueueBody,
} from "./conversation-message-queue-http.js";

export interface ConversationHomeCreateHttpResultV1 {
  conversation_id: string;
  replayed: boolean;
}

export interface ConversationHomeCreateHttpAuthorityV1 {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  csrf?(request: Request): boolean;
  principal?(request: Request, rootSessionId: string): ActionRequestAuthorityV1;
  streamTokens: Pick<ConversationStreamTokenAuthority, "issue">;
  create(input: {
    principal_digest: string;
    request: ConversationHomeCreateRequestV1;
  }): ConversationHomeCreateHttpResultV1 | Promise<ConversationHomeCreateHttpResultV1>;
}

/** Final Home create: closed V1 DTO, durable create broker, and fresh stream credential. */
export async function handleConversationHomeCreateRoute(
  authority: ConversationHomeCreateHttpAuthorityV1,
  request: Request,
): Promise<Response> {
  const denied = authorizeMessageQueueRoute(authority, request, true);
  if (denied) return denied;
  try {
    const body = await strictQueueBody(request);
    assertConversationHomeCreateRequestV1(body);
    const result = await authority.create({
      principal_digest: queuePrincipal(authority, request, "conversation-draft"),
      request: body,
    });
    const token = authority.streamTokens.issue(result.conversation_id);
    const response: ConversationCreateResponse = {
      conversation_id: result.conversation_id,
      ...token,
    };
    const output = queueNoStore(response, result.replayed ? 200 : 202);
    output.headers.set(
      "location",
      `/api/conversations/${encodeURIComponent(result.conversation_id)}`,
    );
    return output;
  } catch (error) {
    return messageQueueRouteError(error);
  }
}
