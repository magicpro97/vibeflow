import {
  ConversationLineageNotFoundError,
  type ConversationLineageService,
} from "../orchestrator/conversation/lineage-service.js";
import { LineageAuthorityCorruptError } from "../orchestrator/conversation/lineage-store.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";
import { conversationReadError } from "./conversation-list-route.js";

export interface ConversationHeadRouteAuthority {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  lineage: Pick<ConversationLineageService, "head">;
}

export async function handleConversationHeadRoute(
  authority: ConversationHeadRouteAuthority,
  request: Request,
  rootSessionId: string,
): Promise<Response> {
  if (!authority.sessions.authorize(request))
    return conversationReadError("unauthenticated", { message: "Authentication is required." });
  if (request.method !== "GET")
    return conversationReadError("not_found", { message: "The requested resource was not found." });
  try {
    const body = authority.lineage.head(rootSessionId);
    return Response.json(body, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ConversationLineageNotFoundError)
      return conversationReadError("not_found", {
        message: "The conversation head was not found for this root session.",
      });
    if (error instanceof LineageAuthorityCorruptError)
      return conversationReadError("authority_corrupt", {
        message: "Conversation head authority is corrupt.",
        recoveryAction: "repair-authority",
      });
    return conversationReadError("service_unavailable", {
      message: "The conversation head is unavailable.",
      retryable: true,
      recoveryAction: "retry",
    });
  }
}
