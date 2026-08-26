import type { ConversationArtifactStore } from "./artifact-store.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type { RevisionReservationRecordV1 } from "./lineage-reservation.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import { foldRevisionOperation } from "./revision-fold.js";
import type { PreparedConversationRevisionV1 } from "./revision-operation-executor.js";
import { type RevisionOperationEventV1, materializeRevisionEvent } from "./revision-planner.js";
import { reconcilePublishedRevisionReservation } from "./revision-reservation-reconciliation.js";
import type {
  RevisionStartOwnerAuthority,
  RevisionStartOwnerTokenV1,
} from "./revision-start-owner.js";
import type { ConversationRuntime } from "./runtime.js";
import type { ConversationOrchestrationResult } from "./types.js";

type DurableStartTerminalV1 = {
  event: RevisionOperationEventV1;
  outcome: "succeeded" | "failed" | "needs_recovery";
  destination: "started" | "start_failed" | "needs_recovery";
};

function durableStartTerminal(
  operationId: string,
  events: readonly RevisionOperationEventV1[],
): DurableStartTerminalV1 | null {
  const matches = events.filter(
    (event) =>
      event.payload.kind === "state-transition" &&
      ((event.payload.from === "starting" &&
        ["started", "start_failed", "needs_recovery"].includes(event.payload.to)) ||
        (event.payload.from === "published" && event.payload.to === "needs_recovery")) &&
      event.payload.authorized_by_action_operation_id === operationId &&
      event.payload.effect_action_operation_id === operationId &&
      event.payload.action_terminals.some(
        (terminal) => terminal.action_operation_id === operationId,
      ),
  );
  if (matches.length > 1) throw new Error("revision start terminal authority is duplicated");
  const event = matches[0];
  if (!event || event.payload.kind !== "state-transition") return null;
  const terminal = event.payload.action_terminals.find(
    (candidate) => candidate.action_operation_id === operationId,
  );
  if (!terminal) throw new Error("revision start terminal authority is absent");
  return {
    event,
    outcome: terminal.outcome,
    destination: event.payload.to as DurableStartTerminalV1["destination"],
  };
}

function mirrorActionTerminal(input: {
  proposalId: string;
  operationId: string;
  home: ConversationHomeAuthorities;
  terminal: DurableStartTerminalV1;
}): void {
  input.home.actions.terminal(input.proposalId, input.operationId, {
    outcome: input.terminal.outcome,
    digest: input.terminal.event.event_digest,
    recorded_at: input.terminal.event.recorded_at,
  });
}

/** Mirrors an already-durable start terminal without replaying lanes, events, or effects. */
export function reconcilePublishedRevisionStartTerminal(input: {
  operation: RevisionOperationV1;
  proposalId: string;
  home: ConversationHomeAuthorities;
}): boolean {
  if (input.operation.proposal_id !== input.proposalId)
    throw new Error("published revision proposal binding changed");
  const events = input.home.revisions.readEvents(input.operation.operation_id);
  const terminal = durableStartTerminal(input.operation.operation_id, events);
  if (!terminal) return false;
  mirrorActionTerminal({
    proposalId: input.proposalId,
    operationId: input.operation.operation_id,
    home: input.home,
    terminal,
  });
  return true;
}

function appendOriginalActionTerminal(input: {
  operation: RevisionOperationV1;
  events: RevisionOperationEventV1[];
  from: "published" | "starting";
  destination: "started" | "start_failed" | "needs_recovery";
  outcome: DurableStartTerminalV1["outcome"];
  reason: string | null;
  proposalId: string;
  home: ConversationHomeAuthorities;
  owner: RevisionStartOwnerTokenV1;
}): void {
  try {
    const recordedAt = input.events.at(-1)?.recorded_at ?? input.operation.created_at;
    const terminal = materializeRevisionEvent(
      input.operation,
      input.events,
      {
        kind: "state-transition",
        from: input.from,
        to: input.destination,
        authorized_by_action_operation_id: input.operation.operation_id,
        effect_action_operation_id: input.operation.operation_id,
        action_terminals: [
          {
            action_operation_id: input.operation.operation_id,
            outcome: input.outcome,
            reason_code: input.reason,
          },
        ],
        reason_code: input.reason,
      },
      recordedAt,
    );
    input.owner.assertHeld();
    input.home.revisions.appendEvent(input.operation, terminal);
    mirrorActionTerminal({
      proposalId: input.proposalId,
      operationId: input.operation.operation_id,
      home: input.home,
      terminal: { event: terminal, outcome: input.outcome, destination: input.destination },
    });
  } catch (error) {
    const currentEvents = input.home.revisions.readEvents(input.operation.operation_id);
    if (foldRevisionOperation(input.operation, currentEvents).state !== input.destination)
      throw error;
    const terminal = durableStartTerminal(input.operation.operation_id, currentEvents);
    if (!terminal) throw error;
    mirrorActionTerminal({
      proposalId: input.proposalId,
      operationId: input.operation.operation_id,
      home: input.home,
      terminal,
    });
  }
}

