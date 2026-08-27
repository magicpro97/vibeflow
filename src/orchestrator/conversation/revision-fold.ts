import type { DurableActionAuthorityReaderV1 } from "../../actions/index.js";
import { PUBLIC_OPERATION_REVISION_PHASE } from "../../actions/protocol-contract.js";
import { digestV1 } from "../../durability/index.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import { validateRevisionActionAuthorityChain } from "./revision-action-authority.js";
import {
  validateRevisionAuxiliaryAuthority,
  validateRevisionTransitionAuthority,
} from "./revision-fold-validation.js";
import {
  REVISION_OPERATION_EVENT_PAYLOAD_KIND,
  REVISION_OPERATION_EVENT_STORAGE,
  REVISION_OPERATION_INITIAL_PHASE,
  type RevisionOperationEventSourceStateV1,
} from "./revision-operation-event-contract.js";
import {
  assertParticipantStartReceiptPlanBinding,
  assertRevisionOperationPlanBinding,
} from "./revision-participant-plan-binding.js";
import {
  type ParticipantStartReceiptV1,
  advanceParticipantReceipt,
} from "./revision-participant-receipt.js";
import type { RevisionOperationEventV1, RevisionOperationStateV1 } from "./revision-planner.js";

const revisionEdge = (
  from: RevisionOperationEventSourceStateV1,
  to: RevisionOperationStateV1,
): string => `${from}\0${to}`;

const EDGES = new Set([
  revisionEdge(REVISION_OPERATION_INITIAL_PHASE.CREATED, PUBLIC_OPERATION_REVISION_PHASE.PREPARING),
  revisionEdge(PUBLIC_OPERATION_REVISION_PHASE.PREPARING, PUBLIC_OPERATION_REVISION_PHASE.PREPARED),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.PREPARING,
    PUBLIC_OPERATION_REVISION_PHASE.ABANDONED,
  ),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.PREPARING,
    PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
  ),
  revisionEdge(PUBLIC_OPERATION_REVISION_PHASE.PREPARED, PUBLIC_OPERATION_REVISION_PHASE.ABANDONED),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.PREPARED,
    PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
  ),
  revisionEdge(PUBLIC_OPERATION_REVISION_PHASE.PUBLISHED, PUBLIC_OPERATION_REVISION_PHASE.STARTING),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.PUBLISHED,
    PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
  ),
  revisionEdge(PUBLIC_OPERATION_REVISION_PHASE.STARTING, PUBLIC_OPERATION_REVISION_PHASE.STARTED),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.STARTING,
    PUBLIC_OPERATION_REVISION_PHASE.START_FAILED,
  ),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.STARTING,
    PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
  ),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.START_FAILED,
    PUBLIC_OPERATION_REVISION_PHASE.STARTING,
  ),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.START_FAILED,
    PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
  ),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
    PUBLIC_OPERATION_REVISION_PHASE.PREPARING,
  ),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
    PUBLIC_OPERATION_REVISION_PHASE.PREPARED,
  ),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
    PUBLIC_OPERATION_REVISION_PHASE.PUBLISHED,
  ),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
    PUBLIC_OPERATION_REVISION_PHASE.STARTING,
  ),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
    PUBLIC_OPERATION_REVISION_PHASE.STARTED,
  ),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
    PUBLIC_OPERATION_REVISION_PHASE.START_FAILED,
  ),
  revisionEdge(
    PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
    PUBLIC_OPERATION_REVISION_PHASE.ABANDONED,
  ),
]);

export interface FoldedRevisionOperationV1 {
  state: RevisionOperationStateV1 | typeof REVISION_OPERATION_INITIAL_PHASE.CREATED;
  last_sequence: number;
  last_event_digest: string | null;
  effect_action_operation_id: string;
  state_digest: string;
}

