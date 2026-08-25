import type {
  ActionProposalRequestV1,
  ActionRequestAuthorityV1,
  BrowserHostActionRequestV1,
  HostActionV1,
} from "../../actions/index.js";
import { digestV1 } from "../../durability/index.js";
import { conversationLockDigest } from "./catalog-lock.js";
import { materializeRevisionControlEffectClosure } from "./conversation-control-effect-planner.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { assertReceiptSource } from "./conversation-receipt-native-plans.js";
import { materializeConversationReceiptProposal } from "./conversation-receipt-planner.js";
import type { ConversationLineageService } from "./lineage-service.js";
import { revisionAbandonIsProved, revisionRetryIsProved } from "./revision-control-evidence.js";
import { foldRevisionOperation } from "./revision-fold.js";

export const REVISION_CONTROL_ACTIONS = new Set<BrowserHostActionRequestV1["type"]>([
  "conversation.abandon_revision_operation",
  "conversation.retry_revision_operation",
  "conversation.reconcile_revision_operation",
]);

export type RevisionControlCandidateV1 = Extract<
  BrowserHostActionRequestV1,
  {
    type:
      | "conversation.abandon_revision_operation"
      | "conversation.retry_revision_operation"
      | "conversation.reconcile_revision_operation";
  }
>;

export function isRevisionControlCandidate(
  candidate: BrowserHostActionRequestV1,
): candidate is RevisionControlCandidateV1 {
  return REVISION_CONTROL_ACTIONS.has(candidate.type);
}

export async function proposeRevisionControlAction(input: {
  lineages: ConversationLineageService;
  home: ConversationHomeAuthorities;
  quiescent(conversationId: string, operationId: string): boolean;
  conversation_id: string;
  request: ActionProposalRequestV1;
  authority: ActionRequestAuthorityV1;
}) {
  const candidate = input.request.candidate;
  if (!isRevisionControlCandidate(candidate))
    throw new Error("unsupported revision control action");
  const operation = input.home.revisions.readOperation(candidate.revision_operation_id);
  if (!operation) throw new Error("revision control target operation is absent");
  let resolved: ReturnType<ConversationLineageService["resolve"]>;
  try {
    resolved = input.lineages.resolve(input.conversation_id);
  } catch (error) {
    if (candidate.type !== "conversation.abandon_revision_operation") throw error;
    resolved = input.lineages.resolveRevisionRecovery(
      input.conversation_id,
      operation.root_session_id,
      operation.operation_id,
    );
  }
  assertReceiptSource(resolved, input.request);
  if (operation.root_session_id !== resolved.lineage.root_session_id)
    throw new Error("revision control target is absent from the selected lineage");
  const events = input.home.revisions.readEvents(operation.operation_id);
  const folded = foldRevisionOperation(operation, events);
  const preparation = input.home.revisions.readPlan(operation.operation_id);
  if (!preparation) throw new Error("revision control preparation plan disappeared");
  const quiescent = input.quiescent(operation.child.conversation_id, operation.operation_id);
  const createdAt = input.home.now();
  const headDigest = resolved.head.content_digest;
  let action: HostActionV1;
  if (candidate.type === "conversation.abandon_revision_operation") {
    if (
      !revisionAbandonIsProved({
        home: input.home,
        lineages: input.lineages,
        operation,
        events,
        quiescent,
      })
    )
      throw new Error("revision operation is not abandonable");
    action = { ...candidate, expected_header_digest: operation.header_digest };
  } else if (candidate.type === "conversation.retry_revision_operation") {
    if (
      !revisionRetryIsProved({
        home: input.home,
        lineages: input.lineages,
        operation,
        events,
        quiescent,
      })
    )
      throw new Error("revision operation retry lacks canceled and quiescent lane evidence");
    action = {
      ...candidate,
      expected_header_digest: operation.header_digest,
      expected_head_digest: headDigest,
    };
  } else {
    if (folded.state !== "needs_recovery")
      throw new Error("revision operation does not need reconciliation");
    action = {
      ...candidate,
      expected_header_digest: operation.header_digest,
      expected_state_digest: folded.state_digest,
      expected_effect_action_operation_id: folded.effect_action_operation_id,
    };
  }
  const effect = materializeRevisionControlEffectClosure({
    action_type: candidate.type,
    operation,
    preparation,
    events,
    expected_pre_effect_fold_digest: folded.state_digest,
  });
  input.home.controlEffects.writeClosure(effect);
  const expiresAt = new Date(Date.parse(createdAt) + 60 * 60_000).toISOString();
  const preimage = {
    schema_version: "1.0" as const,
    action_type: action.type,
    root_session_id: operation.root_session_id,
    target_operation_id: operation.operation_id,
    expected_operation_header_digest: operation.header_digest,
    expected_operation_state_digest: folded.state_digest,
    expected_lineage_head_digest: headDigest,
    expected_effect_action_operation_id:
      candidate.type === "conversation.reconcile_revision_operation"
        ? folded.effect_action_operation_id
        : null,
    control_effect_plan_digest: effect.plan.plan_digest,
    created_at: createdAt,
    expires_at: expiresAt,
  };
  const native = {
    ...preimage,
    plan_digest: digestV1("VF-CONVERSATION-CONTROL-PLAN\0v1\0", preimage),
  };
  const lock = conversationLockDigest(
    resolved.lineage.root_session_id,
    resolved.requested.source,
    resolved.revision_claim_epoch,
  );
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
    action,
    authority: input.authority,
    effect_binding: native,
    native_step: { kind: "conversation-control", digest: native.plan_digest },
    created_at: createdAt,
  });
  input.home.actionReceipts.writePlan(planned.proposal_plan);
  const created = input.home.actions.create(planned.proposal_plan, input.authority);
  return { created: created.created, proposal_id: created.proposal.proposal_id };
}
