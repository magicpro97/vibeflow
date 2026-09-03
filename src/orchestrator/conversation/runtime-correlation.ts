import type { TraceCorrelation } from "../trace/types.js";
import type { ConversationManifest } from "./types.js";

export function runtimeCorrelation(
  manifest: ConversationManifest,
  operationId: string,
  attemptId: string,
  id: (kind: string) => string,
): TraceCorrelation {
  return Object.freeze({
    workflow_id: manifest.workflow_id,
    conversation_id: manifest.conversation_id,
    revision_id: manifest.revision_id,
    run_id: manifest.run_id,
    turn_id: id("turn"),
    operation_id: operationId,
    attempt_id: attemptId,
  });
}
