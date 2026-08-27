import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type {
  ActionApprovalV1,
  ActionDispatchRecordV1,
  ActionProposalV1,
} from "../../actions/index.js";
import { digestV1 } from "../../durability/index.js";
import type {
  ConversationActionAuthorityBindingV1,
  ConversationReceiptNativePlanV1,
} from "./conversation-action-receipt-store.js";
import {
  type LineageAssociationPlanV1,
  type LineageAssociationRecordV1,
  assertLineageAssociationPlanV1,
} from "./lineage-association.js";
import { assertLineageHeadSelectionPlanV1 } from "./lineage-head-authority.js";

export type ConversationAuthorityFactV1 = ConversationActionAuthorityBindingV1["facts"][number];

export function receiptAssociationPlan(value: unknown): LineageAssociationPlanV1 {
  assertLineageAssociationPlanV1(value);
  return value;
}

export function materializeReceiptAssociationRecord(
  native: LineageAssociationPlanV1,
  proposal: ActionProposalV1,
  approval: ActionApprovalV1,
  dispatch: ActionDispatchRecordV1,
): LineageAssociationRecordV1 {
  const preimage = {
    schema_version: "1.0" as const,
    root_bindings: native.root_bindings.map(({ expected_head_epoch: _epoch, ...row }) => row),
    relation: native.relation,
    reason_digest: native.reason_digest,
    proposal_id: proposal.proposal_id,
    approval_id: approval.approval_id,
    operation_id: dispatch.operation_id,
    created_by: structuredClone(approval.decided_by),
    created_at: dispatch.created_at,
  };
  const digest = digestV1("VF-LINEAGE-ASSOCIATION\0v1\0", preimage);
  return {
    ...preimage,
    association_id: `vf-lineage-association-${digest.slice(7)}`,
    content_digest: digest,
  };
}

export function expectedReceiptAuthorityFacts(
  plan: ConversationReceiptNativePlanV1,
  proposal: ActionProposalV1,
  approval: ActionApprovalV1,
  dispatch: ActionDispatchRecordV1,
): ConversationAuthorityFactV1[] {
  if (plan.action_type === HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD) {
    const native = plan.effect_binding;
    assertLineageHeadSelectionPlanV1(native);
    return [
      {
        kind: "lineage-head",
        identity: `lineage:${native.root_session_id}`,
        content_digest: native.expected_head_digest,
      },
    ];
  }
  if (plan.action_type === HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES) {
    const native = receiptAssociationPlan(plan.effect_binding);
    const association = materializeReceiptAssociationRecord(native, proposal, approval, dispatch);
    return [
      ...native.root_bindings.map((binding) => ({
        kind: "lineage-head" as const,
        identity: `lineage:${binding.root_session_id}`,
        content_digest: binding.expected_head_digest,
      })),
      {
        kind: "lineage-association",
        identity: `association:${association.association_id}`,
        content_digest: digestV1("VF-CONVERSATION-AUTHORITY-ABSENT\0v1\0", {
          kind: "lineage-association",
          identity: `association:${association.association_id}`,
        }),
      },
    ];
  }
  const action = plan.action;
  const binding = plan.effect_binding as { expected_operation_state_digest?: unknown };
  if (
    action.type !== HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION ||
    typeof binding.expected_operation_state_digest !== "string"
  )
    throw new Error("invalid conversation stop authority plan");
  return [
    {
      kind: "conversation-lock",
      identity: `conversation:${plan.expected.conversation_id}`,
      content_digest: plan.expected.conversation_lock_digest,
    },
    {
      kind: "conversation-operation",
      identity: `operation:${action.operation_id}`,
      content_digest: binding.expected_operation_state_digest,
    },
  ];
}
