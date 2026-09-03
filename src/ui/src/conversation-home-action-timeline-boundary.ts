import type { ActionOperationsPageV1 } from "../../actions/public-types.js";
import {
  hasExactWireFields,
  isBoundedWireIdentity,
  isNonnegativeSafeWireInteger,
  isPlainWireRecord,
  isSha256WireDigest,
} from "../../actions/public-wire-primitives.js";
import {
  ACTION_OPERATIONS_PAGE_FIELDS,
  TIMELINE_BOUNDARY_FIELDS,
  TIMELINE_EVENT_FIELDS,
  TIMELINE_HEAD_FIELDS,
  TIMELINE_RESPONSE_FIELDS,
  TIMELINE_START_FIELDS,
} from "./conversation-home-action-boundary-fields.js";
import {
  assert,
  ACTION_TIMELINE_ITEM_KIND,
  PUBLIC_ACTION_SCHEMA_VERSION,
  assertExactRecord,
  nullableCursor,
} from "./conversation-home-action-boundary-shared.js";
import { parseActionOperation } from "./conversation-home-action-operation-boundary.js";
import type { HomeTimelineItem, HomeTimelineResponse } from "./conversation-home-types.js";

function parseLineageNode(value: unknown): void {
  const row = assertExactRecord(value, TIMELINE_HEAD_FIELDS, "invalid lineage node");
  assert(isBoundedWireIdentity(row.conversation_id), "invalid lineage conversation id");
  assert(isBoundedWireIdentity(row.revision_id), "invalid lineage revision id");
  assert(isNonnegativeSafeWireInteger(row.revision_ordinal), "invalid lineage revision ordinal");
}

function parseActionOperationsPage(value: unknown): ActionOperationsPageV1 {
  const row = assertExactRecord(
    value,
    ACTION_OPERATIONS_PAGE_FIELDS,
    "invalid action operations page",
  );
  assert(
    row.schema_version === PUBLIC_ACTION_SCHEMA_VERSION,
    "invalid action operations page schema version",
  );
  assert(Array.isArray(row.items), "invalid action operations page items");
  assert(nullableCursor(row.next_cursor), "invalid action operations page cursor");
  assert(isSha256WireDigest(row.proposal_set_watermark), "invalid action operations watermark");
  return {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    items: row.items.map(parseActionOperation),
    next_cursor: row.next_cursor,
    proposal_set_watermark: row.proposal_set_watermark,
  };
}

function normalizeTimelineItem(value: unknown): HomeTimelineItem {
  assert(isPlainWireRecord(value), "invalid timeline item");
  const row = value as Record<string, any>;
  if (row.kind === ACTION_TIMELINE_ITEM_KIND.REVISION_BOUNDARY) {
    assert(hasExactWireFields(row, TIMELINE_BOUNDARY_FIELDS), "invalid revision boundary item");
    parseLineageNode(row.from);
    parseLineageNode(row.to);
    assert(isBoundedWireIdentity(row.boundary_id), "invalid timeline boundary id");
    assert(isBoundedWireIdentity(row.handoff_id), "invalid timeline handoff id");
    assert(isSha256WireDigest(row.prompt_projection_digest), "invalid prompt projection digest");
    return structuredClone(row) as HomeTimelineItem;
  }
  if (row.kind === ACTION_TIMELINE_ITEM_KIND.CONVERSATION_START) {
    assert(hasExactWireFields(row, TIMELINE_START_FIELDS), "invalid conversation start item");
    assert(isNonnegativeSafeWireInteger(row.revision_ordinal), "invalid timeline revision ordinal");
    assert(isBoundedWireIdentity(row.conversation_id), "invalid timeline conversation id");
    assert(isBoundedWireIdentity(row.revision_id), "invalid timeline revision id");
    assert(isBoundedWireIdentity(row.anchor_id), "invalid timeline anchor id");
    const cloned = structuredClone(row) as Record<string, unknown>;
    return {
      ...(cloned as object),
      action_operations: parseActionOperationsPage(row.action_operations),
    } as HomeTimelineItem;
  }
  if (row.kind === ACTION_TIMELINE_ITEM_KIND.CONVERSATION_EVENT) {
    assert(hasExactWireFields(row, TIMELINE_EVENT_FIELDS), "invalid conversation event item");
    assert(isNonnegativeSafeWireInteger(row.revision_ordinal), "invalid timeline revision ordinal");
    const cloned = structuredClone(row) as Record<string, unknown>;
    return {
      ...(cloned as object),
      action_operations: parseActionOperationsPage(row.action_operations),
    } as HomeTimelineItem;
  }
  throw new Error("invalid timeline item kind");
}

export function parseHomeTimelineResponse(value: unknown): HomeTimelineResponse {
  const row = assertExactRecord(value, TIMELINE_RESPONSE_FIELDS, "invalid timeline response");
  assert(row.schema_version === PUBLIC_ACTION_SCHEMA_VERSION, "invalid timeline schema version");
  assert(isBoundedWireIdentity(row.root_session_id), "invalid timeline root session id");
  parseLineageNode(row.head);
  assert(isNonnegativeSafeWireInteger(row.head_epoch), "invalid timeline head epoch");
  assert(isSha256WireDigest(row.head_digest), "invalid timeline head digest");
  assert(Array.isArray(row.items), "invalid timeline items");
  assert(nullableCursor(row.next_cursor), "invalid timeline cursor");
  return {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    root_session_id: row.root_session_id,
    head: structuredClone(row.head) as HomeTimelineResponse["head"],
    head_epoch: row.head_epoch,
    head_digest: row.head_digest,
    items: row.items.map(normalizeTimelineItem),
    next_cursor: row.next_cursor,
  };
}
