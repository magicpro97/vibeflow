import type { PublicStoredTraceEvent } from "../trace/types.js";

export class ConversationAppendNotifier {
  private readonly listeners = new Set<(event: PublicStoredTraceEvent) => void>();

  subscribe(listener: (event: PublicStoredTraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event: PublicStoredTraceEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        void error;
      }
    }
  }
}
