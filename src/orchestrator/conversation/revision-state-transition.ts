import { PUBLIC_OPERATION_REVISION_PHASE } from "../../actions/protocol-contract.js";
import type { RevisionOperationV1 } from "./lineage-revision-operation.js";
import {
  REVISION_OPERATION_EVENT_PAYLOAD_KIND,
  REVISION_OPERATION_INITIAL_PHASE,
} from "./revision-operation-event-contract.js";
import { type RevisionOperationEventV1, materializeRevisionEvent } from "./revision-planner.js";

export const REVISION_NON_TERMINAL_TRANSITION_SOURCE_PHASES = Object.freeze([
  REVISION_OPERATION_INITIAL_PHASE.CREATED,
  PUBLIC_OPERATION_REVISION_PHASE.PREPARING,
  PUBLIC_OPERATION_REVISION_PHASE.PUBLISHED,
] as const);
export const REVISION_NON_TERMINAL_TRANSITION_TARGET_PHASES = Object.freeze([
  PUBLIC_OPERATION_REVISION_PHASE.PREPARING,
  PUBLIC_OPERATION_REVISION_PHASE.PREPARED,
  PUBLIC_OPERATION_REVISION_PHASE.STARTING,
] as const);

type RevisionNonTerminalTransitionSourceV1 =
  (typeof REVISION_NON_TERMINAL_TRANSITION_SOURCE_PHASES)[number];
type RevisionNonTerminalTransitionTargetV1 =
  (typeof REVISION_NON_TERMINAL_TRANSITION_TARGET_PHASES)[number];

/** Materializes a non-terminal revision lifecycle edge under its exact operation. */
export function materializeRevisionStateTransition(
  operation: RevisionOperationV1,
  events: readonly RevisionOperationEventV1[],
  from: RevisionNonTerminalTransitionSourceV1,
  to: RevisionNonTerminalTransitionTargetV1,
): RevisionOperationEventV1 {
  return materializeRevisionEvent(
    operation,
    events,
    {
      kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION,
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
