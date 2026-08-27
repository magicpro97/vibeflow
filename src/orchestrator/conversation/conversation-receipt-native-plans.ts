import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type { ActionProposalRequestV1, BrowserHostActionRequestV1 } from "../../actions/index.js";
import { digestV1 } from "../../durability/index.js";
import { conversationLockDigest } from "./catalog-lock.js";
import { CONVERSATION_HEAD_STATUS } from "./conversation-catalog-contract.js";
import { materializeStopControlEffectClosure } from "./conversation-control-effect-planner.js";
import type { ConversationControlEffectStore } from "./conversation-control-effect-store.js";
import type { OrdinaryConversationOperationAuthorityV1 } from "./conversation-operation-fold.js";
import { ConversationReceiptCandidateUnavailableError } from "./conversation-receipt-errors.js";
import type { LineageAssociationPlanV1 } from "./lineage-association.js";
import type { LineageHeadSelectionPlanV1 } from "./lineage-head-authority.js";
import type {
  ConversationLineageService,
  ResolvedConversationLineageV1,
} from "./lineage-service.js";

export interface ConversationControlPlanV1 {
  schema_version: "1.0";
  action_type: typeof HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION;
  root_session_id: string;
  target_operation_id: string;
  expected_operation_header_digest: string;
  expected_operation_state_digest: string;
  expected_lineage_head_digest: string;
  expected_effect_action_operation_id: null;
  control_effect_plan_digest: string;
  created_at: string;
  expires_at: string;
  plan_digest: string;
}

