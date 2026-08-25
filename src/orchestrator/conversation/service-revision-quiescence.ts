import type { InitialRevisionLaneAuthority } from "./revision-initial-lane-authority.js";
import type { RevisionLaneRetryRuntime } from "./revision-lane-retry-runtime.js";
import type { ConversationRuntime } from "./runtime.js";

export function revisionQuiescenceReader(
  runtime: Pick<ConversationRuntime, "operationId">,
  retries: Pick<RevisionLaneRetryRuntime, "isQuiescent"> | null,
  initial: Pick<InitialRevisionLaneAuthority, "isQuiescent"> | null,
) {
  return (conversationId: string, operationId: string): boolean =>
    runtime.operationId(conversationId) === null &&
    (retries?.isQuiescent(operationId) ?? true) &&
    (initial?.isQuiescent(operationId) ?? true);
}