function finalizePublishedRevisionStartAuthority(input: {
  operation: RevisionOperationV1;
  revisionPlan: RevisionPreparationPlanV1;
  proposalId: string;
  resultStatus: ConversationOrchestrationResult["status"];
  home: ConversationHomeAuthorities;
  artifactStore: ConversationArtifactStore;
  owner: RevisionStartOwnerTokenV1;
}): DurableStartTerminalV1["destination"] | null {
  const operation = input.operation;
  if (operation.proposal_id !== input.proposalId)
    throw new Error("published revision proposal binding changed");
  let events = input.home.revisions.readEvents(operation.operation_id);
  const state = foldRevisionOperation(operation, events).state;
  const durableTerminal = durableStartTerminal(operation.operation_id, events);
  if (durableTerminal) {
    mirrorActionTerminal({
      proposalId: input.proposalId,
      operationId: operation.operation_id,
      home: input.home,
      terminal: durableTerminal,
    });
    return durableTerminal.destination;
  }
  if (state !== "starting") return null;
  input.owner.assertHeld();
  const destination = input.home.revisionLanes.finalize(
    operation,
    input.revisionPlan,
    input.resultStatus,
    input.artifactStore,
  );
  events = input.home.revisions.readEvents(operation.operation_id);
  const outcome =
    destination === "started"
      ? "succeeded"
      : destination === "start_failed"
        ? "failed"
        : "needs_recovery";
  const reason =
    destination === "started"
      ? null
      : destination === "start_failed"
        ? "child_start_failed"
        : "child_start_uncertain";
  appendOriginalActionTerminal({
    operation,
    events,
    from: "starting",
    destination,
    outcome,
    reason,
    proposalId: input.proposalId,
    home: input.home,
    owner: input.owner,
  });
  return destination;
}

export function finalizePublishedRevisionStart(input: {
  prepared: PreparedConversationRevisionV1;
  resultStatus: ConversationOrchestrationResult["status"];
  home: ConversationHomeAuthorities;
  artifactStore: ConversationArtifactStore;
  owner: RevisionStartOwnerTokenV1;
}): DurableStartTerminalV1["destination"] | null {
  return finalizePublishedRevisionStartAuthority({
    operation: input.prepared.operation,
    revisionPlan: input.prepared.revisionPlan,
    proposalId: input.prepared.proposal.proposal_id,
    resultStatus: input.resultStatus,
    home: input.home,
    artifactStore: input.artifactStore,
    owner: input.owner,
  });
}

/** Same-owner fallback when the synchronous append/scheduler handoff fails. */
export function interruptPublishedRevisionStart(input: {
  prepared: PreparedConversationRevisionV1;
  home: ConversationHomeAuthorities;
  owner: RevisionStartOwnerTokenV1;
}): boolean {
  const operation = input.prepared.operation;
  const events = input.home.revisions.readEvents(operation.operation_id);
  const state = foldRevisionOperation(operation, events).state;
  if (state !== "published" && state !== "starting")
    return durableStartTerminal(operation.operation_id, events) !== null;
  appendOriginalActionTerminal({
    operation,
    events,
    from: state,
    destination: "needs_recovery",
    outcome: "needs_recovery",
    reason: "child_start_uncertain",
    proposalId: input.prepared.proposal.proposal_id,
    home: input.home,
    owner: input.owner,
  });
  return true;
}

