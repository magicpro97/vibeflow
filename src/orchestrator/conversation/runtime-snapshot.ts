import type { ArtifactRegistry } from "../trace/artifacts.js";
import type { TraceStore } from "../trace/store.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { reviewedActionEventIds } from "./conversation-reviewed-action.js";
import { foldConversation } from "./fold.js";
import { projectConversationEvents } from "./policy-registry.js";
import type { ConversationSnapshot } from "./types.js";

export async function readConversationSnapshot(
  id: string,
  options: {
    traceStore: TraceStore;
    artifactRegistry: ArtifactRegistry;
    artifactStore: ConversationArtifactStore;
    homeAuthorities?: ConversationHomeAuthorities;
  },
): Promise<ConversationSnapshot | null> {
  if (!options.artifactStore.has(id)) return null;
  const records = options.traceStore.recoverConversation
    ? await options.traceStore.recoverConversation(id)
    : await options.traceStore.readConversation(id);
  const events = projectConversationEvents(records, id, options.artifactRegistry, 0);
  const artifacts = options.artifactStore.readRecord(id)?.artifacts ?? [];
  return events.length
    ? foldConversation(
        events,
        reviewedActionEventIds(
          options.artifactStore.rootPath(),
          options.homeAuthorities?.reviewedActionAuthority(),
          artifacts,
          records,
        ),
      )
    : null;
}
