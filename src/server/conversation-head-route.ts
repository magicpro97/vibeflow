import { PUBLIC_ERROR_CODE, PUBLIC_RECOVERY_ACTION } from "../actions/public-error-contract.js";
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
    return conversationReadError(PUBLIC_ERROR_CODE.UNAUTHENTICATED, {
      message: "Authentication is required.",
    });
  if (request.method !== "GET")
    return conversationReadError(PUBLIC_ERROR_CODE.NOT_FOUND, {
      message: "The requested resource was not found.",
    });
  try {
    const body = authority.lineage.head(rootSessionId);
    return Response.json(body, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ConversationLineageNotFoundError)
      return conversationReadError(PUBLIC_ERROR_CODE.NOT_FOUND, {
        message: "The conversation head was not found for this root session.",
      });
    if (error instanceof LineageAuthorityCorruptError)
      return conversationReadError(PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT, {
        message: "Conversation head authority is corrupt.",
        recoveryAction: PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY,
      });
    return conversationReadError(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE, {
      message: "The conversation head is unavailable.",
      retryable: true,
      recoveryAction: PUBLIC_RECOVERY_ACTION.RETRY,
    });
  }
}
