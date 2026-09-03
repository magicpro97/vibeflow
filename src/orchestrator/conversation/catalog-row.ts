import { sanitizePublicText } from "../trace/public-sanitize.js";
import type { CatalogCursorCodec } from "./catalog-cursor.js";
import { conversationLockDigest } from "./catalog-lock.js";
import {
  type ConversationRevisionSummaryV1,
  type ConversationSessionSummaryV1,
  safePublicRoleReference,
} from "./catalog-types.js";
import {
  CONVERSATION_CATALOG_SCHEMA_VERSION,
  CONVERSATION_HEAD_STATUS,
  CONVERSATION_LINEAGE_STATUS,
} from "./conversation-catalog-contract.js";
import type { ConversationLineageReadV1, ValidatedLineageNodeV1 } from "./lineage-reader.js";
import {
  type LineageHeadRecordV1,
  compareLineageNodes,
  isLineageAssociationId,
  isSafeCatalogIdentifier,
} from "./lineage-types.js";

export function createConversationRevisionSummary(
  node: ValidatedLineageNodeV1,
  revisionClaimEpoch: number,
): ConversationRevisionSummaryV1 {
  const source = node.source;
  for (const identity of [
    node.node.conversation_id,
    node.node.revision_id,
    source.manifest.parent_conversation_id,
    source.manifest.parent_revision_id,
  ])
    if (identity !== null && !isSafeCatalogIdentifier(identity))
      throw new Error("unsafe catalog revision identity");
  return {
    schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
    conversation_id: node.node.conversation_id,
    revision_id: node.node.revision_id,
    revision_ordinal: node.node.revision_ordinal,
    parent_conversation_id: source.manifest.parent_conversation_id,
    parent_revision_id: source.manifest.parent_revision_id,
    lineage_status: CONVERSATION_LINEAGE_STATUS.VERIFIED,
    topic: sanitizePublicText(source.manifest.topic, "topic", []),
    policy: safePublicRoleReference(source.manifest.policy),
    lifecycle: source.journal_head.lifecycle,
    health: source.journal_head.health,
    participants: structuredClone(source.journal_head.participants),
    created_at: source.manifest.created_at,
    updated_at: source.journal_head.updated_at,
    last_seq: source.journal_head.last_seq,
    lock_digest: conversationLockDigest(node.root_session_id, source, revisionClaimEpoch),
  };
}

function searchable(summary: ConversationRevisionSummaryV1): string {
  return [
    summary.topic,
    summary.policy,
    ...summary.participants.flatMap((participant) => [participant.role_ref, participant.engine]),
  ]
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
}

function matchedRevision(
  nodes: readonly ValidatedLineageNodeV1[],
  query: string,
  revisionClaimEpoch: number,
): ValidatedLineageNodeV1 | null {
  if (!query) return null;
  return (
    nodes
      .filter((node) =>
        searchable(createConversationRevisionSummary(node, revisionClaimEpoch)).includes(query),
      )
      .sort((left, right) => compareLineageNodes(right.node, left.node))[0] ?? null
  );
}

function associationIds(
  root: string,
  bindings: ReadonlyMap<string, readonly string[]> | undefined,
): string[] {
  const values = [...new Set(bindings?.get(root) ?? [])].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  if (values.length > 512 || values.some((value) => !isLineageAssociationId(value)))
    throw new Error("invalid lineage association projection");
  return values;
}

export function createCatalogRow(
  lineage: ConversationLineageReadV1,
  head: LineageHeadRecordV1,
  query: string,
  codec: CatalogCursorCodec,
  scopeId: string,
  associations: ReadonlyMap<string, readonly string[]> | undefined,
  revisionClaimEpoch: number,
): ConversationSessionSummaryV1 {
  const roots = lineage.nodes.filter(
    (item) =>
      item.node.revision_ordinal === 0 && item.node.conversation_id === lineage.root_session_id,
  );
  if (roots.length !== 1) throw new Error("lineage root is missing or duplicated");
  const rootNode = roots[0];
  if (!rootNode) throw new Error("lineage root is missing");
  const activeNodes = head.active
    ? lineage.nodes.filter(
        (item) =>
          item.node.conversation_id === head.active?.conversation_id &&
          item.node.revision_id === head.active.revision_id &&
          item.node.revision_ordinal === head.active.revision_ordinal,
      )
    : [];
  const activeNode = activeNodes.length === 1 ? activeNodes[0] : null;
  if (head.head_status === CONVERSATION_HEAD_STATUS.COMMITTED && !activeNode)
    throw new Error("active lineage node is missing");
  const nodes = new Map(lineage.nodes.map((item) => [item.node.conversation_id, item]));
  const root = createConversationRevisionSummary(rootNode, revisionClaimEpoch);
  const active = activeNode
    ? createConversationRevisionSummary(activeNode, revisionClaimEpoch)
    : null;
  const matched = matchedRevision(lineage.nodes, query, revisionClaimEpoch);
  const recoveryUpdates = [
    root.updated_at,
    ...head.candidate_heads.map(
      (item) => nodes.get(item.conversation_id)?.source.journal_head.updated_at ?? root.updated_at,
    ),
  ];
  return {
    schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
    root_session_id: lineage.root_session_id,
    head_status: head.head_status,
    root,
    active_conversation_id: active?.conversation_id ?? null,
    active_revision_id: active?.revision_id ?? null,
    active_revision_ordinal: active?.revision_ordinal ?? null,
    revision_count: lineage.nodes.length,
    active,
    matched_revision: matched ? structuredClone(matched.node) : null,
    association_ids: associationIds(lineage.root_session_id, associations),
    sort_updated_at: active?.updated_at ?? recoveryUpdates.sort().at(-1) ?? root.updated_at,
    lineage_cursor: codec.encodeLineage({
      scope_id: scopeId,
      root_session_id: lineage.root_session_id,
      head_digest: head.content_digest,
      head_epoch: head.head_epoch,
      last_revision_ordinal: 0,
      last_public_sequence: 0,
    }),
  };
}
