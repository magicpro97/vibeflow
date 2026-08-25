import {
  ConversationHandoffCorruptError,
  type ConversationHandoffService,
} from "../orchestrator/conversation/conversation-handoff-service.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";
import { conversationReadError } from "./conversation-list-route.js";

export interface ConversationHandoffRouteAuthorityV1 {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  handoff: Pick<ConversationHandoffService, "read">;
}

export async function handleConversationHandoffRoute(
  authority: ConversationHandoffRouteAuthorityV1,
  request: Request,
  conversationId: string,
): Promise<Response> {
  if (!authority.sessions.authorize(request))
    return conversationReadError("unauthenticated", { message: "Authentication is required." });
  if (request.method !== "GET")
    return conversationReadError("not_found", { message: "The requested resource was not found." });
  try {
    const value = await authority.handoff.read(conversationId);
    return value
      ? Response.json(value, { status: 200, headers: { "cache-control": "no-store" } })
      : conversationReadError("not_found", { message: "The context handoff was not found." });
  } catch (error) {
    if (error instanceof ConversationHandoffCorruptError)
      return conversationReadError("authority_corrupt", {
        message: "The context handoff authority is corrupt.",
        recoveryAction: "repair-authority",
      });
    return conversationReadError("service_unavailable", {
      message: "The context handoff is unavailable.",
      retryable: true,
      recoveryAction: "retry",
    });
  }
}
