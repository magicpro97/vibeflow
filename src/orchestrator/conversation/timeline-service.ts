import { PUBLIC_ERROR_CODE } from "../../actions/public-error-contract.js";
import { assertPublicProjectionSafe } from "../../actions/public-safety.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import { CatalogCursorError } from "./catalog-cursor.js";
import type { TimelineCursorCodec, TimelineCursorTupleV1 } from "./catalog-timeline-cursor.js";
import {
  CONVERSATION_CATALOG_SCHEMA_VERSION,
  CONVERSATION_CURSOR_ERROR_CODE,
  CONVERSATION_HEAD_STATUS,
  CONVERSATION_TIMELINE_ITEM_KIND,
  type ConversationUnresolvedHeadStatus,
} from "./conversation-catalog-contract.js";
import type {
  ConversationInteractionProjectionV1,
  ConversationTimelineInteractionV1,
} from "./conversation-interaction-types.js";
import type { ResolvedConversationLineageV1 } from "./lineage-service.js";
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
import type {
  ConversationTimelineItemV1,
  ConversationTimelineResponseV1,
  ConversationTimelineServiceOptions,
  RevisionBoundaryAuthorityV1,
  TimelineBaseItem,
} from "./timeline-service-contract.js";

export type { AnchoredActionOperationsPageV1 } from "./timeline-action-operations.js";
export type {
  ConversationTimelineItemV1,
  ConversationTimelineResponseV1,
  ConversationTimelineServiceOptions,
  RevisionBoundaryAuthorityV1,
} from "./timeline-service-contract.js";

const HANDOFF_ID = /^vf-handoff-[0-9a-f]{64}$/;
const bytewise = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

export class TimelineHeadUnresolvedError extends Error {
  readonly code = PUBLIC_ERROR_CODE.LINEAGE_HEAD_UNRESOLVED;
  constructor(
    readonly root_session_id: string,
    readonly head_status: ConversationUnresolvedHeadStatus,
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
  head_status: typeof CONVERSATION_HEAD_STATUS.COMMITTED;
} {
  const { head } = resolved;
  if (head.head_status !== CONVERSATION_HEAD_STATUS.COMMITTED || head.active === null) {
    if (head.head_status === CONVERSATION_HEAD_STATUS.COMMITTED)
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
    head_status: typeof CONVERSATION_HEAD_STATUS.COMMITTED;
  };
}

function startAnchor(rootSessionId: string, node: LineageNodeIdentityV1): string {
  return `vf-conversation-start-${digestHex(
    digestV1("VF-CONVERSATION-START-ANCHOR\0v1\0", {
      schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
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
): Extract<
  ConversationTimelineItemV1,
  { kind: typeof CONVERSATION_TIMELINE_ITEM_KIND.REVISION_BOUNDARY }
> {
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
    kind: CONVERSATION_TIMELINE_ITEM_KIND.REVISION_BOUNDARY,
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
  ): Promise<TimelineBaseItem[]> {
    const items: TimelineBaseItem[] = [];
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
          kind: CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_START,
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
            kind: CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_EVENT,
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

  private async hydrate(item: TimelineBaseItem): Promise<ConversationTimelineItemV1> {
    if (item.kind === "boundary") return structuredClone(item.value);
    const operations = this.options.actionOperations
      ? await this.options.actionOperations(item.anchor)
      : emptyTimelineActionOperations(item.anchor);
    assertTimelineActionOperations(operations, (message) => {
      throw new TimelineAuthorityCorruptError(message);
    });
    return { ...structuredClone(item.value), action_operations: structuredClone(operations) } as
      | Extract<
          ConversationTimelineItemV1,
          { kind: typeof CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_START }
        >
      | Extract<
          ConversationTimelineItemV1,
          { kind: typeof CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_EVENT }
        >;
  }

  async read(
    rootSessionId: string,
    input: { cursor?: string; limit?: number; recipient_public_id?: string } = {},
  ): Promise<ConversationTimelineResponseV1> {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new CatalogCursorError(
        CONVERSATION_CURSOR_ERROR_CODE.INVALID_CURSOR,
        "invalid timeline page size",
      );
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
          throw new CatalogCursorError(
            CONVERSATION_CURSOR_ERROR_CODE.INVALID_CURSOR,
            "timeline cursor boundary is unavailable",
          );
        start = match + 1;
      }
    }
    const page = all.slice(start, start + limit);
    const items = await Promise.all(page.map((item) => this.hydrate(item)));
    const last = page.at(-1);
    const response: ConversationTimelineResponseV1 = {
      schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
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
