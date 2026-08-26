import { validateLineageHeadAuthorityChain } from "./lineage-head-authority.js";
import type { ConversationLineageReadV1 } from "./lineage-reader.js";
import {
  type LineageHeadRecordV1,
  type LineageNodeIdentityV1,
  assertLineageHeadRecordV1,
} from "./lineage-types.js";

const nodeKey = (node: LineageNodeIdentityV1): string =>
  `${node.conversation_id}\0${node.revision_id}\0${node.revision_ordinal}`;

const sameNode = (
  left: LineageNodeIdentityV1 | null,
  right: LineageNodeIdentityV1 | null,
): boolean => (left === null || right === null ? left === right : nodeKey(left) === nodeKey(right));

function sameNodes(
  left: readonly LineageNodeIdentityV1[],
  right: readonly LineageNodeIdentityV1[],
): boolean {
  return (
    left.length === right.length &&
    left.every((node, index) => sameNode(node, right[index] ?? null))
  );
}

function validInitialSnapshotTime(
  value: LineageHeadRecordV1,
  lineage: ConversationLineageReadV1,
  current: LineageHeadRecordV1,
): boolean {
  const earliestCompleteSnapshot = lineage.eligible_leaves
    .map(
      (leaf) => leaf.source.journal_records[0]?.stored_event.ts ?? leaf.source.manifest.created_at,
    )
    .sort()
    .at(-1);
  return (
    earliestCompleteSnapshot !== undefined &&
    value.updated_at >= earliestCompleteSnapshot &&
    value.updated_at <= current.updated_at
  );
}

export function validateLineageHeadForRead(
  value: unknown,
  lineage: ConversationLineageReadV1,
  transitions: ReadonlyMap<string, unknown> = new Map(),
): LineageHeadRecordV1 {
  assertLineageHeadRecordV1(value);
  if (value.root_session_id !== lineage.root_session_id)
    throw new Error("lineage head root mismatch");
  const leaves = new Map(lineage.eligible_leaves.map((item) => [nodeKey(item.node), item]));
  if (value.active && !leaves.has(nodeKey(value.active)))
    throw new Error("lineage head is not a leaf");
  if (value.candidate_heads.some((candidate) => !leaves.has(nodeKey(candidate))))
    throw new Error("lineage head candidate is not a leaf");
  if (
    value.head_status === "ambiguous" &&
    (value.candidate_heads.length !== leaves.size ||
      value.candidate_heads.some((candidate) => !leaves.has(nodeKey(candidate))))
  )
    throw new Error("ambiguous lineage head omits a leaf");
  if (value.head_status === "unclaimed" && leaves.size !== 1)
    throw new Error("unclaimed lineage head requires exactly one leaf");
  if (value.head_epoch === 0) {
    const expected = lineage.initial_head_candidate;
    if (!expected) throw new Error("initial lineage head has no eligible leaf");
    if (value.head_status === "unclaimed") {
      const candidate = value.candidate_heads[0];
      if (
        !candidate ||
        expected.head_status !== "committed" ||
        !expected.active ||
        nodeKey(candidate) !== nodeKey(expected.active) ||
        !validInitialSnapshotTime(value, lineage, expected)
      )
        throw new Error("invalid deferred initial lineage head");
    } else if (
      value.head_status !== expected.head_status ||
      !sameNode(value.active, expected.active) ||
      !sameNodes(value.candidate_heads, expected.candidate_heads) ||
      !validInitialSnapshotTime(value, lineage, expected)
    ) {
      throw new Error("initial lineage head differs from deterministic candidate");
    }
  } else {
    validateLineageHeadAuthorityChain(value, lineage, transitions);
  }
  return structuredClone(value);
}
