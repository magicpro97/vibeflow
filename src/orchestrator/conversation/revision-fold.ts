import type { DurableActionAuthorityReaderV1 } from "../../actions/index.js";
import { digestV1 } from "../../durability/index.js";
import type { RevisionOperationV1 } from "./lineage-revision-operation.js";
import { validateRevisionActionAuthorityChain } from "./revision-action-authority.js";
import {
  validateRevisionAuxiliaryAuthority,
  validateRevisionTransitionAuthority,
} from "./revision-fold-validation.js";
import {
  type ParticipantStartReceiptV1,
  advanceParticipantReceipt,
} from "./revision-participant-receipt.js";
import type { RevisionOperationEventV1, RevisionOperationStateV1 } from "./revision-planner.js";

const EDGES = new Set([
  "created\0preparing",
  "preparing\0prepared",
  "preparing\0abandoned",
  "preparing\0needs_recovery",
  "prepared\0abandoned",
  "prepared\0needs_recovery",
  "published\0starting",
  "published\0needs_recovery",
  "starting\0started",
  "starting\0start_failed",
  "starting\0needs_recovery",
  "start_failed\0starting",
  "start_failed\0needs_recovery",
  "needs_recovery\0preparing",
  "needs_recovery\0prepared",
  "needs_recovery\0published",
  "needs_recovery\0starting",
  "needs_recovery\0started",
  "needs_recovery\0start_failed",
  "needs_recovery\0abandoned",
]);

export interface FoldedRevisionOperationV1 {
  state: RevisionOperationStateV1 | "created";
  last_sequence: number;
  last_event_digest: string | null;
  effect_action_operation_id: string;
  state_digest: string;
}

export function foldRevisionOperation(
  operation: RevisionOperationV1,
  events: readonly RevisionOperationEventV1[],
  options: { actionAuthority?: DurableActionAuthorityReaderV1 } = {},
): FoldedRevisionOperationV1 {
  let state: RevisionOperationStateV1 | "created" = "created";
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
      digestV1("VF-REVISION-OPERATION-EVENT\0v1\0", preimage) !== event.event_digest ||
      (priorTime !== null && event.recorded_at < priorTime)
    )
      throw new Error("revision operation event sequence is invalid");
    if (event.payload.kind === "state-transition") {
      if (event.payload.from !== state || !EDGES.has(`${event.payload.from}\0${event.payload.to}`))
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
      if (event.payload.kind === "head-commit") state = "published";
      if (event.payload.kind === "participant-start") {
        const receipt = event.payload.receipt;
        if (receipt.operation_id !== operation.operation_id)
          throw new Error("participant receipt operation mismatch");
        advanceParticipantReceipt(participantReceipts.get(receipt.participant_id), receipt);
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
