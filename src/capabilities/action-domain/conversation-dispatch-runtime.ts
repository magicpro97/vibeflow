import {
  ACTION_OPERATION_STATE,
  ACTION_ROOT_LOCATOR_KIND,
  type ActionAuthoritySnapshotV1,
  ActionConflictError,
  type ActionDispatchRecordV1,
  type ActionOperationState,
  deriveOperationId,
  isActionOperationDispatchBeginState,
  isActionOperationDomainTerminalState,
  isActionOperationResolvedDomainState,
  isActionOperationTerminalState,
} from "../../actions/index.js";
import type { ConversationActionService } from "../../orchestrator/conversation/conversation-action-service.js";
import { ConversationCapabilityDispatchCorruptError } from "../../orchestrator/conversation/conversation-capability-dispatch-block.js";
import type { CapabilityRuntimeFactoryV1 } from "../runtime-factory.js";

export interface CapabilityConversationActionDomainOptionsV1 {
  barrier?(input: {
    point:
      | "after-dispatch-prepared"
      | "after-dispatch-reserved"
      | "after-domain-terminal"
      | "after-action-terminal";
    proposal_id: string;
  }): Promise<void>;
  recover_on_bootstrap?: boolean;
}

const isAbortedActionOperationState = (state: ActionOperationState): boolean =>
  isActionOperationTerminalState(state) && !isActionOperationDomainTerminalState(state);

/** Owns the durable header -> Action dispatch -> lineage claim -> effect frontier. */
export class CapabilityConversationDispatchRuntimeV1 {
  constructor(
    private readonly runtime: CapabilityRuntimeFactoryV1,
    private readonly actions: ConversationActionService,
    private readonly options: CapabilityConversationActionDomainOptionsV1,
  ) {}

  async execute(
    snapshot: ActionAuthoritySnapshotV1,
    approvalId: string,
    useBarrier = true,
  ): Promise<ActionAuthoritySnapshotV1> {
    if (!snapshot.approval || snapshot.approval.approval_id !== approvalId)
      throw new Error("capability proposal approval is absent");
    if (!isActionOperationDispatchBeginState(snapshot.state))
      throw new ActionConflictError(
        "stale_proposal",
        "Capability proposal can no longer enter committing.",
        snapshot.proposal.proposal_id,
      );
    if (snapshot.state === ACTION_OPERATION_STATE.APPROVED)
      this.actions.authority.prevalidateDispatch(snapshot.proposal.proposal_id, approvalId);
    const graph = this.runtime.actionObjects.readGraph(snapshot.proposal);
    const service = this.runtime.service(graph.plan.scope);
    const prepared = service.prepareApproved({
      schema_version: "1.0",
      graph,
      proposal: snapshot.proposal,
      approval: snapshot.approval,
    });
    const preparedAt = "result" in prepared ? snapshot.approval.decided_at : prepared.prepared_at;
    const dispatch = this.actions.authority.prepareDomainDispatch(
      snapshot.proposal.proposal_id,
      approvalId,
      preparedAt,
    );
    if (snapshot.state === ACTION_OPERATION_STATE.APPROVED) {
      const terminal = await this.reserveAndBegin(snapshot, dispatch, useBarrier);
      if (terminal) return terminal;
    } else {
      const terminal = this.assertActiveOrTerminal(snapshot, dispatch);
      if (terminal) return terminal;
    }
    const priorTerminal = this.assertActiveOrTerminal(snapshot, dispatch);
    if (priorTerminal) return priorTerminal;
    if (!("result" in prepared)) service.executePrepared(prepared.operation_id);
    const racedTerminal = this.assertActiveOrTerminal(snapshot, dispatch);
    if (racedTerminal) return racedTerminal;
    if (useBarrier)
      await this.options.barrier?.({
        point: "after-domain-terminal",
        proposal_id: snapshot.proposal.proposal_id,
      });
    const terminal = this.actions.authority.recordTerminal(snapshot.proposal.proposal_id);
    if (useBarrier)
      await this.options.barrier?.({
        point: "after-action-terminal",
        proposal_id: snapshot.proposal.proposal_id,
      });
    this.releaseTerminal(terminal);
    return terminal;
  }

