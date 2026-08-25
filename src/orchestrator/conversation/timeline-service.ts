import { assertPublicProjectionSafe } from "../../actions/public-safety.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import type { ArtifactRegistry } from "../trace/artifacts.js";
import type { PublicStoredTraceEvent } from "../trace/types.js";
import { CatalogCursorError } from "./catalog-cursor.js";
import type { TimelineCursorCodec, TimelineCursorTupleV1 } from "./catalog-timeline-cursor.js";
import type {
  ConversationInteractionProjectionV1,
  ConversationTimelineInteractionV1,
} from "./conversation-interaction-types.js";
import type {
  ConversationLineageService,
  ResolvedConversationLineageV1,
} from "./lineage-service.js";
import { LineageAuthorityCorruptError } from "./lineage-store.js";
import {
  type LineageHeadRecordV1,
  type LineageNodeIdentityV1,
  assertLineageNodeIdentityV1,
  isLineageDigest,
} from "./lineage-types.js";
import { projectConversationEvents } from "./policy-registry.js";
import {
  type AnchoredActionOperationsPageV1,
  assertTimelineActionOperations,
  emptyTimelineActionOperations,
} from "./timeline-action-operations.js";
import { timelineInteractionProjection } from "./timeline-interaction-projection.js";

export type { AnchoredActionOperationsPageV1 } from "./timeline-action-operations.js";

const HANDOFF_ID = /^vf-handoff-[0-9a-f]{64}$/;
const bytewise = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

export interface RevisionBoundaryAuthorityV1 {
  from: LineageNodeIdentityV1;
  to: LineageNodeIdentityV1;
  handoff_id: string;
  prompt_projection_digest: string;
}

export type ConversationTimelineItemV1 =
  | {
      kind: "revision-boundary";
      boundary_id: string;
      from: LineageNodeIdentityV1;
      to: LineageNodeIdentityV1;
      handoff_id: string;
      prompt_projection_digest: string;
    }
  | {
      kind: "conversation-start";
      revision_ordinal: number;
      conversation_id: string;
      revision_id: string;
      anchor_id: string;
      action_operations: AnchoredActionOperationsPageV1;
    }
  | {
      kind: "conversation-event";
      revision_ordinal: number;
      event: PublicStoredTraceEvent;
      interaction: ConversationTimelineInteractionV1;
      action_operations: AnchoredActionOperationsPageV1;
    };

export interface ConversationTimelineResponseV1 {
  schema_version: "1.0";
  root_session_id: string;
  head: LineageNodeIdentityV1;
  head_epoch: number;
  head_digest: string;
  items: ConversationTimelineItemV1[];
  next_cursor: string | null;
}

export class TimelineHeadUnresolvedError extends Error {
  readonly code = "lineage_head_unresolved" as const;
  constructor(
    readonly root_session_id: string,
    readonly head_status: "ambiguous" | "unclaimed",
    readonly candidate_heads: LineageNodeIdentityV1[],
    readonly head_digest: string,
    readonly head_epoch: number,
  ) {
    super("lineage head is unresolved");
    this.name = "TimelineHeadUnresolvedError";
  }
}

export class TimelineAuthorityCorruptError extends LineageAuthorityCorruptError {
  constructor(message: string) {
    super(message);
    this.name = "TimelineAuthorityCorruptError";
  }
}

type MaybePromise<T> = T | Promise<T>;
type ActionAnchorV1 = {
  conversation_id: string;
  revision_id: string;
  origin_event_id: string | null;
};

export interface ConversationTimelineServiceOptions {
  scopeId: string;
  cursorCodec: TimelineCursorCodec;
  lineage: Pick<ConversationLineageService, "resolve">;
  artifactRegistry: ArtifactRegistry;
  boundary?(
    from: LineageNodeIdentityV1,
    to: LineageNodeIdentityV1,
  ): MaybePromise<RevisionBoundaryAuthorityV1 | null>;
  actionOperations?(anchor: ActionAnchorV1): MaybePromise<AnchoredActionOperationsPageV1>;
  interactionProjection?(
    conversationId: string,
    recipientPublicId: string | null,
  ): ConversationInteractionProjectionV1;
}

type BaseItem =
  | { tuple: TimelineCursorTupleV1; kind: "boundary"; value: ConversationTimelineItemV1 }
  | {
      tuple: TimelineCursorTupleV1;
      kind: "start" | "event";
      anchor: ActionAnchorV1;
      value:
        | Omit<
            Extract<ConversationTimelineItemV1, { kind: "conversation-start" }>,
            "action_operations"
          >
        | Omit<
            Extract<ConversationTimelineItemV1, { kind: "conversation-event" }>,
            "action_operations"
          >;
    };

