import type {
  ActionApprovalV1,
  ActionDispatchRecordV1,
  ActionProposalV1,
} from "../../actions/index.js";
import { digestV1 } from "../../durability/index.js";
import type { ConversationReceiptNativePlanV1 } from "./conversation-action-receipt-store.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type { ConversationAuthorityFactV1 } from "./conversation-receipt-authority-facts.js";
import {
  materializeReceiptAssociationRecord,
  receiptAssociationPlan,
} from "./conversation-receipt-authority-facts.js";
import { assertLineageHeadSelectionPlanV1 } from "./lineage-head-authority.js";
import { publishedRevisionAuthorityMap } from "./lineage-published-transition.js";
import type { ConversationLineageService } from "./lineage-service.js";
import { type LineageHeadRecordV1, lineageHeadDigest } from "./lineage-types.js";
import type { ConversationOrchestrator } from "./service.js";

export interface ConversationReceiptEffectResultV1 {
  facts: ConversationAuthorityFactV1[];
}

export interface ConversationReceiptEffectObservationV1 extends ConversationReceiptEffectResultV1 {
  outcome: "succeeded" | "failed" | "needs_recovery";
  reason_code: string | null;
}

function absentAssociationDigest(identity: string): string {
  return digestV1("VF-CONVERSATION-AUTHORITY-ABSENT\0v1\0", {
    kind: "lineage-association",
    identity,
  });
}

export class ConversationReceiptEffectExecutor {
  constructor(
    private readonly options: {
      lineages: ConversationLineageService;
      home: ConversationHomeAuthorities;
      service: Pick<ConversationOrchestrator, "cancelOperation" | "events">;
      fault?(point: "after-effect-publish"): void;
    },
  ) {}

  async execute(input: {
    plan: ConversationReceiptNativePlanV1;
    proposal: ActionProposalV1;
    approval: ActionApprovalV1;
    dispatch: ActionDispatchRecordV1;
  }): Promise<ConversationReceiptEffectResultV1> {
    let result: ConversationReceiptEffectResultV1;
    if (input.plan.action_type === "conversation.select_lineage_head")
      result = this.select(input.plan, input.proposal, input.approval, input.dispatch);
    else if (input.plan.action_type === "conversation.associate_lineages")
      result = this.associate(input.plan, input.proposal, input.approval, input.dispatch);
    else if (input.plan.action_type === "conversation.stop_operation")
      result = await this.stop(input.plan, input.proposal);
    else throw new Error("unsupported conversation receipt effect");
    this.options.fault?.("after-effect-publish");
    return result;
  }

  async observe(input: {
    plan: ConversationReceiptNativePlanV1;
    proposal: ActionProposalV1;
    approval: ActionApprovalV1;
    dispatch: ActionDispatchRecordV1;
    expectedFacts: readonly ConversationAuthorityFactV1[];
  }): Promise<ConversationReceiptEffectObservationV1> {
    if (input.plan.action_type === "conversation.select_lineage_head")
      return this.observeSelection(input);
    if (input.plan.action_type === "conversation.associate_lineages")
      return this.observeAssociation(input);
    if (input.plan.action_type === "conversation.stop_operation") return this.observeStop(input);
    throw new Error("unsupported conversation receipt observation");
  }

  private transitionMap() {
    return new Map<string, unknown>([
      ...publishedRevisionAuthorityMap(this.options.home.publishedRevisionTransitions()),
      ...this.options.home.headTransitions.readAll(),
    ]);
  }

