import { join } from "node:path";
import type { OrdinaryAuthorityTerminalEvidenceV1 } from "../../capabilities/authority-mutation/index.js";
import type { CapabilityOrdinaryAuthorityRuntimeV1 } from "../../capabilities/ordinary-authority-runtime.js";
import { acquireProcessLock } from "../../durability/index.js";

export function withOrdinaryAuthorityCommandLock<T>(
  runtime: CapabilityOrdinaryAuthorityRuntimeV1,
  callback: () => T,
): T {
  const root = runtime.service.options.storage.paths.privateRoot;
  const lock = acquireProcessLock(
    join(root, "actions", "v1", "ordinary-authority-command.writer.lock"),
    { operation: "ordinary-authority-command", coverageRoot: root },
  );
  try {
    return callback();
  } finally {
    lock.release();
  }
}

export function ordinaryAuthorityTerminalFor(
  runtime: CapabilityOrdinaryAuthorityRuntimeV1,
  proposalId: string,
): OrdinaryAuthorityTerminalEvidenceV1 | null {
  const snapshot = runtime.actionStore.getRecorded(proposalId);
  return snapshot?.operation_id ? runtime.domain.readTerminal(snapshot.operation_id) : null;
}
