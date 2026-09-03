import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  ACTION_OPERATION_STATE,
  type ActionProposalRequestV1,
  type ActionRequestAuthorityV1,
  type BrowserHostActionRequestV1,
  type HostActionV1,
  PUBLIC_OPERATION_REVISION_PHASE,
  deriveOperationId,
} from "../../actions/index.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import { materializeRevisionControlEffectClosure } from "./conversation-control-effect-planner.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type { RevisionOperationV1 } from "./lineage-revision-operation.js";
import type { ConversationLineageService } from "./lineage-service.js";
import {
  inspectRevisionRecovery,
  revisionAbandonIsProved,
  revisionRetryIsProved,
} from "./revision-control-evidence.js";
import {
  REVISION_CONTROL_ACTIONS,
  type RevisionControlCandidateV1,
  isRevisionControlCandidate,
  proposeRevisionControlAction,
} from "./revision-control-proposal.js";
import { executeRevisionRetry } from "./revision-control-retry.js";
import { foldRevisionOperation } from "./revision-fold.js";
import type { RevisionLaneRetryRuntime } from "./revision-lane-retry-runtime.js";
import {
  REVISION_OPERATION_EVENT_PAYLOAD_KIND,
  REVISION_OPERATION_INITIAL_PHASE,
} from "./revision-operation-event-contract.js";
import {
  type RevisionActionTerminalBindingV1,
  type RevisionOperationEventV1,
  materializeRevisionEvent,
} from "./revision-planner.js";
import type { RevisionOperationStateV1 } from "./revision-planner.js";
import { materializeReleasedRevisionReservation } from "./revision-planner.js";

function later(left: string, right: string): string {
  return left < right ? right : left;
}

export class ConversationRevisionControlAuthority {
  constructor(
    private readonly options: {
      lineages: ConversationLineageService;
      home: ConversationHomeAuthorities;
      quiescent(conversationId: string, operationId: string): boolean;
      retry(
        input: Parameters<RevisionLaneRetryRuntime["retry"]>[0],
      ): ReturnType<RevisionLaneRetryRuntime["retry"]>;
      wake(conversationId: string): void;
      artifactStore: ConversationArtifactStore;
    },
  ) {}

  supports(candidate: { type: string }): boolean {
    return REVISION_CONTROL_ACTIONS.has(candidate.type as BrowserHostActionRequestV1["type"]);
  }

  async propose(input: {
    conversation_id: string;
    request: ActionProposalRequestV1;
    authority: ActionRequestAuthorityV1;
  }) {
    return proposeRevisionControlAction({ ...this.options, ...input });
  }

  private target(proposalId: string) {
    const snapshot = this.options.home.actions.get(proposalId);
    const stored = this.options.home.actionReceipts.readPlan(proposalId);
    if (!snapshot?.approval || !stored || !this.supports(snapshot.proposal.action))
      throw new Error("revision control approval is absent");
    const approval = snapshot.approval;
    const action = snapshot.proposal.action as Extract<
      HostActionV1,
      { type: RevisionControlCandidateV1["type"] }
    >;
    const operation = this.options.home.revisions.readOperation(action.revision_operation_id);
    if (!operation) throw new Error("revision control target operation disappeared");
    return { snapshot, approval, stored, action, operation };
  }

  private terminalEvent(events: readonly RevisionOperationEventV1[], actionOperationId: string) {
    return events.find(
      (event) =>
        "action_terminals" in event.payload &&
        event.payload.action_terminals.some(
          (terminal) => terminal.action_operation_id === actionOperationId,
        ),
    );
  }