  private select(
    plan: ConversationReceiptNativePlanV1,
    proposal: ActionProposalV1,
    approval: ActionApprovalV1,
    dispatch: ActionDispatchRecordV1,
  ): ConversationReceiptEffectResultV1 {
    assertLineageHeadSelectionPlanV1(plan.effect_binding);
    const native = plan.effect_binding;
    const resolved = this.options.lineages.resolve(plan.expected.conversation_id);
    const current = resolved.head;
    if (current.updated_by_operation_id === dispatch.operation_id)
      return { facts: [this.headFact(current)] };
    if (current.content_digest !== native.expected_head_digest)
      throw new Error("lineage head selection CAS changed");
    const withoutDigest: Omit<LineageHeadRecordV1, "content_digest"> = {
      schema_version: "1.0",
      root_session_id: current.root_session_id,
      head_status: "committed",
      active: structuredClone(native.candidate),
      candidate_heads: [],
      head_epoch: current.head_epoch + 1,
      previous_head_digest: current.content_digest,
      updated_by_operation_id: dispatch.operation_id,
      updated_at: dispatch.created_at,
    };
    const replacement = { ...withoutDigest, content_digest: lineageHeadDigest(withoutDigest) };
    const actionPlan = this.options.home.actionReceipts.readPlan(proposal.proposal_id)?.action_plan;
    if (!actionPlan) throw new Error("lineage head action plan is absent");
    const authority = {
      kind: "selection",
      prior_head: current,
      plan: native,
      action_plan: actionPlan,
      proposal,
      approval,
      dispatch,
    };
    const transitions = this.transitionMap();
    transitions.set(replacement.content_digest, authority);
    this.options.home.headTransitions.write(replacement.content_digest, authority);
    this.options.home.lineage.commitHead(resolved.lineage, current, replacement, transitions);
    return { facts: [this.headFact(replacement)] };
  }

  private associate(
    plan: ConversationReceiptNativePlanV1,
    proposal: ActionProposalV1,
    approval: ActionApprovalV1,
    dispatch: ActionDispatchRecordV1,
  ): ConversationReceiptEffectResultV1 {
    const native = receiptAssociationPlan(plan.effect_binding);
    const heads = new Map(
      native.root_bindings.map((binding) => [
        binding.root_session_id,
        this.options.lineages.resolve(binding.root_session_id).head,
      ]),
    );
    const record = materializeReceiptAssociationRecord(native, proposal, approval, dispatch);
    const actionPlan = this.options.home.actionReceipts.readPlan(proposal.proposal_id)?.action_plan;
    if (!actionPlan) throw new Error("lineage association action plan is absent");
    this.options.home.lineage.commitAssociation(
      { plan: native, action_plan: actionPlan, proposal, approval, dispatch, record },
      heads,
    );
    return { facts: this.associationFacts(native, record.content_digest, record.association_id) };
  }

  private async stop(
    plan: ConversationReceiptNativePlanV1,
    proposal: ActionProposalV1,
  ): Promise<ConversationReceiptEffectResultV1> {
    const action = plan.action;
    if (action.type !== "conversation.stop_operation") throw new Error("stop plan action mismatch");
    const actor = proposal.requested_by.public_actor_id;
    const reason = `action:${proposal.proposal_id}`;
    const result = await this.options.service.cancelOperation({
      conversation_id: plan.expected.conversation_id,
      operation_id: action.operation_id,
      actor,
      reason,
    });
    const fact = await this.stopFact(plan, proposal);
    if (result.status !== 202 && !fact)
      throw new Error(`operation stop refused: ${result.body.code}`);
    if (!fact) throw new Error("operation stop postcondition is not durable");
    return { facts: [this.lockFact(plan), fact] };
  }

  private observeSelection(
    input: Parameters<ConversationReceiptEffectExecutor["observe"]>[0],
  ): ConversationReceiptEffectObservationV1 {
    assertLineageHeadSelectionPlanV1(input.plan.effect_binding);
    const native = input.plan.effect_binding;
    const current = this.options.lineages.resolve(input.plan.expected.conversation_id).head;
    if (
      current.updated_by_operation_id === input.dispatch.operation_id &&
      current.previous_head_digest === native.expected_head_digest &&
      JSON.stringify(current.active) === JSON.stringify(native.candidate)
    )
      return { outcome: "succeeded", reason_code: null, facts: [this.headFact(current)] };
    if (current.content_digest === native.expected_head_digest)
      return { outcome: "failed", reason_code: "effect-refused", facts: [...input.expectedFacts] };
    return {
      outcome: "needs_recovery",
      reason_code: "effect-state-unknown",
      facts: [this.headFact(current)],
    };
  }

