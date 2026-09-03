import type { InitialRevisionLaneAuthority } from "./revision-initial-lane-authority.js";
import type { RevisionLaneRetryRuntime } from "./revision-lane-retry-runtime.js";
import type { ConversationRuntime } from "./runtime.js";

export function revisionQuiescenceReader(
  runtime: Pick<ConversationRuntime, "operationId">,
  retries: Pick<RevisionLaneRetryRuntime, "isQuiescent"> | null,
  initial: Pick<InitialRevisionLaneAuthority, "isQuiescent"> | null,
) {
  return (conversationId: string, revisionOperationId: string | null): boolean =>
    runtime.operationId(conversationId) === null &&
    (revisionOperationId === null || (retries?.isQuiescent(revisionOperationId) ?? true)) &&
    (revisionOperationId === null || (initial?.isQuiescent(revisionOperationId) ?? true));
}