  async recover(): Promise<void> {
    if (this.options.recover_on_bootstrap === false) return;
    for (const snapshot of this.actions.authority.listRecorded()) {
      if (snapshot.proposal.domain !== "capability") continue;
      const locator = snapshot.proposal.action_root_locator;
      if (
        locator.kind !== ACTION_ROOT_LOCATOR_KIND.CONVERSATION ||
        locator.root_session_id !== snapshot.proposal.base.root_session_id
      )
        throw new Error("recorded conversation capability action root is invalid");
      this.runtime.bindActionAuthority(locator, this.actions.authority.reader);
    }
    for (const snapshot of this.actions.authority.list()) {
      if (
        snapshot.proposal.domain !== "capability" ||
        snapshot.proposal.action_root_locator.kind !== ACTION_ROOT_LOCATOR_KIND.CONVERSATION ||
        !snapshot.proposal.base.root_session_id ||
        !snapshot.approval
      )
        continue;
      const current = this.actions.capabilityDispatches.current(
        snapshot.proposal.base.root_session_id,
      );
      if (
        snapshot.state === ACTION_OPERATION_STATE.COMMITTING &&
        !(current?.status === "active" && current.proposal_id === snapshot.proposal.proposal_id)
      ) {
        const dispatch = snapshot.operation_id
          ? this.actions.authority.getDispatch(snapshot.operation_id)
          : null;
        if (!dispatch)
          throw new ConversationCapabilityDispatchCorruptError(
            "committing capability action has no durable dispatch",
          );
        const reason =
          current === null
            ? "claim-missing"
            : current.status === "released" && current.proposal_id === snapshot.proposal.proposal_id
              ? "claim-released"
              : "claim-mismatch";
        this.actions.capabilityDispatches.block({
          proposal: snapshot.proposal,
          approval: snapshot.approval,
          dispatch,
          reason,
          now: snapshot.events.at(-1)?.recorded_at ?? dispatch.created_at,
        });
        throw new ConversationCapabilityDispatchCorruptError(
          `committing capability action has ${reason.replace("claim-", "")} claim authority`,
        );
      }
      if (current?.status === "active" && current.proposal_id === snapshot.proposal.proposal_id) {
        if (isActionOperationDomainTerminalState(snapshot.state)) {
          this.releaseTerminal(snapshot);
          continue;
        }
        if (isAbortedActionOperationState(snapshot.state)) {
          this.releaseAborted(snapshot);
          continue;
        }
        await this.recoverExecute(snapshot);
        continue;
      }
      if (current?.status === "active") continue;
      if (snapshot.state !== ACTION_OPERATION_STATE.APPROVED) continue;
      const operationId = deriveOperationId(snapshot.proposal, snapshot.approval.approval_id);
      if (!this.actions.authority.getDispatch(operationId)) continue;
      await this.recoverExecute(snapshot);
    }
  }

  releaseTerminal(snapshot: ActionAuthoritySnapshotV1): void {
    if (
      !snapshot.approval ||
      !snapshot.operation_id ||
      snapshot.state === ACTION_OPERATION_STATE.NEEDS_RECOVERY
    )
      return;
    if (!snapshot.domain_terminal_digest || !isActionOperationResolvedDomainState(snapshot.state))
      return;
    const dispatch = this.actions.authority.getDispatch(snapshot.operation_id);
    if (!dispatch) throw new Error("terminal capability dispatch closure is absent");
    const active = this.currentFor(snapshot);
    if (!active || active.proposal_id !== snapshot.proposal.proposal_id) return;
    if (
      active.proposal_digest !== snapshot.proposal.proposal_digest ||
      active.approval_id !== snapshot.approval.approval_id ||
      active.approval_digest !== snapshot.approval.approval_digest ||
      active.operation_id !== dispatch.operation_id ||
      active.dispatch_record_digest !== dispatch.dispatch_record_digest ||
      active.domain_header_digest !== dispatch.domain_header_digest
    )
      throw new Error("terminal capability dispatch reservation authority changed");
    if (active.status === "released") {
      if (
        active.release_outcome !== snapshot.state ||
        active.domain_terminal_digest !== snapshot.domain_terminal_digest
      )
        throw new Error("terminal capability dispatch release changed");
      return;
    }
    this.actions.capabilityDispatches.release({
      proposal: snapshot.proposal,
      approval: snapshot.approval,
      dispatch,
      release_outcome: snapshot.state,
      domain_terminal_digest: snapshot.domain_terminal_digest,
      now: snapshot.events.at(-1)?.recorded_at ?? dispatch.created_at,
    });
  }

