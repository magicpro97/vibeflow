import type { RevisionOperationV1 } from "./lineage-revision-operation.js";
import { type RevisionOperationEventV1, materializeRevisionEvent } from "./revision-planner.js";

/** Materializes a non-terminal revision lifecycle edge under its exact operation. */
export function materializeRevisionStateTransition(
  operation: RevisionOperationV1,
  events: readonly RevisionOperationEventV1[],
  from: "created" | "preparing" | "published",
  to: "preparing" | "prepared" | "starting",
): RevisionOperationEventV1 {
  return materializeRevisionEvent(
    operation,
    events,
    {
      kind: "state-transition",
      from,
      to,
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    },
    operation.created_at,
  );
}