  private observeAssociation(
    input: Parameters<ConversationReceiptEffectExecutor["observe"]>[0],
  ): ConversationReceiptEffectObservationV1 {
    const native = receiptAssociationPlan(input.plan.effect_binding);
    const record = materializeReceiptAssociationRecord(
      native,
      input.proposal,
      input.approval,
      input.dispatch,
    );
    const persisted = this.options.home.lineage
      .readAssociationRecords()
      .records.find(({ association_id }) => association_id === record.association_id);
    if (persisted) {
      if (JSON.stringify(persisted) !== JSON.stringify(record))
        throw new Error("lineage association durable record changed");
      return {
        outcome: "succeeded",
        reason_code: null,
        facts: this.associationFacts(native, record.content_digest, record.association_id),
      };
    }
    const heads = native.root_bindings.map(
      (binding) => this.options.lineages.resolve(binding.root_session_id).head,
    );
    if (
      heads.every(
        (head, index) => head.content_digest === native.root_bindings[index]?.expected_head_digest,
      )
    )
      return { outcome: "failed", reason_code: "effect-refused", facts: [...input.expectedFacts] };
    return {
      outcome: "needs_recovery",
      reason_code: "effect-state-unknown",
      facts: this.associationFacts(
        native,
        absentAssociationDigest(`association:${record.association_id}`),
        record.association_id,
        heads,
      ),
    };
  }

  private async observeStop(
    input: Parameters<ConversationReceiptEffectExecutor["observe"]>[0],
  ): Promise<ConversationReceiptEffectObservationV1> {
    const fact = await this.stopFact(input.plan, input.proposal);
    return fact
      ? { outcome: "succeeded", reason_code: null, facts: [this.lockFact(input.plan), fact] }
      : {
          outcome: "needs_recovery",
          reason_code: "effect-state-unknown",
          facts: [...input.expectedFacts],
        };
  }

  private async stopFact(
    plan: ConversationReceiptNativePlanV1,
    proposal: ActionProposalV1,
  ): Promise<ConversationAuthorityFactV1 | null> {
    const action = plan.action;
    if (action.type !== "conversation.stop_operation") throw new Error("stop plan action mismatch");
    const events = (await this.options.service.events(plan.expected.conversation_id, 0)) ?? [];
    const found = events.some(
      (event) =>
        event.event.type === "caller_cancelled" &&
        event.event.payload.operation_id === action.operation_id &&
        event.event.payload.actor === proposal.requested_by.public_actor_id &&
        event.event.payload.reason === `action:${proposal.proposal_id}`,
    );
    return found
      ? {
          kind: "conversation-operation",
          identity: `operation:${action.operation_id}`,
          content_digest: digestV1("VF-CONVERSATION-STOP-OBSERVATION\0v1\0", {
            schema_version: "1.0",
            operation_id: action.operation_id,
            canceled: true,
          }),
        }
      : null;
  }

  private lockFact(plan: ConversationReceiptNativePlanV1): ConversationAuthorityFactV1 {
    return {
      kind: "conversation-lock",
      identity: `conversation:${plan.expected.conversation_id}`,
      content_digest: plan.expected.conversation_lock_digest,
    };
  }

  private headFact(head: LineageHeadRecordV1): ConversationAuthorityFactV1 {
    return {
      kind: "lineage-head",
      identity: `lineage:${head.root_session_id}`,
      content_digest: head.content_digest,
    };
  }

  private associationFacts(
    native: ReturnType<typeof receiptAssociationPlan>,
    associationDigest: string,
    associationId: string,
    heads?: LineageHeadRecordV1[],
  ): ConversationAuthorityFactV1[] {
    return [
      ...native.root_bindings.map((binding, index) => ({
        kind: "lineage-head" as const,
        identity: `lineage:${binding.root_session_id}`,
        content_digest: heads?.[index]?.content_digest ?? binding.expected_head_digest,
      })),
      {
        kind: "lineage-association",
        identity: `association:${associationId}`,
        content_digest: associationDigest,
      },
    ];
  }
}
