import { PUBLIC_ERROR_CODE, PUBLIC_RECOVERY_ACTION } from "../actions/public-error-contract.js";
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
    return conversationReadError(PUBLIC_ERROR_CODE.UNAUTHENTICATED, {
      message: "Authentication is required.",
    });
  if (request.method !== "GET")
    return conversationReadError(PUBLIC_ERROR_CODE.NOT_FOUND, {
      message: "The requested resource was not found.",
    });
  try {
    const value = await authority.handoff.read(conversationId);
    return value
      ? Response.json(value, { status: 200, headers: { "cache-control": "no-store" } })
      : conversationReadError(PUBLIC_ERROR_CODE.NOT_FOUND, {
          message: "The context handoff was not found.",
        });
  } catch (error) {
    if (error instanceof ConversationHandoffCorruptError)
      return conversationReadError(PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT, {
        message: "The context handoff authority is corrupt.",
        recoveryAction: PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY,
      });
    return conversationReadError(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE, {
      message: "The context handoff is unavailable.",
      retryable: true,
      recoveryAction: PUBLIC_RECOVERY_ACTION.RETRY,
    });
  }
}