function compareTuple(left: TimelineCursorTupleV1, right: TimelineCursorTupleV1): number {
  return (
    left.revision_ordinal - right.revision_ordinal ||
    left.item_kind_order - right.item_kind_order ||
    left.public_sequence - right.public_sequence ||
    bytewise(left.item_id, right.item_id)
  );
}

function sameNode(left: LineageNodeIdentityV1, right: LineageNodeIdentityV1): boolean {
  return (
    left.conversation_id === right.conversation_id &&
    left.revision_id === right.revision_id &&
    left.revision_ordinal === right.revision_ordinal
  );
}

function committedHead(resolved: ResolvedConversationLineageV1): LineageHeadRecordV1 & {
  active: LineageNodeIdentityV1;
  head_status: "committed";
} {
  const { head } = resolved;
  if (head.head_status !== "committed" || head.active === null) {
    if (head.head_status === "committed")
      throw new TimelineAuthorityCorruptError("committed lineage head is absent");
    throw new TimelineHeadUnresolvedError(
      resolved.lineage.root_session_id,
      head.head_status,
      structuredClone(head.candidate_heads),
      head.content_digest,
      head.head_epoch,
    );
  }
  return head as LineageHeadRecordV1 & {
    active: LineageNodeIdentityV1;
    head_status: "committed";
  };
}

function startAnchor(rootSessionId: string, node: LineageNodeIdentityV1): string {
  return `vf-conversation-start-${digestHex(
    digestV1("VF-CONVERSATION-START-ANCHOR\0v1\0", {
      schema_version: "1.0",
      root_session_id: rootSessionId,
      conversation_id: node.conversation_id,
      revision_id: node.revision_id,
      revision_ordinal: node.revision_ordinal,
    }),
  )}`;
}

function boundaryItem(
  rootSessionId: string,
  authority: RevisionBoundaryAuthorityV1,
): Extract<ConversationTimelineItemV1, { kind: "revision-boundary" }> {
  assertLineageNodeIdentityV1(authority.from);
  assertLineageNodeIdentityV1(authority.to);
  if (
    !HANDOFF_ID.test(authority.handoff_id) ||
    !isLineageDigest(authority.prompt_projection_digest)
  )
    throw new TimelineAuthorityCorruptError("invalid revision boundary authority");
  const boundaryId = `vf-revision-boundary-${digestHex(
    digestV1("VF-REVISION-BOUNDARY-ID\0v1\0", {
      root_session_id: rootSessionId,
      from: authority.from,
      to: authority.to,
      handoff_id: authority.handoff_id,
      prompt_projection_digest: authority.prompt_projection_digest,
    }),
  )}`;
  return {
    kind: "revision-boundary",
    boundary_id: boundaryId,
    from: structuredClone(authority.from),
    to: structuredClone(authority.to),
    handoff_id: authority.handoff_id,
    prompt_projection_digest: authority.prompt_projection_digest,
  };
}

export class ConversationTimelineService {
  constructor(private readonly options: ConversationTimelineServiceOptions) {}

