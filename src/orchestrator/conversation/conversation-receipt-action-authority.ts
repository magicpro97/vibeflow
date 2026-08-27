import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  type ActionProposalRequestV1,
  type ActionRequestAuthorityV1,
  type BrowserHostActionRequestV1,
  type HostActionKind,
  type JsonValue,
  deriveOperationId,
} from "../../actions/index.js";
import {
  ACTION_OPERATION_STATE,
  type ActionOperationDomainTerminalState,
} from "../../actions/protocol-contract.js";
import type { TraceStore } from "../trace/store.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import { conversationLockDigest } from "./catalog-lock.js";
import {
  type ConversationReceiptActionKindV1,
  type ConversationReceiptNativePlanV1,
  materializeConversationActionBinding,
  materializeConversationActionReceipt,
} from "./conversation-action-receipt-store.js";
import { ConversationCompactionAuthority } from "./conversation-compaction-authority.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { ConversationLiteralActionAuthority } from "./conversation-literal-action-authority.js";
import {
  type OrdinaryConversationOperationAuthorityV1,
  foldOrdinaryConversationOperation,
} from "./conversation-operation-fold.js";
import { expectedReceiptAuthorityFacts } from "./conversation-receipt-authority-facts.js";
import {
  ConversationReceiptEffectExecutor,
  type ConversationReceiptEffectResultV1,
} from "./conversation-receipt-effect-executor.js";
import { ConversationReceiptCandidateUnavailableError } from "./conversation-receipt-errors.js";
import {
  assertReceiptSource,
  materializeAssociationPlan,
  materializeControlPlan,
  materializeSelectionPlan,
} from "./conversation-receipt-native-plans.js";
import { materializeConversationReceiptProposal } from "./conversation-receipt-planner.js";
import { ConversationRevisionControlAuthority } from "./conversation-revision-control-authority.js";
import type { ConversationLineageService } from "./lineage-service.js";
import type { ConversationOrchestrator } from "./service.js";

type SameUnion<Left, Right> = Exclude<Left, Right> extends never
  ? Exclude<Right, Left> extends never
    ? true
    : false
  : false;

export const CONVERSATION_RECEIPT_ACTION_KINDS = Object.freeze([
  HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD,
  HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES,
  HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL,
  HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION,
  HOST_ACTION_KIND.CONTEXT_COMPACT,
] as const satisfies readonly ConversationReceiptActionKindV1[]);

const _receiptActionKindParity = true satisfies SameUnion<
  (typeof CONVERSATION_RECEIPT_ACTION_KINDS)[number],
  ConversationReceiptActionKindV1
>;
void _receiptActionKindParity;

type ReceiptCandidate = Extract<
  BrowserHostActionRequestV1,
  { type: ConversationReceiptActionKindV1 }
>;

function isReceiptCandidate(candidate: BrowserHostActionRequestV1): candidate is ReceiptCandidate {
  return isReceiptActionType(candidate.type);
}

function isReceiptActionType(value: string): value is ConversationReceiptActionKindV1 {
  return CONVERSATION_RECEIPT_ACTION_KINDS.some((candidate) => candidate === value);
}

