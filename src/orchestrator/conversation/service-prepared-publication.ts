import type { PublicStoredTraceEvent } from "../trace/types.js";
import type { ConversationSubscribers } from "./policy-registry.js";

/** Holds pre-manifest trace notifications until the prepared root is visible. */
export class ConversationPreparedSourcePublicationV1 {
  private readonly events = new Map<string, PublicStoredTraceEvent[]>();

  constructor(
    private readonly subscribers: ConversationSubscribers,
    private readonly committed?: (event: PublicStoredTraceEvent) => void,
  ) {}

  readonly authority = {
    begin: (conversationId: string): void => {
      if (this.events.has(conversationId))
        throw new Error("prepared conversation publication is already active");
      this.events.set(conversationId, []);
    },
    commit: (conversationId: string, fallback: PublicStoredTraceEvent | null): void => {
      const events = this.events.get(conversationId);
      const source = events?.at(-1) ?? fallback;
      if (!events || !source) throw new Error("prepared conversation journal is absent");
      for (const event of events) this.subscribers.notify(event);
      this.committed?.(source);
      this.events.delete(conversationId);
    },
    abort: (conversationId: string): void => {
      this.events.delete(conversationId);
    },
  };

  append(event: PublicStoredTraceEvent): void {
    const prepared = this.events.get(event.conversation_id);
    if (prepared) {
      prepared.push(event);
      return;
    }
    this.subscribers.notify(event);
    this.committed?.(event);
  }
}