function plus(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

export function assertReceiptSource(
  resolved: ResolvedConversationLineageV1,
  request: ActionProposalRequestV1,
): void {
  const expected = request.expected;
  const requested = resolved.requested;
  const lock = conversationLockDigest(
    resolved.lineage.root_session_id,
    requested.source,
    resolved.revision_claim_epoch,
  );
  if (
    expected.conversation_id !== requested.node.conversation_id ||
    expected.revision_id !== requested.node.revision_id ||
    expected.last_seq !== requested.source.journal_head.last_seq ||
    expected.conversation_lock_digest !== lock
  )
    throw new Error("conversation receipt expected source changed");
  if (expected.mode === "lineage-recovery") {
    if (
      expected.root_session_id !== resolved.lineage.root_session_id ||
      expected.lineage_head_digest !== resolved.head.content_digest ||
      expected.lineage_head_epoch !== resolved.head.head_epoch
    )
      throw new Error("lineage recovery authority changed");
  } else if (
    resolved.head.head_status !== CONVERSATION_HEAD_STATUS.COMMITTED ||
    resolved.head.active?.conversation_id !== requested.node.conversation_id ||
    resolved.head.active.revision_id !== requested.node.revision_id
  )
    throw new Error("receipt action source is not the writable lineage head");
}

export function materializeSelectionPlan(
  resolved: ResolvedConversationLineageV1,
  candidate: Extract<
    BrowserHostActionRequestV1,
    { type: typeof HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD }
  >,
  createdAt: string,
): LineageHeadSelectionPlanV1 {
  if (
    resolved.head.head_status === CONVERSATION_HEAD_STATUS.COMMITTED ||
    candidate.root_session_id !== resolved.lineage.root_session_id
  )
    throw new ConversationReceiptCandidateUnavailableError(
      HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD,
    );
  const selected = resolved.lineage.nodes.find(
    (node) =>
      node.node.conversation_id === candidate.candidate_conversation_id &&
      node.node.revision_id === candidate.candidate_revision_id &&
      resolved.head.candidate_heads.some(
        (leaf) =>
          leaf.conversation_id === node.node.conversation_id &&
          leaf.revision_id === node.node.revision_id,
      ),
  );
  if (!selected)
    throw new ConversationReceiptCandidateUnavailableError(
      HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD,
    );
  const leaves = resolved.head.candidate_heads.map((leaf) => {
    const node = resolved.lineage.nodes.find(
      (candidateNode) =>
        candidateNode.node.conversation_id === leaf.conversation_id &&
        candidateNode.node.revision_id === leaf.revision_id,
    );
    if (!node) throw new Error("lineage candidate authority is absent");
    return {
      node: leaf,
      manifest_digest: node.manifest_digest,
      ancestry_digest: node.ancestry_digest,
    };
  });
  const preimage = {
    schema_version: "1.0" as const,
    root_session_id: resolved.lineage.root_session_id,
    expected_head_status: resolved.head.head_status,
    expected_head_digest: resolved.head.content_digest,
    expected_head_epoch: resolved.head.head_epoch,
    candidate: structuredClone(selected.node),
    candidate_manifest_digest: selected.manifest_digest,
    candidate_ancestry_digest: selected.ancestry_digest,
    validated_leaf_set_digest: digestV1("VF-LINEAGE-VALIDATED-LEAF-SET\0v1\0", {
      schema_version: "1.0",
      leaves,
    }),
    created_at: createdAt,
    expires_at: plus(createdAt, 60 * 60_000),
  };
  return {
    ...preimage,
    plan_digest: digestV1("VF-LINEAGE-HEAD-SELECTION-PLAN\0v1\0", preimage),
  };
}

export function materializeAssociationPlan(
  lineages: ConversationLineageService,
  candidate: Extract<
    BrowserHostActionRequestV1,
    { type: typeof HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES }
  >,
  createdAt: string,
): LineageAssociationPlanV1 {
  const root_bindings = candidate.root_session_ids.map((id) => {
    const resolved = lineages.resolve(id);
    if (resolved.lineage.root_session_id !== id)
      throw new ConversationReceiptCandidateUnavailableError(
        HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES,
      );
    return {
      root_session_id: id,
      expected_head_digest: resolved.head.content_digest,
      expected_head_epoch: resolved.head.head_epoch,
    };
  });
  const preimage = {
    schema_version: "1.0" as const,
    root_bindings,
    relation: "user-associated-unverified" as const,
    reason_digest: digestV1("VF-AUDIT-REASON\0v1\0", {
      schema_version: "1.0",
      reason: candidate.reason,
    }),
    created_at: createdAt,
    expires_at: plus(createdAt, 60 * 60_000),
  };
  return {
    ...preimage,
    plan_digest: digestV1("VF-LINEAGE-ASSOCIATION-PLAN\0v1\0", preimage),
  };
}

export function materializeControlPlan(
  resolved: ResolvedConversationLineageV1,
  candidate: Extract<
    BrowserHostActionRequestV1,
    { type: typeof HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION }
  >,
  createdAt: string,
  controlEffects: ConversationControlEffectStore,
  operationAuthority: OrdinaryConversationOperationAuthorityV1,
): ConversationControlPlanV1 {
  const lock = conversationLockDigest(
    resolved.lineage.root_session_id,
    resolved.requested.source,
    resolved.revision_claim_epoch,
  );
  const closure = materializeStopControlEffectClosure({
    target_operation_id: candidate.operation_id,
    expected_operation_header_digest: operationAuthority.operation_header_digest,
    expected_pre_effect_fold_digest: operationAuthority.operation_state_digest,
  });
  controlEffects.writeClosure(closure);
  const preimage = {
    schema_version: "1.0" as const,
    action_type: candidate.type,
    root_session_id: resolved.lineage.root_session_id,
    target_operation_id: candidate.operation_id,
    expected_operation_header_digest: operationAuthority.operation_header_digest,
    expected_operation_state_digest: operationAuthority.operation_state_digest,
    expected_lineage_head_digest: resolved.head.content_digest,
    expected_effect_action_operation_id: null,
    control_effect_plan_digest: closure.plan.plan_digest,
    created_at: createdAt,
    expires_at: plus(createdAt, 60 * 60_000),
  };
  return {
    ...preimage,
    plan_digest: digestV1("VF-CONVERSATION-CONTROL-PLAN\0v1\0", preimage),
  };
}
