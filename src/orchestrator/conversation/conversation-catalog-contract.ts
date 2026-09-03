/** Dependency-free catalog and lineage vocabularies shared by server and browser DTOs. */
export const CONVERSATION_CATALOG_SCHEMA_VERSION = "1.0" as const;

export const CONVERSATION_CURSOR_ERROR_CODE = Object.freeze({
  INVALID_CURSOR: "invalid_cursor",
  BINDING_MISMATCH: "cursor_binding_mismatch",
  CONFLICTING_CURSOR: "conflicting_cursor",
} as const);
export type ConversationCursorErrorCode =
  (typeof CONVERSATION_CURSOR_ERROR_CODE)[keyof typeof CONVERSATION_CURSOR_ERROR_CODE];

export const CONVERSATION_CURSOR_KIND = Object.freeze({
  CATALOG: "conversation-catalog",
  LINEAGE: "conversation-lineage",
  TIMELINE: "conversation-timeline",
} as const);

export const CONVERSATION_CURSOR_SORT = Object.freeze({
  UPDATED_DESC_ROOT_DESC: "updated-desc-root-desc",
} as const);

export const CONVERSATION_CURSOR_VALIDATION_STATUS = Object.freeze({
  VALID: "valid",
  STALE: "stale",
} as const);

export const CONVERSATION_CATALOG_LOCK_IDENTITY = Object.freeze({
  OWNER_KIND: "authority",
  AUTHORITY_SCOPE: "conversation",
  JOURNAL_ENCODING: "conversation-jsonl-v1",
  LOGICAL_KEY_KIND: "conversation-journal",
  CAPABILITY_ACTION_PROJECTION_EVENT_KIND: "capability_action_projection",
} as const);

export const CONVERSATION_LINEAGE_STATUS = Object.freeze({
  VERIFIED: "verified",
  UNVERIFIED: "unverified",
} as const);
export type ConversationLineageStatus =
  (typeof CONVERSATION_LINEAGE_STATUS)[keyof typeof CONVERSATION_LINEAGE_STATUS];
export const CONVERSATION_LINEAGE_STATUSES = Object.freeze(
  Object.values(CONVERSATION_LINEAGE_STATUS),
) as readonly ConversationLineageStatus[];

export const CONVERSATION_HEAD_STATUS = Object.freeze({
  COMMITTED: "committed",
  AMBIGUOUS: "ambiguous",
  UNCLAIMED: "unclaimed",
} as const);
export type ConversationHeadStatus =
  (typeof CONVERSATION_HEAD_STATUS)[keyof typeof CONVERSATION_HEAD_STATUS];
export const CONVERSATION_HEAD_STATUSES = Object.freeze(
  Object.values(CONVERSATION_HEAD_STATUS),
) as readonly ConversationHeadStatus[];

export const CONVERSATION_UNRESOLVED_HEAD_STATUS = Object.freeze({
  AMBIGUOUS: CONVERSATION_HEAD_STATUS.AMBIGUOUS,
  UNCLAIMED: CONVERSATION_HEAD_STATUS.UNCLAIMED,
} as const);
export type ConversationUnresolvedHeadStatus =
  (typeof CONVERSATION_UNRESOLVED_HEAD_STATUS)[keyof typeof CONVERSATION_UNRESOLVED_HEAD_STATUS];
export const CONVERSATION_UNRESOLVED_HEAD_STATUSES = Object.freeze(
  Object.values(CONVERSATION_UNRESOLVED_HEAD_STATUS),
) as readonly ConversationUnresolvedHeadStatus[];

export const CONVERSATION_CATALOG_HEALTH = Object.freeze({
  READY: "ready",
  REBUILDING: "rebuilding",
  DEGRADED: "degraded",
} as const);
export type ConversationCatalogHealth =
  (typeof CONVERSATION_CATALOG_HEALTH)[keyof typeof CONVERSATION_CATALOG_HEALTH];
export const CONVERSATION_CATALOG_HEALTH_VALUES = Object.freeze(
  Object.values(CONVERSATION_CATALOG_HEALTH),
) as readonly ConversationCatalogHealth[];

export const CONVERSATION_SOURCE_INVENTORY_STATE = Object.freeze({
  EMPTY: "empty",
  READY: CONVERSATION_CATALOG_HEALTH.READY,
  DEGRADED: CONVERSATION_CATALOG_HEALTH.DEGRADED,
} as const);
export type ConversationSourceInventoryState =
  (typeof CONVERSATION_SOURCE_INVENTORY_STATE)[keyof typeof CONVERSATION_SOURCE_INVENTORY_STATE];

export const CONVERSATION_CATALOG_SOURCE_KIND = Object.freeze({
  CONVERSATION_MANIFEST: "conversation-manifest",
  CONVERSATION_JOURNAL_HEAD: "conversation-journal-head",
  LINEAGE_HEAD: "lineage-head",
  LINEAGE_ASSOCIATION: "lineage-association",
} as const);
export type ConversationCatalogSourceKind =
  (typeof CONVERSATION_CATALOG_SOURCE_KIND)[keyof typeof CONVERSATION_CATALOG_SOURCE_KIND];
export const CONVERSATION_CATALOG_SOURCE_KINDS = Object.freeze(
  Object.values(CONVERSATION_CATALOG_SOURCE_KIND),
) as readonly ConversationCatalogSourceKind[];

export const CONVERSATION_TIMELINE_ITEM_KIND = Object.freeze({
  REVISION_BOUNDARY: "revision-boundary",
  CONVERSATION_START: "conversation-start",
  CONVERSATION_EVENT: "conversation-event",
} as const);
export type ConversationTimelineItemKind =
  (typeof CONVERSATION_TIMELINE_ITEM_KIND)[keyof typeof CONVERSATION_TIMELINE_ITEM_KIND];

export const LINEAGE_HEAD_TRANSITION_KIND = Object.freeze({
  SELECTION: "selection",
  CHILD_COMMIT: "child-commit",
} as const);
export type LineageHeadTransitionKind =
  (typeof LINEAGE_HEAD_TRANSITION_KIND)[keyof typeof LINEAGE_HEAD_TRANSITION_KIND];

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const isConversationLineageStatus = (value: unknown): value is ConversationLineageStatus =>
  memberOf(CONVERSATION_LINEAGE_STATUSES, value);
export const isConversationHeadStatus = (value: unknown): value is ConversationHeadStatus =>
  memberOf(CONVERSATION_HEAD_STATUSES, value);
export const isConversationUnresolvedHeadStatus = (
  value: unknown,
): value is ConversationUnresolvedHeadStatus =>
  memberOf(CONVERSATION_UNRESOLVED_HEAD_STATUSES, value);
export const isConversationCatalogHealth = (value: unknown): value is ConversationCatalogHealth =>
  memberOf(CONVERSATION_CATALOG_HEALTH_VALUES, value);
export const isConversationCatalogSourceKind = (
  value: unknown,
): value is ConversationCatalogSourceKind => memberOf(CONVERSATION_CATALOG_SOURCE_KINDS, value);
