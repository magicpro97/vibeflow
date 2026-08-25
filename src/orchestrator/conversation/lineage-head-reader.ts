import { validateLineageHeadAuthorityChain } from "./lineage-head-authority.js";
import type { ConversationLineageReadV1 } from "./lineage-reader.js";
import {
  type LineageHeadRecordV1,
  type LineageNodeIdentityV1,
  assertLineageHeadRecordV1,
} from "./lineage-types.js";

const nodeKey = (node: LineageNodeIdentityV1): string =>
  `${node.conversation_id}\0${node.revision_id}\0${node.revision_ordinal}`;

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
        value.updated_at !== expected.updated_at
      )
        throw new Error("invalid deferred initial lineage head");
    } else if (value.content_digest !== expected.content_digest) {
      throw new Error("initial lineage head differs from deterministic candidate");
    }
  } else if (value.head_status !== "committed") {
    throw new Error("only a committed lineage head may advance");
  } else {
    validateLineageHeadAuthorityChain(value, lineage, transitions);
  }
  return structuredClone(value);
}