export { ConversationReceiptCandidateUnavailableError } from "./conversation-receipt-errors.js";

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export class ConversationReceiptActionAuthority {
  private readonly controls: ConversationRevisionControlAuthority;
  private readonly literals: ConversationLiteralActionAuthority;
  private readonly compactions: ConversationCompactionAuthority;
  private readonly effects: ConversationReceiptEffectExecutor;

  constructor(
    private readonly options: {
      lineages: ConversationLineageService;
      home: ConversationHomeAuthorities;
      service: Pick<ConversationOrchestrator, "cancelOperation" | "events"> & {
        revisionOperationQuiescent(conversationId: string, operationId: string): boolean;
        retryRevisionLanes: ConversationOrchestrator["retryRevisionLanes"];
        wakeMessageQueue: ConversationOrchestrator["wakeMessageQueue"];
      };
      traceStore: TraceStore;
      artifactStore: ConversationArtifactStore;
      compactionFault?(point: "after-artifacts-durable" | "after-trace-append"): void;
      receiptEffectFault?(point: "after-effect-publish"): void;
    },
  ) {
    this.controls = new ConversationRevisionControlAuthority({
      lineages: options.lineages,
      home: options.home,
      artifactStore: options.artifactStore,
      quiescent: (conversationId, operationId) =>
        options.service.revisionOperationQuiescent(conversationId, operationId),
      retry: (input) => options.service.retryRevisionLanes(input),
      wake: (conversationId) => options.service.wakeMessageQueue(conversationId),
    });
    this.literals = new ConversationLiteralActionAuthority({
      lineages: options.lineages,
      home: options.home,
      traceStore: options.traceStore,
    });
    this.compactions = new ConversationCompactionAuthority({
      lineages: options.lineages,
      home: options.home,
      traceStore: options.traceStore,
      artifactStore: options.artifactStore,
      ...(options.compactionFault ? { fault: options.compactionFault } : {}),
    });
    this.effects = new ConversationReceiptEffectExecutor({
      lineages: options.lineages,
      home: options.home,
      service: options.service,
      ...(options.receiptEffectFault ? { fault: options.receiptEffectFault } : {}),
    });
  }

  supports(candidate: { type: HostActionKind }): boolean {
    return isReceiptActionType(candidate.type) || this.controls.supports(candidate);
  }

  recoverCanceledLineageMutations(): void {
    for (const reservation of this.options.home.lineageMutations.active()) {
      const snapshot = this.options.home.actions.get(reservation.proposal_id);
      const kind =
        snapshot?.proposal.action.type === HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL
          ? "public-literal"
          : snapshot?.proposal.action.type === HOST_ACTION_KIND.CONTEXT_COMPACT
            ? "context-compaction"
            : null;
      if (
        !snapshot?.approval ||
        kind !== reservation.mutation_kind ||
        snapshot.proposal.proposal_digest !== reservation.proposal_digest ||
        snapshot.approval.approval_id !== reservation.approval_id ||
        snapshot.approval.approval_digest !== reservation.approval_digest ||
        deriveOperationId(snapshot.proposal, snapshot.approval.approval_id) !==
          reservation.operation_id
      )
        throw new Error("active lineage mutation Action authority changed");
      this.options.home.lineageMutations.releaseCanceled(snapshot);
    }
  }

  releaseCanceledLineageMutation(proposalId: string): void {
    const snapshot = this.options.home.actions.get(proposalId);
    if (!snapshot) throw new Error("canceled conversation action authority is absent");
    this.options.home.lineageMutations.releaseCanceled(snapshot);
  }

  async propose(input: {
    conversation_id: string;
    request: ActionProposalRequestV1;
    authority: ActionRequestAuthorityV1;
  }) {
    const candidate = input.request.candidate;
    if (this.controls.supports(candidate)) return this.controls.propose(input);
    if (candidate.type === HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL)
      return this.literals.propose(input);
    if (candidate.type === HOST_ACTION_KIND.CONTEXT_COMPACT) return this.compactions.propose(input);
    if (!isReceiptCandidate(candidate)) throw new Error("unsupported conversation receipt action");
    const resolved = this.options.lineages.resolve(input.conversation_id);
    assertReceiptSource(resolved, input.request);
    const createdAt = this.options.home.now();
    const lock = conversationLockDigest(
      resolved.lineage.root_session_id,
      resolved.requested.source,
      resolved.revision_claim_epoch,
    );
    let native: { plan_digest: string };
    let kind: "lineage-head" | "lineage-association" | "conversation-control";
    if (candidate.type === HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD) {
      native = materializeSelectionPlan(resolved, candidate, createdAt);
      kind = "lineage-head";
    } else if (candidate.type === HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES) {
      native = materializeAssociationPlan(this.options.lineages, candidate, createdAt);
      kind = "lineage-association";
    } else if (candidate.type === HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION) {
      const operationAuthority = await this.ordinaryOperationAuthority({
        root_session_id: resolved.lineage.root_session_id,
        conversation_id: resolved.requested.node.conversation_id,
        operation_id: candidate.operation_id,
        conversation_lock_digest: lock,
      });
      native = materializeControlPlan(
        resolved,
        candidate,
        createdAt,
        this.options.home.controlEffects,
        operationAuthority,
      );
      kind = "conversation-control";
    } else {
      throw new Error("unsupported conversation receipt action");
    }
    const planned = materializeConversationReceiptProposal({
      source: {
        root_session_id: resolved.lineage.root_session_id,
        conversation_id: resolved.requested.node.conversation_id,
        revision_id: resolved.requested.node.revision_id,
        last_seq: resolved.requested.source.journal_head.last_seq,
        conversation_lock_digest: lock,
        head: resolved.head,
      },
      request: input.request,
      action: structuredClone(candidate),
      authority: input.authority,
      effect_binding: structuredClone(native) as unknown as JsonValue,
      native_step: { kind, digest: native.plan_digest },
      created_at: createdAt,
    });
    this.options.home.actionReceipts.writePlan(planned.proposal_plan);
    const created = this.options.home.actions.create(planned.proposal_plan, input.authority);
    return { created: created.created, proposal_id: created.proposal.proposal_id };
  }

  async commit(input: { proposal_id: string }): Promise<void> {
    const snapshot = this.options.home.actions.get(input.proposal_id);
    if (snapshot && this.controls.supports(snapshot.proposal.action))
      return this.controls.commit(input.proposal_id);
    if (snapshot?.proposal.action.type === HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL)
      return this.literals.commit(input.proposal_id);
    if (snapshot?.proposal.action.type === HOST_ACTION_KIND.CONTEXT_COMPACT)
      return this.compactions.commit(input.proposal_id);
    const stored = this.options.home.actionReceipts.readPlan(input.proposal_id);
    if (!snapshot?.approval || !stored) throw new Error("conversation receipt approval is absent");
    const actionType = stored.native_plan.action_type;
    if (!isReceiptActionType(actionType))
      throw new Error("conversation receipt plan has the wrong action owner");
    const operationId =
      snapshot.operation_id ?? deriveOperationId(snapshot.proposal, snapshot.approval.approval_id);
    const existing = this.options.home.actionReceipts.read(input.proposal_id);
    if (existing) {
      this.options.home.actions.terminal(input.proposal_id, operationId, {
        outcome: existing.outcome,
        digest: existing.receipt_digest,
        recorded_at: existing.recorded_at,
      });
      return;
    }
    if (actionType === HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION) {
      const native = stored.native_plan.effect_binding as {
        target_operation_id?: unknown;
        expected_operation_header_digest?: unknown;
        expected_operation_state_digest?: unknown;
        control_effect_plan_digest?: unknown;
      };
      if (
        typeof native.target_operation_id !== "string" ||
        typeof native.expected_operation_header_digest !== "string" ||
        typeof native.expected_operation_state_digest !== "string" ||
        typeof native.control_effect_plan_digest !== "string"
      )
        throw new Error("conversation stop control plan is invalid");
      const liveAuthority = await this.ordinaryOperationAuthority({
        root_session_id: stored.native_plan.root_session_id,
        conversation_id: stored.native_plan.expected.conversation_id,
        operation_id: native.target_operation_id,
        conversation_lock_digest: stored.native_plan.expected.conversation_lock_digest,
      });
      if (
        liveAuthority.operation_header_digest !== native.expected_operation_header_digest ||
        liveAuthority.operation_state_digest !== native.expected_operation_state_digest
      )
        throw new Error("conversation stop operation authority changed before dispatch");
      this.options.home.controlEffects.assertForAction({
        plan_digest: native.control_effect_plan_digest,
        action_type: actionType,
        target_operation_id: native.target_operation_id,
        expected_pre_effect_fold_digest: native.expected_operation_state_digest,
        expected_operation_header_digest: native.expected_operation_header_digest,
      });
    }
    const dispatch = this.options.home.actions.dispatch(
      input.proposal_id,
      snapshot.approval.approval_id,
      { digest: stored.record_digest, recorded_at: snapshot.approval.decided_at },
    );
    const expectedFacts = expectedReceiptAuthorityFacts(
      stored.native_plan,
      snapshot.proposal,
      snapshot.approval,
      dispatch,
    );
    const expected = materializeConversationActionBinding({
      action_type: actionType,
      plan_digest: snapshot.proposal.plan_digest,
      phase: "expected",
      facts: expectedFacts.sort((left, right) =>
        bytewise(`${left.kind}\0${left.identity}`, `${right.kind}\0${right.identity}`),
      ),
    });
    let outcome: ActionOperationDomainTerminalState = ACTION_OPERATION_STATE.SUCCEEDED;
    let reason: string | null = null;
    let observed: ConversationReceiptEffectResultV1 = { facts: expected.facts };
    try {
      observed = await this.effects.execute({
        plan: stored.native_plan,
        proposal: snapshot.proposal,
        approval: snapshot.approval,
        dispatch,
      });
    } catch {
      const inspection = await this.effects.observe({
        plan: stored.native_plan,
        proposal: snapshot.proposal,
        approval: snapshot.approval,
        dispatch,
        expectedFacts: expected.facts,
      });
      outcome = inspection.outcome;
      reason = inspection.reason_code;
      observed = inspection;
    }
    const observedBinding = materializeConversationActionBinding({
      action_type: actionType,
      plan_digest: snapshot.proposal.plan_digest,
      phase: "observed",
      facts: observed.facts.sort((left, right) =>
        bytewise(`${left.kind}\0${left.identity}`, `${right.kind}\0${right.identity}`),
      ),
    });
    const receipt = materializeConversationActionReceipt({
      operation_id: dispatch.operation_id,
      proposal_id: snapshot.proposal.proposal_id,
      approval_id: snapshot.approval.approval_id,
      action_type: actionType,
      plan_digest: snapshot.proposal.plan_digest,
      expected_authority_binding_digest: expected.binding_digest,
      observed_authority_binding_digest: observedBinding.binding_digest,
      outcome,
      reason_code: reason,
      recorded_at: this.options.home.now(),
    });
    this.options.home.actionReceipts.writeBinding(expected);
    this.options.home.actionReceipts.writeBinding(observedBinding);
    this.options.home.actionReceipts.append(receipt);
    this.options.home.actions.terminal(input.proposal_id, dispatch.operation_id, {
      outcome,
      digest: receipt.receipt_digest,
      recorded_at: receipt.recorded_at,
    });
  }

  private async ordinaryOperationAuthority(input: {
    root_session_id: string;
    conversation_id: string;
    operation_id: string;
    conversation_lock_digest: string;
  }): Promise<OrdinaryConversationOperationAuthorityV1> {
    if (this.options.artifactStore.operationOwner(input.operation_id) !== input.conversation_id)
      throw new ConversationReceiptCandidateUnavailableError(
        HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION,
      );
    const events = await this.options.service.events(input.conversation_id, 0);
    if (!events) throw new Error("ordinary operation trace authority is absent");
    return foldOrdinaryConversationOperation({
      ...input,
      events,
      cancellation_claimed: this.options.artifactStore
        .operationAuthority()
        .isCancellationClaimed(input.conversation_id, input.operation_id),
    });
  }
}