  private async baseItems(
    resolved: ResolvedConversationLineageV1,
    interactions?: ConversationInteractionProjectionV1,
  ): Promise<BaseItem[]> {
    const items: BaseItem[] = [];
    for (const [index, revision] of resolved.selected_nodes.entries()) {
      const identity = revision.node;
      if (index > 0) {
        const prior = resolved.selected_nodes[index - 1];
        if (!prior || !this.options.boundary)
          throw new TimelineAuthorityCorruptError("revision boundary authority is absent");
        const authority = await this.options.boundary(prior.node, identity);
        if (
          !authority ||
          !sameNode(authority.from, prior.node) ||
          !sameNode(authority.to, identity)
        )
          throw new TimelineAuthorityCorruptError(
            "revision boundary does not bind selected ancestry",
          );
        const value = boundaryItem(resolved.lineage.root_session_id, authority);
        items.push({
          kind: "boundary",
          value,
          tuple: {
            revision_ordinal: identity.revision_ordinal,
            item_kind_order: 0,
            public_sequence: 0,
            item_id: value.boundary_id,
          },
        });
      }
      const anchorId = startAnchor(resolved.lineage.root_session_id, identity);
      const anchor = {
        conversation_id: identity.conversation_id,
        revision_id: identity.revision_id,
        origin_event_id: null,
      };
      items.push({
        kind: "start",
        anchor,
        value: {
          kind: "conversation-start",
          revision_ordinal: identity.revision_ordinal,
          conversation_id: identity.conversation_id,
          revision_id: identity.revision_id,
          anchor_id: anchorId,
        },
        tuple: {
          revision_ordinal: identity.revision_ordinal,
          item_kind_order: 1,
          public_sequence: 0,
          item_id: anchorId,
        },
      });
      const semanticRecords = revision.source.journal_records.filter(
        ({ stored_event }) =>
          (stored_event.event as { type: string }).type !== "capability_action_projection",
      );
      const events = projectConversationEvents(
        semanticRecords,
        identity.conversation_id,
        this.options.artifactRegistry,
        0,
      );
      for (const event of events) {
        items.push({
          kind: "event",
          anchor: {
            conversation_id: identity.conversation_id,
            revision_id: identity.revision_id,
            origin_event_id: event.event_id,
          },
          value: {
            kind: "conversation-event",
            revision_ordinal: identity.revision_ordinal,
            event,
            interaction: timelineInteractionProjection(event.event_id, interactions),
          },
          tuple: {
            revision_ordinal: identity.revision_ordinal,
            item_kind_order: 2,
            public_sequence: event.seq,
            item_id: event.event_id,
          },
        });
      }
    }
    items.sort((left, right) => compareTuple(left.tuple, right.tuple));
    for (let index = 1; index < items.length; index++) {
      const previous = items[index - 1];
      const current = items[index];
      if (!previous || !current)
        throw new TimelineAuthorityCorruptError("timeline item ordering is incomplete");
      if (compareTuple(previous.tuple, current.tuple) === 0)
        throw new TimelineAuthorityCorruptError("timeline authority has a duplicate item tuple");
    }
    return items;
  }

  private async hydrate(item: BaseItem): Promise<ConversationTimelineItemV1> {
    if (item.kind === "boundary") return structuredClone(item.value);
    const operations = this.options.actionOperations
      ? await this.options.actionOperations(item.anchor)
      : emptyTimelineActionOperations(item.anchor);
    assertTimelineActionOperations(operations, (message) => {
      throw new TimelineAuthorityCorruptError(message);
    });
    return { ...structuredClone(item.value), action_operations: structuredClone(operations) } as
      | Extract<ConversationTimelineItemV1, { kind: "conversation-start" }>
      | Extract<ConversationTimelineItemV1, { kind: "conversation-event" }>;
  }

  async read(
    rootSessionId: string,
    input: { cursor?: string; limit?: number; recipient_public_id?: string } = {},
  ): Promise<ConversationTimelineResponseV1> {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new CatalogCursorError("invalid_cursor", "invalid timeline page size");
    const resolved = this.options.lineage.resolve(rootSessionId);
    if (resolved.lineage.root_session_id !== rootSessionId)
      throw new TimelineAuthorityCorruptError("timeline request does not name the lineage root");
    const head = committedHead(resolved);
    const selectedHead = resolved.selected_nodes.at(-1);
    if (!selectedHead || !sameNode(selectedHead.node, head.active))
      throw new TimelineAuthorityCorruptError(
        "timeline selected ancestry does not end at the head",
      );
    const all = await this.baseItems(
      resolved,
      this.options.interactionProjection?.(
        head.active.conversation_id,
        input.recipient_public_id ?? null,
      ),
    );
    const binding = {
      scope_id: this.options.scopeId,
      root_session_id: rootSessionId,
      head: head.active,
      head_digest: head.content_digest,
      head_epoch: head.head_epoch,
      limit,
      last: null,
    };
    let start = 0;
    if (input.cursor) {
      const last = this.options.cursorCodec.validate(input.cursor, binding);
      if (last) {
        const match = all.findIndex((item) => compareTuple(item.tuple, last) === 0);
        if (match < 0)
          throw new CatalogCursorError("invalid_cursor", "timeline cursor boundary is unavailable");
        start = match + 1;
      }
    }
    const page = all.slice(start, start + limit);
    const items = await Promise.all(page.map((item) => this.hydrate(item)));
    const last = page.at(-1);
    const response: ConversationTimelineResponseV1 = {
      schema_version: "1.0",
      root_session_id: rootSessionId,
      head: structuredClone(head.active),
      head_epoch: head.head_epoch,
      head_digest: head.content_digest,
      items,
      next_cursor:
        last && start + page.length < all.length
          ? this.options.cursorCodec.encode({ ...binding, last: last.tuple })
          : null,
    };
    assertPublicProjectionSafe(response, "$.timeline", { maxBytes: 16 * 1024 * 1024 });
    return response;
  }
}
