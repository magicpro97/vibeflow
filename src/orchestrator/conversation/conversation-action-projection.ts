import {
  type ActionAuthoritySnapshotV1,
  type ActionOperationEventV1,
  type PublicOperationPhaseV1,
  projectActionSnapshot,
} from "../../actions/index.js";
import { expectedOperationStatus } from "../../actions/operation-phase-rules.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import type { ConversationActionReceiptV1 } from "./conversation-action-receipt-store.js";
import type { RevisionOperationEventV1 } from "./revision-planner.js";

function cursor(operationId: string, sequence: number, eventDigest: string): string {
  return `vf-operation-event-${digestHex(
    digestV1("VF-CONVERSATION-ACTION-EVENT-CURSOR\0v1\0", {
      schema_version: "1.0",
      operation_id: operationId,
      phase_sequence: sequence,
      revision_event_digest: eventDigest,
    }),
  )}`;
}

function revisionPhase(event: RevisionOperationEventV1): PublicOperationPhaseV1 | null {
  if (event.payload.kind === "head-commit") return "revision:published";
  if (event.payload.kind === "state-transition") return `revision:${event.payload.to}`;
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
      schema_version: "1.0",
      operation_id: operationId,
      phase_sequence: phaseSequence,
      state,
      progress: {
        sequence: phaseSequence,
        phase,
        status: expectedOperationStatus(phase, state),
        message_code: `operation.${phase}`,
        at: occurredAt,
      },
      target: null,
      error: null,
      occurred_at: occurredAt,
      event_cursor: cursor(operationId, phaseSequence, authorityDigest),
    });
  };
  append("dispatch", "committing", snapshot.approval.decided_at, snapshot.approval.approval_digest);
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
      event.payload.kind === "state-transition"
        ? event.payload.action_terminals.find(
            (binding) => binding.action_operation_id === operationId,
          )?.outcome
        : undefined;
    const state = terminal ?? "committing";
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
  return projectActionSnapshot(
    snapshot,
    receipt
      ? projectConversationReceiptEvents(snapshot, receipt)
      : projectRevisionActionEvents(snapshot, revisionEvents),
  );
}

function receiptPhase(receipt: ConversationActionReceiptV1): PublicOperationPhaseV1 {
  if (receipt.outcome === "failed") return "conversation-receipt:failed";
  if (receipt.outcome === "needs_recovery") return "conversation-receipt:needs_recovery";
  const phases = {
    "conversation.select_lineage_head": "lineage-head:committed",
    "conversation.associate_lineages": "lineage-association:committed",
    "conversation.publish_suspected_literal": "public-literal:published",
    "conversation.stop_operation": "conversation-receipt:succeeded",
    "context.compact": "context-compaction:committed",
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
      (event) => event.payload.kind === "state-transition" && event.payload.to === "committing",
    )?.recorded_at ?? snapshot.approval.decided_at;
  const phase = receiptPhase(receipt);
  const dispatch: ActionOperationEventV1 = {
    schema_version: "1.0",
    operation_id: operationId,
    phase_sequence: 0,
    state: "committing",
    progress: {
      sequence: 0,
      phase: "dispatch",
      status: "running",
      message_code: "operation.dispatch",
      at: dispatchAt,
    },
    target: null,
    error: null,
    occurred_at: dispatchAt,
    event_cursor: cursor(operationId, 0, snapshot.approval.approval_digest),
  };
  const terminal: ActionOperationEventV1 = {
    schema_version: "1.0",
    operation_id: operationId,
    phase_sequence: 1,
    state: receipt.outcome,
    progress: {
      sequence: 1,
      phase,
      status: expectedOperationStatus(phase, receipt.outcome),
      message_code: `operation.${phase}`,
      at: receipt.recorded_at,
    },
    target: null,
    error: null,
    occurred_at: receipt.recorded_at,
    event_cursor: cursor(operationId, 1, receipt.receipt_digest),
  };
  return [dispatch, terminal];
}
