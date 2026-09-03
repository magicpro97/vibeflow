import { digestHex, digestV1 } from "../../durability/index.js";
import type { TraceCorrelation } from "../trace/types.js";
import type { RuntimeEmission } from "./policy-registry.js";
import type { ConversationManifest } from "./types.js";

/** Fixed create correlation: no ambient ID generator participates in replay identity. */
export function preparedStartCorrelation(
  manifest: ConversationManifest,
  operationId: string,
  item: RuntimeEmission,
): TraceCorrelation {
  const turnDigest = digestV1("VF-CONVERSATION-PREPARED-CONFIG-TURN\0v1\0", {
    schema_version: "1.0",
    conversation_id: manifest.conversation_id,
    operation_id: operationId,
    idempotency_key: item.emission.idempotency_key,
  });
  return Object.freeze({
    workflow_id: manifest.workflow_id,
    conversation_id: manifest.conversation_id,
    revision_id: manifest.revision_id,
    run_id: manifest.run_id,
    turn_id: `turn-${digestHex(turnDigest)}`,
    operation_id: operationId,
    attempt_id: "control",
    ...item.patch,
  });
}
