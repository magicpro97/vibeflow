import { canonicalJsonBytes } from "../../durability/index.js";
import type {
  ConversationListResponseV1,
  ConversationRevisionSummaryV1,
  ConversationSessionSummaryV1,
} from "./catalog-types.js";

const compareBytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

export function assertRevisionSummaryInvariants(value: ConversationRevisionSummaryV1): void {
  if (
    value.participants.some((item, index) => {
      const previous = value.participants[index - 1];
      return (
        previous !== undefined && compareBytes(previous.participant_id, item.participant_id) >= 0
      );
    })
  )
    throw new Error("invalid public participant ordering");
}

export function assertSessionSummaryInvariants(value: ConversationSessionSummaryV1): void {
  if (
    value.root_session_id !== value.root.conversation_id ||
    value.root.revision_ordinal !== 0 ||
    value.root.parent_conversation_id !== null ||
    value.root.parent_revision_id !== null ||
    value.root.lineage_status !== "verified"
  )
    throw new Error("invalid conversation session root projection");
  if (
    value.active &&
    (value.active.lineage_status !== "verified" ||
      value.active.revision_ordinal >= value.revision_count)
  )
    throw new Error("invalid conversation session active projection");
  if (
    value.active?.revision_ordinal === 0 &&
    !canonicalJsonBytes(value.active).equals(canonicalJsonBytes(value.root))
  )
    throw new Error("ordinal-zero active revision must equal the root projection");
  if (
    value.head_status === "committed" &&
    value.active !== null &&
    value.sort_updated_at !== value.active.updated_at
  )
    throw new Error("committed conversation sort time must equal the active update time");
  if (
    value.matched_revision &&
    (value.matched_revision.revision_ordinal >= value.revision_count ||
      (value.matched_revision.revision_ordinal === 0 &&
        (value.matched_revision.conversation_id !== value.root.conversation_id ||
          value.matched_revision.revision_id !== value.root.revision_id)))
  )
    throw new Error("invalid conversation session match projection");
}

export function assertListResponseInvariants(value: ConversationListResponseV1): void {
  const roots = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (roots.has(item.root_session_id)) throw new Error("duplicate conversation catalog root");
    roots.add(item.root_session_id);
    const previous = value.items[index - 1];
    if (
      previous &&
      (previous.sort_updated_at < item.sort_updated_at ||
        (previous.sort_updated_at === item.sort_updated_at &&
          compareBytes(previous.root_session_id, item.root_session_id) <= 0))
    )
      throw new Error("invalid conversation catalog row ordering");
  }
}
