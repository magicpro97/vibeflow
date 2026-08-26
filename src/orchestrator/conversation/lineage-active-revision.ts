import type { PublishedRevisionTransitionInputV1 } from "./lineage-published-transition.js";
import { publishedRevisionTransitionMap } from "./lineage-published-transition.js";
import { LineageAuthorityCorruptError } from "./lineage-store.js";
import {
  type LineageHeadRecordV1,
  type LineageNodeIdentityV1,
  isPlainLineageRecord,
} from "./lineage-types.js";

const nodeKey = (node: LineageNodeIdentityV1): string =>
  `${node.conversation_id}\0${node.revision_id}\0${node.revision_ordinal}`;

export function activeRevisionOperationIdForHead(
  head: LineageHeadRecordV1,
  headAuthority: unknown,
  published: readonly PublishedRevisionTransitionInputV1[],
): string | null {
  if (
    !head.active ||
    head.head_epoch === 0 ||
    !isPlainLineageRecord(headAuthority) ||
    headAuthority.kind !== "child-commit"
  )
    return null;
  const transition = publishedRevisionTransitionMap(published).get(head.active.conversation_id);
  if (
    !transition ||
    transition.root_session_id !== head.root_session_id ||
    nodeKey(transition.child) !== nodeKey(head.active)
  )
    throw new LineageAuthorityCorruptError(
      "active revision has no exact published operation authority",
    );
  return transition.operation_id;
}
