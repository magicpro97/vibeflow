import type { ConversationMessageQueueRuntimeV1 } from "./conversation-message-queue-runtime.js";
import type { ConversationExecutionRuntime } from "./service-execution-runtime.js";

/** Wakes durable queue recovery only after ordinary execution reaches its final boundary. */
export class ConversationServiceQueueWakeV1 {
  constructor(
    private readonly execution: ConversationExecutionRuntime,
    private readonly queue: () => ConversationMessageQueueRuntimeV1 | null,
  ) {}

  async execute(
    manifest: Parameters<ConversationExecutionRuntime["execute"]>[0],
    operationId: string,
  ) {
    try {
      return await this.execution.execute(manifest, operationId);
    } finally {
      this.wake(manifest.conversation_id);
    }
  }

  async settle<T>(conversationId: string, pending: Promise<T>): Promise<T> {
    try {
      return await pending;
    } finally {
      this.wake(conversationId);
    }
  }

  wake(conversationId: string): void {
    const queue = this.queue();
    const root = queue?.rootSessionId(conversationId);
    if (root) queue?.kick(root);
  }
}