export function foldRevisionOperation(
  operation: RevisionOperationV1,
  events: readonly RevisionOperationEventV1[],
  options: {
    actionAuthority?: DurableActionAuthorityReaderV1;
    preparationPlan?: RevisionPreparationPlanV1;
  } = {},
): FoldedRevisionOperationV1 {
  if (options.preparationPlan)
    assertRevisionOperationPlanBinding(operation, options.preparationPlan);
  let state: RevisionOperationStateV1 | typeof REVISION_OPERATION_INITIAL_PHASE.CREATED =
    REVISION_OPERATION_INITIAL_PHASE.CREATED;
  let priorDigest: string | null = null;
  let priorTime: string | null = null;
  let effectActionOperationId = operation.operation_id;
  const participantReceipts = new Map<string, ParticipantStartReceiptV1>();
  for (const [index, event] of events.entries()) {
    const { event_digest: _digest, ...preimage } = event;
    if (
      event.operation_id !== operation.operation_id ||
      event.sequence !== index ||
      event.previous_event_digest !== priorDigest ||
      digestV1(REVISION_OPERATION_EVENT_STORAGE.DIGEST_DOMAIN, preimage) !== event.event_digest ||
      (priorTime !== null && event.recorded_at < priorTime)
    )
      throw new Error("revision operation event sequence is invalid");
    if (event.payload.kind === REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION) {
      if (
        event.payload.from !== state ||
        !EDGES.has(revisionEdge(event.payload.from, event.payload.to))
      )
        throw new Error("illegal revision operation state transition");
      effectActionOperationId = validateRevisionTransitionAuthority(
        event.payload,
        effectActionOperationId,
      );
      state = event.payload.to;
    } else {
      const prefixDigest = revisionOperationFoldDigestUnchecked(operation, events.slice(0, index));
      validateRevisionAuxiliaryAuthority(
        operation,
        event.payload,
        state,
        effectActionOperationId,
        prefixDigest,
      );
      if (event.payload.kind === REVISION_OPERATION_EVENT_PAYLOAD_KIND.HEAD_COMMIT)
        state = PUBLIC_OPERATION_REVISION_PHASE.PUBLISHED;
      if (event.payload.kind === REVISION_OPERATION_EVENT_PAYLOAD_KIND.PARTICIPANT_START) {
        const receipt = event.payload.receipt;
        if (receipt.operation_id !== operation.operation_id)
          throw new Error("participant receipt operation mismatch");
        advanceParticipantReceipt(participantReceipts.get(receipt.participant_id), receipt);
        if (!options.preparationPlan)
          throw new Error("participant receipt preparation plan authority is absent");
        assertParticipantStartReceiptPlanBinding(operation, options.preparationPlan, receipt);
        participantReceipts.set(receipt.participant_id, receipt);
      }
    }
    priorDigest = event.event_digest;
    priorTime = event.recorded_at;
  }
  const stateDigest = revisionOperationFoldDigestUnchecked(operation, events);
  if (options.actionAuthority)
    validateRevisionActionAuthorityChain({
      operation,
      events,
      reader: options.actionAuthority,
    });
  return {
    state,
    last_sequence: events.length - 1,
    last_event_digest: priorDigest,
    effect_action_operation_id: effectActionOperationId,
    state_digest: stateDigest,
  };
}

function revisionOperationFoldDigestUnchecked(
  operation: RevisionOperationV1,
  events: readonly RevisionOperationEventV1[],
): string {
  return digestV1("VF-CONVERSATION-OPERATION-FOLD\0v1\0", {
    schema_version: "1.0",
    kind: "revision",
    root_session_id: operation.root_session_id,
    target_operation_id: operation.operation_id,
    operation_header_digest: operation.header_digest,
    events: events.map((event) => ({
      sequence: event.sequence,
      event_digest: event.event_digest,
    })),
  });
}

export function revisionOperationFoldDigest(
  operation: RevisionOperationV1,
  events: readonly RevisionOperationEventV1[],
): string {
  return foldRevisionOperation(operation, events).state_digest;
}
