import type { ConversationRevisionAuthority } from "./revision-authority.js";
import type { ConversationSnapshot, MessageRequest, MessageResponse } from "./types.js";

export async function continueTerminalConversationMessage(input: {
  revisions: ConversationRevisionAuthority;
  conversationId: string;
  snapshot: ConversationSnapshot;
  request: MessageRequest & { target_participants: "all" | string[] };
  messageKey: string;
}): Promise<MessageResponse> {
  const child = await input.revisions.continueMessage(
    input.conversationId,
    input.snapshot,
    input.request,
    input.messageKey,
  );
  return {
    message_id: input.messageKey,
    accepted: true,
    child_conversation_id: child,
    location: `/api/conversations/${child}`,
  };
}
