import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  ACTION_AUTHORITY_EVENT_KIND,
  ACTION_OPERATION_EVENT_SCHEMA_VERSION,
  ACTION_OPERATION_STATE,
  type ActionAuthoritySnapshotV1,
  type ActionOperationEventV1,
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_MESSAGE_CODE_PREFIX,
  PUBLIC_OPERATION_PREFIXED_PHASE,
  PUBLIC_OPERATION_PROGRESS_STATUS,
  type PublicOperationPhaseV1,
  projectActionSnapshot,
} from "../../actions/index.js";
import { expectedOperationStatus } from "../../actions/operation-phase-rules.js";
import { publicOperationRevisionPhase } from "../../actions/public-operation-semantics.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import type { ConversationActionReceiptV1 } from "./conversation-action-receipt-store.js";
import { REVISION_OPERATION_EVENT_PAYLOAD_KIND } from "./revision-operation-event-contract.js";
import type { RevisionOperationEventV1 } from "./revision-planner.js";

function cursor(operationId: string, sequence: number, eventDigest: string): string {
  return `vf-operation-event-${digestHex(
    digestV1("VF-CONVERSATION-ACTION-EVENT-CURSOR\0v1\0", {
      schema_version: ACTION_OPERATION_EVENT_SCHEMA_VERSION,
      operation_id: operationId,
      phase_sequence: sequence,
      revision_event_digest: eventDigest,
    }),
  )}`;
}

function revisionPhase(event: RevisionOperationEventV1): PublicOperationPhaseV1 | null {
  if (event.payload.kind === REVISION_OPERATION_EVENT_PAYLOAD_KIND.HEAD_COMMIT)
    return PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.PUBLISHED;
  if (event.payload.kind === REVISION_OPERATION_EVENT_PAYLOAD_KIND.RECONCILIATION_RESULT)
    return PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.NEEDS_RECOVERY;
  if (event.payload.kind === REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION)
    return publicOperationRevisionPhase(event.payload.to);
  return null;
}

export function projectRevisionActionEvents(
  snapshot: ActionAuthoritySnapshotV1,
  revisionEvents: readonly RevisionOperationEventV1[],
): ActionOperationEventV1[] {
  const operationId = snapshot.operation_id;
  if (!operationId || !snapshot.approval) return [];
  const output: ActionOperationEventV1[] = [];
  const append = (
    phase: PublicOperationPhaseV1,
    state: ActionOperationEventV1["state"],
    occurredAt: string,
    authorityDigest: string,
  ) => {
    const phaseSequence = output.length;
    output.push({
      schema_version: ACTION_OPERATION_EVENT_SCHEMA_VERSION,
      operation_id: operationId,
      phase_sequence: phaseSequence,
      state,
      progress: {
        sequence: phaseSequence,
        phase,
        status: expectedOperationStatus(phase, state),
        message_code: `${PUBLIC_OPERATION_MESSAGE_CODE_PREFIX}${phase}`,
        at: occurredAt,
      },
      target: null,
      error: null,
      occurred_at: occurredAt,
      event_cursor: cursor(operationId, phaseSequence, authorityDigest),
    });
  };
  append(
    PUBLIC_OPERATION_FIXED_PHASE.DISPATCH,
    ACTION_OPERATION_STATE.COMMITTING,
    snapshot.approval.decided_at,
    snapshot.approval.approval_digest,
  );
  for (const event of revisionEvents) {
    const payload = event.payload;
    const relevant =
      "authorized_by_action_operation_id" in payload &&
      (payload.authorized_by_action_operation_id === operationId ||
        payload.effect_action_operation_id === operationId ||
        ("action_terminals" in payload &&
          payload.action_terminals.some((row) => row.action_operation_id === operationId)));
    if (!relevant) continue;
    const phase = revisionPhase(event);
    if (!phase) continue;
    const terminal =
      "action_terminals" in payload
        ? payload.action_terminals.find((binding) => binding.action_operation_id === operationId)
            ?.outcome
        : undefined;
    const state = terminal ?? ACTION_OPERATION_STATE.COMMITTING;
    append(phase, state, event.recorded_at, event.event_digest);
    if (terminal) break;
  }
  return output;
}