  async commit(proposalId: string): Promise<void> {
    const { snapshot, approval, stored, action, operation } = this.target(proposalId);
    try {
      const actionOperationId =
        snapshot.operation_id ?? deriveOperationId(snapshot.proposal, approval.approval_id);
      let events = this.options.home.revisions.readEvents(operation.operation_id);
      const replay = this.terminalEvent(events, actionOperationId);
      if (replay) return this.mirrorTerminal(proposalId, actionOperationId, replay);
      const expected = stored.native_plan.effect_binding as {
        expected_operation_header_digest: string;
        expected_operation_state_digest: string;
        expected_lineage_head_digest: string;
        expected_effect_action_operation_id: string | null;
        control_effect_plan_digest: string;
      };
      const preparation = this.options.home.revisions.readPlan(operation.operation_id);
      if (!preparation) throw new Error("revision control preparation plan disappeared");
      const folded = foldRevisionOperation(operation, events, {
        preparationPlan: preparation,
      });
      let resolved: ReturnType<ConversationLineageService["resolve"]>;
      try {
        resolved = this.options.lineages.resolve(stored.native_plan.root_session_id);
      } catch {
        resolved = this.options.lineages.resolveRevisionRecovery(
          operation.parent.conversation_id,
          operation.root_session_id,
          operation.operation_id,
        );
      }
      const head = resolved.head;
      if (
        expected.expected_operation_header_digest !== operation.header_digest ||
        expected.expected_operation_state_digest !== folded.state_digest ||
        expected.expected_lineage_head_digest !== head.content_digest ||
        expected.expected_effect_action_operation_id !==
          (action.type === HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION
            ? folded.effect_action_operation_id
            : null)
      )
        throw new Error("revision control authority changed before dispatch");
      const rematerialized = materializeRevisionControlEffectClosure({
        action_type: action.type,
        operation,
        preparation,
        events,
        expected_pre_effect_fold_digest: folded.state_digest,
      });
      const effectPlan = this.options.home.controlEffects.assertForAction({
        plan_digest: expected.control_effect_plan_digest,
        action_type: action.type,
        target_operation_id: operation.operation_id,
        expected_pre_effect_fold_digest: folded.state_digest,
      });
      if (effectPlan.plan_digest !== rematerialized.plan.plan_digest)
        throw new Error("revision control effect plan authority changed before dispatch");
      this.options.home.actions.bindHeader(proposalId, operation.header_digest);
      const dispatch = this.options.home.actions.dispatch(proposalId, approval.approval_id, {
        digest: stored.record_digest,
        recorded_at: approval.decided_at,
      });
      if (action.type === HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION) {
        if (
          !revisionAbandonIsProved({
            home: this.options.home,
            lineages: this.options.lineages,
            operation,
            events,
            quiescent: this.options.quiescent(
              operation.child.conversation_id,
              operation.operation_id,
            ),
          })
        )
          throw new Error("revision abandon no longer proves absent and quiescent effects");
        if (folded.state === REVISION_OPERATION_INITIAL_PHASE.CREATED)
          throw new Error("revision operation was never prepared");
        events = this.appendTransition(
          operation,
          events,
          folded.state,
          PUBLIC_OPERATION_REVISION_PHASE.ABANDONED,
          dispatch.operation_id,
          folded.effect_action_operation_id,
          [
            ...(folded.state === PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY
              ? []
              : [
                  {
                    action_operation_id: folded.effect_action_operation_id,
                    outcome: ACTION_OPERATION_STATE.FAILED,
                    reason_code: "abandoned_by_review",
                  },
                ]),
            {
              action_operation_id: dispatch.operation_id,
              outcome: ACTION_OPERATION_STATE.SUCCEEDED,
              reason_code: null,
            },
          ],
          "abandoned_by_review",
        );
        const reservation = this.options.home.lineage.readReservation(operation.root_session_id);
        if (reservation?.status === "active" && reservation.operation_id === operation.operation_id)
          this.options.home.lineage.commitReservation(
            reservation,
            materializeReleasedRevisionReservation(reservation, events.at(-1)?.recorded_at),
          );
      } else if (action.type === HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION) {
        const inspection = inspectRevisionRecovery({
          home: this.options.home,
          lineages: this.options.lineages,
          operation,
          events,
          quiescent: this.options.quiescent(
            operation.child.conversation_id,
            operation.operation_id,
          ),
        });
        if (inspection.kind === "inconclusive") {
          const event = materializeRevisionEvent(
            operation,
            events,
            {
              kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.RECONCILIATION_RESULT,
              authorized_by_action_operation_id: dispatch.operation_id,
              effect_action_operation_id: folded.effect_action_operation_id,
              observed_state_digest: folded.state_digest,
              outcome: ACTION_OPERATION_STATE.FAILED,
              action_terminals: [
                {
                  action_operation_id: dispatch.operation_id,
                  outcome: ACTION_OPERATION_STATE.FAILED,
                  reason_code: inspection.reason_code,
                },
              ],
              reason_code: inspection.reason_code,
            },
            later(this.options.home.now(), events.at(-1)?.recorded_at ?? operation.created_at),
          );
          this.options.home.revisions.appendEvent(operation, event);
          events = [...events, event];
        } else {
          const terminals: RevisionActionTerminalBindingV1[] = [
            {
              action_operation_id: dispatch.operation_id,
              outcome: ACTION_OPERATION_STATE.SUCCEEDED,
              reason_code: null,
            },
          ];
          events = this.appendTransition(
            operation,
            events,
            PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY,
            inspection.state,
            dispatch.operation_id,
            folded.effect_action_operation_id,
            terminals,
            inspection.state === PUBLIC_OPERATION_REVISION_PHASE.START_FAILED
              ? "reconciled_start_failure"
              : null,
          );
        }
      } else {
        if (
          !revisionRetryIsProved({
            home: this.options.home,
            lineages: this.options.lineages,
            operation,
            events,
            quiescent: this.options.quiescent(
              operation.child.conversation_id,
              operation.operation_id,
            ),
          })
        )
          throw new Error("revision retry no longer proves canceled and quiescent lanes");
        const plan = this.options.home.revisions.readPlan(operation.operation_id);
        if (!plan) throw new Error("revision retry preparation plan disappeared");
        events = this.appendTransition(
          operation,
          events,
          PUBLIC_OPERATION_REVISION_PHASE.START_FAILED,
          PUBLIC_OPERATION_REVISION_PHASE.STARTING,
          dispatch.operation_id,
          dispatch.operation_id,
          [],
        );
        events = await executeRevisionRetry({
          home: this.options.home,
          operation,
          plan,
          events,
          actionOperationId: dispatch.operation_id,
          now: this.options.home.now,
          retry: this.options.retry,
          publishAccepted: ({ operation: retryOperation, plan: retryPlan }) =>
            this.options.home.revisionLanes.finalize(
              retryOperation,
              retryPlan,
              "completed",
              this.options.artifactStore,
            ) === PUBLIC_OPERATION_REVISION_PHASE.STARTED,
        });
      }
      const terminal = this.terminalEvent(events, dispatch.operation_id);
      if (!terminal) throw new Error("revision control terminal event is absent");
      this.mirrorTerminal(proposalId, dispatch.operation_id, terminal);
    } finally {
      this.options.wake(operation.root_session_id);
    }
  }

