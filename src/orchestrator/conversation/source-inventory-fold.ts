import type {
  ConversationHealth,
  ConversationLifecycle,
  InternalTraceStoreRecord,
  PublicStoredTraceEvent,
} from "../trace/types.js";
import type { ConversationArtifactEntry } from "./artifact-store.js";
import { reviewedActionEventIds } from "./conversation-reviewed-action.js";
import type { ConversationReviewedActionAuthorityV1 } from "./conversation-reviewed-action.js";
import { foldConversation } from "./fold.js";

export function foldConversationJournal(
  records: readonly InternalTraceStoreRecord[],
  artifactRoot: string,
  artifacts: readonly ConversationArtifactEntry[],
  actionAuthority?: ConversationReviewedActionAuthorityV1,
): {
  lifecycle: ConversationLifecycle;
  health: ConversationHealth;
} {
  const projected = records.map((record) => {
    const stored = structuredClone(record.stored_event) as unknown as Record<string, unknown>;
    const event = stored.event as { type: string; payload: Record<string, unknown> };
    if (event.type === "capability_action_projection") {
      stored.event = { type: "coordinator_decision", payload: { projection_only: true } };
    }
    const publicSessionRef =
      record.native_session_id === null
        ? null
        : event.type === "native_history_reconciled" &&
            typeof event.payload.public_session_ref === "string"
          ? event.payload.public_session_ref
          : "vf-fold-session";
    return { ...stored, public_session_ref: publicSessionRef } as unknown as PublicStoredTraceEvent;
  });
  const folded = foldConversation(
    projected,
    reviewedActionEventIds(artifactRoot, actionAuthority, artifacts, records),
  );
  return { lifecycle: folded.lifecycle, health: folded.health };
}
