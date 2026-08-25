import type { OperationEntry, OperationTombstone } from "./operation-registry-types.js";

/** Archives one registry member and enforces its bounded terminal-state window. */
export function archiveLocalOperation(
  operations: Map<string, OperationEntry>,
  tombstones: Map<string, OperationTombstone>,
  tombstoneLimit: number,
  entry: OperationEntry,
  state: OperationTombstone["state"],
): void {
  if (operations.get(entry.operationId) !== entry) return;
  operations.delete(entry.operationId);
  tombstones.set(entry.operationId, {
    conversationId: entry.conversationId,
    state,
  });
  while (tombstones.size > tombstoneLimit) {
    const oldest = tombstones.keys().next();
    if (oldest.done) break;
    tombstones.delete(oldest.value);
  }
}
