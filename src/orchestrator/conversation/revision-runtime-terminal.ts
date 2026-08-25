import type { ConversationRuntime } from "./runtime.js";

export async function terminalFailedRevisionRuntime(
  runtime: ConversationRuntime,
  conversationId: string,
  reason: string,
): Promise<void> {
  const health = (await runtime.snapshot(conversationId))?.health ?? "healthy";
  await runtime.terminal(conversationId, "FAILED", health, reason, null);
  runtime.finish(conversationId);
}
