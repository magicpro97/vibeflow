import type { PublicStoredTraceEvent } from "../trace/types.js";
import { projectConversationEvents, rehydrateConversation } from "./policy-registry.js";
import type { ConversationRuntimeOptions } from "./runtime-options.js";
import { readConversationSnapshot } from "./runtime-snapshot.js";
import type { ConversationSnapshot } from "./types.js";

export function createConversationRuntimeReaders(options: ConversationRuntimeOptions): {
  events(id: string, afterSeq: number): Promise<PublicStoredTraceEvent[] | null>;
  rehydrate(id: string): ReturnType<typeof rehydrateConversation>;
  snapshot(id: string): Promise<ConversationSnapshot | null>;
} {
  return {
    events: async (id, afterSeq) => {
      if (!options.artifactStore.has(id)) return null;
      const records = options.traceStore.recoverConversation
        ? await options.traceStore.recoverConversation(id)
        : await options.traceStore.readConversation(id);
      return projectConversationEvents(records, id, options.artifactRegistry, afterSeq);
    },
    rehydrate: (id) => rehydrateConversation(id, options.artifactStore, options.rehydrateBinding),
    snapshot: (id) => readConversationSnapshot(id, options),
  };
}
