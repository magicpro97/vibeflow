import { digestV1 } from "../../durability/index.js";
import type { ConversationLineageReadV1, ValidatedLineageNodeV1 } from "./lineage-reader.js";
import {
  type InitialLineageLeafV1,
  LINEAGE_LIMITS,
  type LineageNodeIdentityV1,
  compareLineageNodes,
  createInitialLineageHead,
} from "./lineage-types.js";
import type { ValidatedConversationSourceV1 } from "./source-inventory.js";

function identity(source: ValidatedConversationSourceV1, ordinal: number): LineageNodeIdentityV1 {
  return {
    conversation_id: source.manifest.conversation_id,
    revision_id: source.manifest.revision_id,
    revision_ordinal: ordinal,
  };
}

export function buildValidatedLineage(
  root: ValidatedConversationSourceV1,
  children: ReadonlyMap<string, ValidatedConversationSourceV1[]>,
): ConversationLineageReadV1 {
  const nodes: ValidatedLineageNodeV1[] = [];
  const pending: Array<{
    source: ValidatedConversationSourceV1;
    ordinal: number;
    parent: ValidatedLineageNodeV1 | null;
    ancestry: readonly Record<string, unknown>[];
  }> = [{ source: root, ordinal: 0, parent: null, ancestry: [] }];
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    if (nodes.length >= LINEAGE_LIMITS.maxNodes || current.ordinal > LINEAGE_LIMITS.maxDepth)
      throw new Error("lineage exceeds bounded reader limits");
    const node = identity(current.source, current.ordinal);
    const entries = [
      ...current.ancestry,
      {
        node,
        manifest_digest: current.source.manifest_digest,
        parent_conversation_id: current.source.manifest.parent_conversation_id,
        parent_revision_id: current.source.manifest.parent_revision_id,
      },
    ];
    const projected: ValidatedLineageNodeV1 = {
      node,
      root_session_id: current.parent?.root_session_id ?? root.manifest.conversation_id,
      parent: current.parent ? structuredClone(current.parent.node) : null,
      manifest_digest: current.source.manifest_digest,
      ancestry_digest: digestV1("VF-LINEAGE-ANCESTRY\0v1\0", {
        schema_version: "1.0",
        entries,
      }),
      source: current.source,
    };
    nodes.push(projected);
    const next = children.get(current.source.manifest.conversation_id) ?? [];
    for (let index = next.length - 1; index >= 0; index--) {
      const child = next[index];
      if (child)
        pending.push({
          source: child,
          ordinal: current.ordinal + 1,
          parent: projected,
          ancestry: entries,
        });
    }
  }
  nodes.sort((left, right) => compareLineageNodes(left.node, right.node));
  const parentIds = new Set(
    nodes
      .filter(
        (item) =>
          Object.keys(item.source.manifest_record.child_revisions).length > 0 ||
          (children.get(item.node.conversation_id)?.length ?? 0) > 0,
      )
      .map((item) => item.node.conversation_id),
  );
  const leaves = nodes
    .filter((item) => !parentIds.has(item.node.conversation_id))
    .sort((left, right) => compareLineageNodes(left.node, right.node));
  if (leaves.length > LINEAGE_LIMITS.maxCandidates)
    throw new Error("lineage exceeds candidate bound");
  const headLeaves: InitialLineageLeafV1[] = leaves.map((item) => ({
    node: item.node,
    manifest_digest: item.manifest_digest,
    ancestry_digest: item.ancestry_digest,
    updated_at: item.source.journal_head.updated_at,
  }));
  return {
    schema_version: "1.0",
    root_session_id: root.manifest.conversation_id,
    nodes,
    eligible_leaves: leaves,
    validated_leaf_set_digest: digestV1("VF-LINEAGE-VALIDATED-LEAF-SET\0v1\0", {
      schema_version: "1.0",
      leaves: headLeaves.map(({ updated_at: _updatedAt, ...leaf }) => leaf),
    }),
    initial_head_candidate: headLeaves.length
      ? createInitialLineageHead(root.manifest.conversation_id, headLeaves)
      : null,
  };
}
