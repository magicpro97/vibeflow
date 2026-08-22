import type { AttemptRuntime } from "./attempt-runtime.js";
import type { ConversationEmissionGate, LiveConversation } from "./lifecycle-gate.js";
import type { OperationRegistry } from "./operation-registry.js";

/** Reconciles durable native history before an ACTIVE restored operation can continue. */
export async function reconcileActiveConversation(
  live: LiveConversation,
  operations: OperationRegistry,
  emissions: ConversationEmissionGate,
  attempts: AttemptRuntime,
): Promise<void> {
  const id = live.manifest.conversation_id;
  const operation = operations.get(id, live.operationId);
  if (!operation) throw new Error("operation authority missing");
  await emissions.control(id, live.operationId, false, async () => {
    if (!live.needsReconcile) return;
    await operation.drainEffects();
    await attempts.reconcile(live, operation);
    live.needsReconcile = false;
  });
}
