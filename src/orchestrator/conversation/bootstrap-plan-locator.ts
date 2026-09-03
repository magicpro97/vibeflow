import type { ConversationArtifactStore } from "./artifact-store.js";
import { CONVERSATION_ARTIFACT_TYPE } from "./conversation-public-wire-contract.js";
import type { PlanArtifact, PlanArtifactLocator } from "./services.js";
import type { ConversationContext } from "./types.js";

export function persistedPlanLocator(store: ConversationArtifactStore): PlanArtifactLocator {
  return (context: ConversationContext): PlanArtifact | null => {
    let conversationId: string | null = context.correlation.conversation_id;
    const visited = new Set<string>();
    while (conversationId && !visited.has(conversationId) && visited.size < 64) {
      visited.add(conversationId);
      const record = store.readRecord(conversationId);
      if (!record) return null;
      const plan = record.artifacts
        .filter((entry) => entry.artifact_type === CONVERSATION_ARTIFACT_TYPE.PLAN)
        .at(-1);
      if (plan) {
        return Object.freeze({
          artifact_id: plan.artifact_id,
          revision_id: record.manifest.revision_id,
          ref: plan.ref,
        });
      }
      conversationId = record.manifest.parent_conversation_id;
    }
    return null;
  };
}
