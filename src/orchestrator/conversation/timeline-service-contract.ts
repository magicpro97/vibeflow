import type { ArtifactRegistry } from "../trace/artifacts.js";
import type { PublicStoredTraceEvent } from "../trace/types.js";
import type { TimelineCursorCodec, TimelineCursorTupleV1 } from "./catalog-timeline-cursor.js";
import type {
  CONVERSATION_CATALOG_SCHEMA_VERSION,
  CONVERSATION_TIMELINE_ITEM_KIND,
} from "./conversation-catalog-contract.js";
import type {
  ConversationInteractionProjectionV1,
  ConversationTimelineInteractionV1,
} from "./conversation-interaction-types.js";
import type { ConversationLineageService } from "./lineage-service.js";
import type { LineageNodeIdentityV1 } from "./lineage-types.js";
import type { AnchoredActionOperationsPageV1 } from "./timeline-action-operations.js";

export interface RevisionBoundaryAuthorityV1 {
  from: LineageNodeIdentityV1;
  to: LineageNodeIdentityV1;
  handoff_id: string;
  prompt_projection_digest: string;
}

export type ConversationTimelineItemV1 =
  | {
      kind: typeof CONVERSATION_TIMELINE_ITEM_KIND.REVISION_BOUNDARY;
      boundary_id: string;
      from: LineageNodeIdentityV1;
      to: LineageNodeIdentityV1;
      handoff_id: string;
      prompt_projection_digest: string;
    }
  | {
      kind: typeof CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_START;
      revision_ordinal: number;
      conversation_id: string;
      revision_id: string;
      anchor_id: string;
      action_operations: AnchoredActionOperationsPageV1;
    }
  | {
      kind: typeof CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_EVENT;
      revision_ordinal: number;
      event: PublicStoredTraceEvent;
      interaction: ConversationTimelineInteractionV1;
      action_operations: AnchoredActionOperationsPageV1;
    };

export interface ConversationTimelineResponseV1 {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  root_session_id: string;
  head: LineageNodeIdentityV1;
  head_epoch: number;
  head_digest: string;
  items: ConversationTimelineItemV1[];
  next_cursor: string | null;
}

type MaybePromise<T> = T | Promise<T>;
export interface TimelineActionAnchorV1 {
  conversation_id: string;
  revision_id: string;
  origin_event_id: string | null;
}

export interface ConversationTimelineServiceOptions {
  scopeId: string;
  cursorCodec: TimelineCursorCodec;
  lineage: Pick<ConversationLineageService, "resolve">;
  artifactRegistry: ArtifactRegistry;
  boundary?(
    from: LineageNodeIdentityV1,
    to: LineageNodeIdentityV1,
  ): MaybePromise<RevisionBoundaryAuthorityV1 | null>;
  actionOperations?(anchor: TimelineActionAnchorV1): MaybePromise<AnchoredActionOperationsPageV1>;
  interactionProjection?(
    conversationId: string,
    recipientPublicId: string | null,
  ): ConversationInteractionProjectionV1;
}

export type TimelineBaseItem =
  | { tuple: TimelineCursorTupleV1; kind: "boundary"; value: ConversationTimelineItemV1 }
  | {
      tuple: TimelineCursorTupleV1;
      kind: "start" | "event";
      anchor: TimelineActionAnchorV1;
      value:
        | Omit<
            Extract<
              ConversationTimelineItemV1,
              { kind: typeof CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_START }
            >,
            "action_operations"
          >
        | Omit<
            Extract<
              ConversationTimelineItemV1,
              { kind: typeof CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_EVENT }
            >,
            "action_operations"
          >;
    };
