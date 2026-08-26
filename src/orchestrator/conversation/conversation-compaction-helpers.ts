import { canonicalJsonBytes } from "../../durability/index.js";
import type { TraceStore } from "../trace/store.js";
import type { StoredTraceEvent } from "../trace/types.js";
import type { ConversationActionAuthorityBindingV1 } from "./conversation-action-receipt-store.js";

export function sameCompactionValue(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

export function sortedCompactionFacts(facts: ConversationActionAuthorityBindingV1["facts"]) {
  return facts.sort((left, right) =>
    Buffer.compare(
      Buffer.from(`${left.kind}\0${left.identity}`),
      Buffer.from(`${right.kind}\0${right.identity}`),
    ),
  );
}

export async function findConversationCompactionEvent(
  traceStore: TraceStore,
  conversationId: string,
  proposalId: string,
): Promise<StoredTraceEvent | null> {
  return (
    (await traceStore.readConversation(conversationId)).find(
      ({ stored_event: event }) =>
        event.idempotency_key === `action-context-compaction:${proposalId}`,
    )?.stored_event ?? null
  );
}
