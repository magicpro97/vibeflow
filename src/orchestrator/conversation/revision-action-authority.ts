import {
  type ActionAuthoritySnapshotV1,
  type DurableActionAuthorityReaderV1,
  type HostActionV1,
  assertDurableActionAuthorityReaderV1,
  deriveOperationId,
} from "../../actions/index.js";
import type { RevisionOperationV1 } from "./lineage-revision-operation.js";
import type { RevisionOperationEventV1 } from "./revision-planner.js";

const REVISION_MUTATIONS = new Set<HostActionV1["type"]>([
  "conversation.add_participant",
  "conversation.remove_participant",
  "conversation.update_participant",
  "conversation.update_settings",
  "conversation.continue_message",
]);

function terminalOutcome(state: ActionAuthoritySnapshotV1["state"]) {
  return state === "succeeded" || state === "failed" || state === "needs_recovery" ? state : null;
}

function actionSnapshot(input: {
  reader: DurableActionAuthorityReaderV1;
  operation: RevisionOperationV1;
  actionOperationId: string;
}): ActionAuthoritySnapshotV1 {
  const dispatch = input.reader.getDispatch(input.actionOperationId);
  const proposalId =
    dispatch?.proposal_id ??
    (input.actionOperationId === input.operation.operation_id ? input.operation.proposal_id : null);
  const snapshot = proposalId ? input.reader.getRecorded(proposalId) : null;
  const approval = snapshot?.approval;
  if (
    !snapshot ||
    !approval ||
    approval.decision !== "approved" ||
    snapshot.proposal.domain !== "conversation" ||
    snapshot.proposal.base.root_session_id !== input.operation.root_session_id ||
    deriveOperationId(snapshot.proposal, approval.approval_id) !== input.actionOperationId
  )
    throw new Error("revision action approval authority is absent");
  if (input.actionOperationId === input.operation.operation_id) {
    if (
      snapshot.proposal.proposal_id !== input.operation.proposal_id ||
      snapshot.proposal.proposal_digest !== input.operation.proposal_digest ||
      approval.approval_id !== input.operation.approval_id ||
      approval.approval_digest !== input.operation.approval_digest ||
      snapshot.proposal.plan_digest !== input.operation.plan_digest ||
      snapshot.proposal.base.authority_epoch !== input.operation.authority_epoch ||
      snapshot.proposal.base.authority_head_digest !== input.operation.authority_head_digest ||
      !REVISION_MUTATIONS.has(snapshot.proposal.action.type)
    )
      throw new Error("revision header action authority changed");
  } else {
    const action = snapshot.proposal.action;
    if (
      ![
        "conversation.abandon_revision_operation",
        "conversation.retry_revision_operation",
        "conversation.reconcile_revision_operation",
      ].includes(action.type) ||
      !("revision_operation_id" in action) ||
      action.revision_operation_id !== input.operation.operation_id
    )
      throw new Error("revision control action authority changed");
  }
  if (dispatch) {
    if (
      snapshot.operation_id !== input.actionOperationId ||
      snapshot.dispatch_record_digest !== dispatch.dispatch_record_digest ||
      dispatch.domain !== "conversation" ||
      dispatch.domain_header_digest !== input.operation.header_digest ||
      dispatch.proposal_digest !== snapshot.proposal.proposal_digest ||
      dispatch.approval_id !== approval.approval_id ||
      dispatch.approval_digest !== approval.approval_digest ||
      dispatch.action_type !== snapshot.proposal.action.type ||
      dispatch.plan_digest !== snapshot.proposal.plan_digest
    )
      throw new Error("revision action dispatch authority changed");
  } else if (
    input.actionOperationId !== input.operation.operation_id ||
    snapshot.state !== "approved"
  )
    throw new Error("revision action has no committing dispatch");
  return snapshot;
}

function expectedControlAction(event: RevisionOperationEventV1): HostActionV1["type"] | null {
  const payload = event.payload;
  if (payload.kind === "reconciliation-result") return "conversation.reconcile_revision_operation";
  if (payload.kind !== "state-transition") return null;
  if (payload.from === "start_failed" && payload.to === "starting")
    return "conversation.retry_revision_operation";
  if (payload.from === "needs_recovery") return "conversation.reconcile_revision_operation";
  if (
    payload.to === "abandoned" &&
    payload.authorized_by_action_operation_id !== payload.effect_action_operation_id
  )
    return "conversation.abandon_revision_operation";
  return null;
}

/** Validates every authorizer/effect/terminal against the concrete Action Authority WAL. */
export function validateRevisionActionAuthorityChain(input: {
  operation: RevisionOperationV1;
  events: readonly RevisionOperationEventV1[];
  reader: DurableActionAuthorityReaderV1;
}): void {
  assertDurableActionAuthorityReaderV1(input.reader);
  const snapshots = new Map<string, ActionAuthoritySnapshotV1>();
  const terminals = new Map<
    string,
    Array<{ event: RevisionOperationEventV1; outcome: "succeeded" | "failed" | "needs_recovery" }>
  >();
  const resolve = (id: string) => {
    let snapshot = snapshots.get(id);
    if (!snapshot) {
      snapshot = actionSnapshot({
        reader: input.reader,
        operation: input.operation,
        actionOperationId: id,
      });
      snapshots.set(id, snapshot);
    }
    return snapshot;
  };
  for (const event of input.events) {
    const payload = event.payload;
    const authorizer = payload.authorized_by_action_operation_id;
    const effect = payload.effect_action_operation_id;
    const effectSnapshot = resolve(effect);
    if (
      !input.reader.getDispatch(effect) &&
      (event.sequence !== 0 || effect !== input.operation.operation_id)
    )
      throw new Error("revision action has no committing dispatch");
    if (
      effect !== input.operation.operation_id &&
      effectSnapshot.proposal.action.type !== "conversation.retry_revision_operation"
    )
      throw new Error("revision effect is not authorized by a retry action");
    const control = expectedControlAction(event);
    if (authorizer !== effect) {
      const authorizerSnapshot = resolve(authorizer);
      if (!control || authorizerSnapshot.proposal.action.type !== control)
        throw new Error("revision control authorizer is broader than its event");
    } else if (control && effectSnapshot.proposal.action.type !== control) {
      const family = control === "conversation.retry_revision_operation" ? "retry" : "control";
      throw new Error(`revision ${family} action does not authorize its control transition`);
    }
    if (!("action_terminals" in payload)) continue;
    for (const terminal of payload.action_terminals) {
      resolve(terminal.action_operation_id);
      const rows = terminals.get(terminal.action_operation_id) ?? [];
      rows.push({ event, outcome: terminal.outcome });
      terminals.set(terminal.action_operation_id, rows);
    }
  }
  for (const [id, snapshot] of snapshots) {
    const terminal = terminalOutcome(snapshot.state);
    const rows = terminals.get(id) ?? [];
    if (!terminal) continue;
    const row = rows[0];
    const actionTerminal = snapshot.events.at(-1);
    if (
      rows.length !== 1 ||
      !row ||
      row.outcome !== terminal ||
      snapshot.domain_terminal_digest !== row.event.event_digest ||
      actionTerminal?.recorded_at !== row.event.recorded_at
    )
      throw new Error("revision action terminal mirror changed");
  }
}