  private appendTransition(
    operation: RevisionOperationV1,
    events: RevisionOperationEventV1[],
    from: RevisionOperationStateV1,
    to: RevisionOperationStateV1,
    authorizer: string,
    effect: string,
    terminals: RevisionActionTerminalBindingV1[],
    reason = terminals.find((row) => row.outcome === ACTION_OPERATION_STATE.FAILED)?.reason_code ??
      null,
  ): RevisionOperationEventV1[] {
    const event = materializeRevisionEvent(
      operation,
      events,
      {
        kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION,
        from,
        to,
        authorized_by_action_operation_id: authorizer,
        effect_action_operation_id: effect,
        action_terminals: terminals.sort((left, right) =>
          Buffer.compare(
            Buffer.from(left.action_operation_id),
            Buffer.from(right.action_operation_id),
          ),
        ),
        reason_code: reason,
      },
      later(this.options.home.now(), events.at(-1)?.recorded_at ?? operation.created_at),
    );
    this.options.home.revisions.appendEvent(operation, event);
    return [...events, event];
  }

  private mirrorTerminal(
    proposalId: string,
    operationId: string,
    event: RevisionOperationEventV1,
  ): void {
    if (!("action_terminals" in event.payload))
      throw new Error("revision control terminal is invalid");
    const snapshots = this.options.home.actions.authority.list();
    for (const terminal of event.payload.action_terminals) {
      const targetProposalId =
        terminal.action_operation_id === operationId
          ? proposalId
          : snapshots.find(({ operation_id }) => operation_id === terminal.action_operation_id)
              ?.proposal.proposal_id;
      if (!targetProposalId) throw new Error("revision control terminal proposal is absent");
      this.options.home.actions.terminal(targetProposalId, terminal.action_operation_id, {
        outcome: terminal.outcome,
        digest: event.event_digest,
        recorded_at: event.recorded_at,
      });
    }
  }
}