/**
 * Closes an interrupted start without borrowing provider or child authority.
 * The durable revision/action terminal is the recovery boundary; lanes and the
 * child runtime remain untouched for explicit inspected recovery.
 */
export async function recoverInterruptedPublishedRevisionStart(input: {
  operation: RevisionOperationV1;
  revisionPlan: RevisionPreparationPlanV1;
  reservation: RevisionReservationRecordV1;
  proposalId: string;
  runtime: ConversationRuntime;
  home: ConversationHomeAuthorities;
  artifactStore: ConversationArtifactStore;
  startOwners: RevisionStartOwnerAuthority;
}): Promise<boolean> {
  if (
    reconcilePublishedRevisionStartTerminal({
      operation: input.operation,
      proposalId: input.proposalId,
      home: input.home,
    })
  )
    return true;
  const events = input.home.revisions.readEvents(input.operation.operation_id);
  const state = foldRevisionOperation(input.operation, events).state;
  if (state !== "published" && state !== "starting") return false;
  if (
    input.revisionPlan.root_session_id !== input.operation.root_session_id ||
    input.revisionPlan.parent.conversation_id !== input.operation.parent.conversation_id ||
    input.revisionPlan.parent.revision_id !== input.operation.parent.revision_id
  )
    throw new Error("published revision start plan binding changed");
  const childId = input.operation.child.conversation_id;
  const owner = input.runtime.operationOwnerState(childId, input.operation.operation_id);
  if (owner === "conversation_mismatch")
    throw new Error("published revision child live authority changed");
  if (owner === "local" || owner === "same_process_live") return false;
  const recoveryOwner = input.startOwners.claimDead(input.operation.operation_id);
  if (!recoveryOwner) return false;
  let terminal = false;
  try {
    recoveryOwner.assertHeld();
    input.home.revisions.publish(input.operation.operation_id);
    recoveryOwner.assertHeld();
    input.artifactStore.publishRevision(
      childId,
      input.operation.operation_id,
      input.operation.created_at,
    );
    recoveryOwner.assertHeld();
    reconcilePublishedRevisionReservation({
      lineage: input.home.lineage,
      reservation: input.reservation,
      consumedAt: input.operation.created_at,
    });
    const latestEvents = input.home.revisions.readEvents(input.operation.operation_id);
    const latestState = foldRevisionOperation(input.operation, latestEvents).state;
    if (latestState !== "published" && latestState !== "starting") {
      terminal = reconcilePublishedRevisionStartTerminal({
        operation: input.operation,
        proposalId: input.proposalId,
        home: input.home,
      });
      return terminal;
    }
    appendOriginalActionTerminal({
      operation: input.operation,
      events: latestEvents,
      from: latestState,
      destination: "needs_recovery",
      outcome: "needs_recovery",
      reason: "child_start_uncertain",
      proposalId: input.proposalId,
      home: input.home,
      owner: recoveryOwner,
    });
    terminal = true;
    return true;
  } finally {
    if (!terminal)
      try {
        terminal = ["started", "start_failed", "needs_recovery"].includes(
          foldRevisionOperation(
            input.operation,
            input.home.revisions.readEvents(input.operation.operation_id),
          ).state,
        );
      } catch {
        // An unverifiable terminal must retain the owner proof until process death.
      }
    if (terminal) recoveryOwner.release();
  }
}

export async function retryPublishedRevisionStart(
  prepared: PreparedConversationRevisionV1,
  options: {
    home: ConversationHomeAuthorities;
    artifactStore: ConversationArtifactStore;
    owner: RevisionStartOwnerTokenV1;
    executeConfigured(
      manifest: PreparedConversationRevisionV1["manifest"],
      operationId: string,
    ): Promise<unknown>;
  },
): Promise<boolean> {
  try {
    const destination = finalizePublishedRevisionStart({
      prepared,
      resultStatus: "completed",
      home: options.home,
      artifactStore: options.artifactStore,
      owner: options.owner,
    });
    if (destination !== "started") return destination === "needs_recovery";
    options.owner.assertHeld();
    await options.executeConfigured(prepared.manifest, prepared.runtimeOperationId);
    return true;
  } catch {
    return false;
  }
}