export function projectConversationActionSnapshot(
  snapshot: ActionAuthoritySnapshotV1,
  revisionEvents: readonly RevisionOperationEventV1[],
  receipt: ConversationActionReceiptV1 | null = null,
) {
  const events = receipt
    ? projectConversationReceiptEvents(snapshot, receipt)
    : projectRevisionActionEvents(snapshot, revisionEvents);
  return projectActionSnapshot(snapshot, events);
}

function receiptPhase(receipt: ConversationActionReceiptV1): PublicOperationPhaseV1 {
  if (receipt.outcome === ACTION_OPERATION_STATE.FAILED)
    return PUBLIC_OPERATION_PREFIXED_PHASE.CONVERSATION_RECEIPT.FAILED;
  if (receipt.outcome === ACTION_OPERATION_STATE.NEEDS_RECOVERY)
    return PUBLIC_OPERATION_PREFIXED_PHASE.CONVERSATION_RECEIPT.NEEDS_RECOVERY;
  const phases = {
    [HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD]:
      PUBLIC_OPERATION_FIXED_PHASE.LINEAGE_HEAD_COMMITTED,
    [HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES]:
      PUBLIC_OPERATION_FIXED_PHASE.LINEAGE_ASSOCIATION_COMMITTED,
    [HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL]:
      PUBLIC_OPERATION_FIXED_PHASE.PUBLIC_LITERAL_PUBLISHED,
    [HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION]:
      PUBLIC_OPERATION_PREFIXED_PHASE.CONVERSATION_RECEIPT.SUCCEEDED,
    [HOST_ACTION_KIND.CONTEXT_COMPACT]: PUBLIC_OPERATION_FIXED_PHASE.CONTEXT_COMPACTION_COMMITTED,
  } as const;
  return phases[receipt.action_type];
}

export function projectConversationReceiptEvents(
  snapshot: ActionAuthoritySnapshotV1,
  receipt: ConversationActionReceiptV1,
): ActionOperationEventV1[] {
  const operationId = snapshot.operation_id;
  if (!operationId || !snapshot.approval) return [];
  const dispatchAt =
    snapshot.events.find(
      (event) =>
        event.payload.kind === ACTION_AUTHORITY_EVENT_KIND.STATE_TRANSITION &&
        event.payload.to === ACTION_OPERATION_STATE.COMMITTING,
    )?.recorded_at ?? snapshot.approval.decided_at;
  const phase = receiptPhase(receipt);
  const dispatch: ActionOperationEventV1 = {
    schema_version: ACTION_OPERATION_EVENT_SCHEMA_VERSION,
    operation_id: operationId,
    phase_sequence: 0,
    state: ACTION_OPERATION_STATE.COMMITTING,
    progress: {
      sequence: 0,
      phase: PUBLIC_OPERATION_FIXED_PHASE.DISPATCH,
      status: PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
      message_code: `${PUBLIC_OPERATION_MESSAGE_CODE_PREFIX}${PUBLIC_OPERATION_FIXED_PHASE.DISPATCH}`,
      at: dispatchAt,
    },
    target: null,
    error: null,
    occurred_at: dispatchAt,
    event_cursor: cursor(operationId, 0, snapshot.approval.approval_digest),
  };
  const terminal: ActionOperationEventV1 = {
    schema_version: ACTION_OPERATION_EVENT_SCHEMA_VERSION,
    operation_id: operationId,
    phase_sequence: 1,
    state: receipt.outcome,
    progress: {
      sequence: 1,
      phase,
      status: expectedOperationStatus(phase, receipt.outcome),
      message_code: `${PUBLIC_OPERATION_MESSAGE_CODE_PREFIX}${phase}`,
      at: receipt.recorded_at,
    },
    target: null,
    error: null,
    occurred_at: receipt.recorded_at,
    event_cursor: cursor(operationId, 1, receipt.receipt_digest),
  };
  return [dispatch, terminal];
}
