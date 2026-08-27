import {
  CONVERSATION_HEALTH,
  CONVERSATION_TERMINAL_LIFECYCLE,
} from "./conversation-public-wire-contract.js";
import type { ConversationRuntime } from "./runtime.js";

export async function terminalFailedRevisionRuntime(
  runtime: ConversationRuntime,
  conversationId: string,
  reason: string,
): Promise<void> {
  const health = (await runtime.snapshot(conversationId))?.health ?? CONVERSATION_HEALTH.HEALTHY;
  await runtime.terminal(
    conversationId,
    CONVERSATION_TERMINAL_LIFECYCLE.FAILED,
    health,
    reason,
    null,
  );
  runtime.finish(conversationId);
}