  releaseAborted(snapshot: ActionAuthoritySnapshotV1): void {
    if (!snapshot.approval || !snapshot.proposal.base.root_session_id) return;
    if (!isAbortedActionOperationState(snapshot.state)) return;
    const dispatch = this.actions.authority.getDispatch(
      snapshot.operation_id ?? deriveOperationId(snapshot.proposal, snapshot.approval.approval_id),
    );
    if (!dispatch) return;
    const active = this.currentFor(snapshot);
    if (
      !active ||
      active.status === "released" ||
      active.proposal_id !== snapshot.proposal.proposal_id
    )
      return;
    this.actions.capabilityDispatches.release({
      proposal: snapshot.proposal,
      approval: snapshot.approval,
      dispatch,
      release_outcome: "aborted",
      domain_terminal_digest:
        snapshot.events.at(-1)?.event_digest ?? snapshot.proposal.proposal_digest,
      now: snapshot.events.at(-1)?.recorded_at ?? dispatch.created_at,
    });
  }

  private async reserveAndBegin(
    snapshot: ActionAuthoritySnapshotV1,
    dispatch: ActionDispatchRecordV1,
    useBarrier: boolean,
  ): Promise<ActionAuthoritySnapshotV1 | null> {
    const approval = snapshot.approval;
    if (!approval) throw new Error("capability dispatch approval is absent");
    if (useBarrier)
      await this.options.barrier?.({
        point: "after-dispatch-prepared",
        proposal_id: snapshot.proposal.proposal_id,
      });
    try {
      this.actions.authority.reserveDispatch(snapshot.proposal.proposal_id, approval.approval_id);
      if (useBarrier)
        await this.options.barrier?.({
          point: "after-dispatch-reserved",
          proposal_id: snapshot.proposal.proposal_id,
        });
      const begun = this.actions.authority.beginDispatch(
        snapshot.proposal.proposal_id,
        approval.approval_id,
      );
      if (isActionOperationDomainTerminalState(begun.state)) {
        this.releaseTerminal(begun);
        return begun;
      }
    } catch (error) {
      const current = this.actions.authority.get(snapshot.proposal.proposal_id);
      if (current) this.releaseAborted(current);
      throw error;
    }
    this.actions.capabilityDispatches.assertActive(snapshot.proposal, approval, dispatch);
    return null;
  }

  private async recoverExecute(snapshot: ActionAuthoritySnapshotV1): Promise<void> {
    const approval = snapshot.approval;
    if (!approval) throw new Error("capability recovery approval is absent");
    try {
      await this.execute(snapshot, approval.approval_id, false);
    } catch (error) {
      const current = this.actions.authority.get(snapshot.proposal.proposal_id);
      if (current && isAbortedActionOperationState(current.state)) {
        this.releaseAborted(current);
        return;
      }
      throw error;
    }
  }

  private currentFor(snapshot: ActionAuthoritySnapshotV1) {
    const root = snapshot.proposal.base.root_session_id;
    return root ? this.actions.capabilityDispatches.current(root) : null;
  }

  private assertActiveOrTerminal(
    snapshot: ActionAuthoritySnapshotV1,
    dispatch: ActionDispatchRecordV1,
  ): ActionAuthoritySnapshotV1 | null {
    try {
      this.actions.capabilityDispatches.assertActive(
        snapshot.proposal,
        snapshot.approval as NonNullable<typeof snapshot.approval>,
        dispatch,
      );
      return null;
    } catch (error) {
      const terminal = this.actions.authority.get(snapshot.proposal.proposal_id);
      const reservation = this.currentFor(snapshot);
      if (
        !terminal ||
        !terminal.approval ||
        !isActionOperationDomainTerminalState(terminal.state) ||
        terminal.proposal.proposal_digest !== snapshot.proposal.proposal_digest ||
        terminal.approval.approval_id !== dispatch.approval_id ||
        terminal.operation_id !== dispatch.operation_id ||
        terminal.dispatch_record_digest !== dispatch.dispatch_record_digest ||
        !reservation ||
        reservation.proposal_id !== terminal.proposal.proposal_id ||
        reservation.proposal_digest !== terminal.proposal.proposal_digest ||
        reservation.approval_id !== terminal.approval.approval_id ||
        reservation.approval_digest !== terminal.approval.approval_digest ||
        reservation.operation_id !== dispatch.operation_id ||
        reservation.dispatch_record_digest !== dispatch.dispatch_record_digest ||
        reservation.domain_header_digest !== dispatch.domain_header_digest ||
        (reservation.status === "released" &&
          reservation.domain_terminal_digest !== terminal.domain_terminal_digest)
      )
        throw error;
      this.releaseTerminal(terminal);
      return terminal;
    }
  }
}
