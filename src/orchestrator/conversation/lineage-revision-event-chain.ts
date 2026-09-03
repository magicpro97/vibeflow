import { PUBLIC_OPERATION_REVISION_PHASE } from "../../actions/protocol-contract.js";
import {
  type RevisionHeadCommitEventV1,
  assertRevisionHeadCommitEventV1,
} from "./lineage-revision-operation.js";
import { LINEAGE_LIMITS } from "./lineage-types.js";
import {
  REVISION_OPERATION_EVENT_PAYLOAD_KIND,
  REVISION_OPERATION_INITIAL_PHASE,
  type RevisionStateTransitionEventV1,
  assertRevisionOperationEventV1,
} from "./revision-operation-event-contract.js";

const PREPUBLICATION_TRANSITION_TARGETS = Object.freeze({
  [REVISION_OPERATION_INITIAL_PHASE.CREATED]: Object.freeze([
    PUBLIC_OPERATION_REVISION_PHASE.PREPARING,
  ] as const),
  [PUBLIC_OPERATION_REVISION_PHASE.PREPARING]: Object.freeze([
    PUBLIC_OPERATION_REVISION_PHASE.PREPARED,
  ] as const),
});

function assertStateTransitionEvent(
  value: unknown,
): asserts value is RevisionStateTransitionEventV1 {
  assertRevisionOperationEventV1(value);
  if (value.payload.kind !== REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION)
    throw new Error("invalid prepublication revision event");
  const payload = value.payload;
  if (
    !Object.hasOwn(PREPUBLICATION_TRANSITION_TARGETS, payload.from) ||
    !PREPUBLICATION_TRANSITION_TARGETS[
      payload.from as keyof typeof PREPUBLICATION_TRANSITION_TARGETS
    ].some((candidate) => candidate === payload.to) ||
    payload.action_terminals.length !== 0 ||
    payload.reason_code !== null
  )
    throw new Error("invalid prepublication revision event");
}

export function assertRevisionOperationEventChainV1(
  value: unknown,
  operationId: string,
): RevisionHeadCommitEventV1 {
  if (!Array.isArray(value) || value.length !== 3 || value.length > LINEAGE_LIMITS.maxNodes)
    throw new Error("invalid revision operation event chain");
  let previousDigest: string | null = null;
  let previousTimestamp: string | null = null;
  let state:
    | typeof REVISION_OPERATION_INITIAL_PHASE.CREATED
    | typeof PUBLIC_OPERATION_REVISION_PHASE.PREPARING
    | typeof PUBLIC_OPERATION_REVISION_PHASE.PREPARED = REVISION_OPERATION_INITIAL_PHASE.CREATED;
  for (let index = 0; index < value.length - 1; index += 1) {
    const event = value[index];
    assertStateTransitionEvent(event);
    if (
      event.operation_id !== operationId ||
      event.sequence !== index ||
      event.previous_event_digest !== previousDigest ||
      event.payload.from !== state ||
      event.payload.authorized_by_action_operation_id !== operationId ||
      event.payload.effect_action_operation_id !== operationId ||
      (previousTimestamp !== null && event.recorded_at < previousTimestamp)
    )
      throw new Error("revision operation event chain is discontinuous");
    state = event.payload.to as
      | typeof PUBLIC_OPERATION_REVISION_PHASE.PREPARING
      | typeof PUBLIC_OPERATION_REVISION_PHASE.PREPARED;
    previousDigest = event.event_digest;
    previousTimestamp = event.recorded_at;
  }
  const commit = value.at(-1);
  assertRevisionHeadCommitEventV1(commit);
  if (
    state !== PUBLIC_OPERATION_REVISION_PHASE.PREPARED ||
    commit.operation_id !== operationId ||
    commit.sequence !== value.length - 1 ||
    commit.previous_event_digest !== previousDigest ||
    (previousTimestamp !== null && commit.recorded_at < previousTimestamp)
  )
    throw new Error("revision head commit does not close the dense event chain");
  return structuredClone(commit);
}
