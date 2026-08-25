import {
  assertCanonicalRequestAuthority,
  assertProposal,
  canonicalActionRequestDigest,
  validateInternalHostAction,
} from "../../actions/index.js";
import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import type {
  ConversationActionAuthorityBindingV1,
  ConversationActionReceiptV1,
  ConversationReceiptNativePlanV1,
  ConversationReceiptProposalPlanV1,
} from "./conversation-action-receipt-store.js";
import {
  type LineagePlanKindV1,
  assertLineageActionPlanBindingV1,
  sameCanonical,
} from "./lineage-action-authority.js";
import {
  hasExactLineageKeys,
  isBoundedLineageReference,
  isLineageDigest,
  isMillisecondIsoDate,
  isPlainLineageRecord,
} from "./lineage-types.js";

const OPERATION = /^vf-operation-[0-9a-f]{64}$/;
const PROPOSAL = /^vf-proposal-[0-9a-f]{64}$/;
const APPROVAL = /^vf-approval-[0-9a-f]{64}$/;

const PLAN_KEYS = [
  "action_plan",
  "canonical_request",
  "native_plan",
  "proposal",
  "proposal_digest",
  "proposal_id",
  "record_digest",
  "schema_version",
] as const;
const NATIVE_KEYS = [
  "action",
  "action_type",
  "created_at",
  "effect_binding",
  "expected",
  "expires_at",
  "plan_digest",
  "root_session_id",
  "schema_version",
] as const;
const EXPECTED_KEYS = [
  "conversation_id",
  "conversation_lock_digest",
  "last_seq",
  "lineage_head_digest",
  "lineage_head_epoch",
  "revision_id",
] as const;

function planKind(actionType: string): LineagePlanKindV1 {
  if (actionType === "conversation.select_lineage_head") return "lineage-head";
  if (actionType === "conversation.associate_lineages") return "lineage-association";
  if (actionType === "conversation.publish_suspected_literal") return "public-literal-publication";
  if (actionType === "context.compact") return "context-compaction";
  return "conversation-control";
}

function assertNativePlan(
  native: ConversationReceiptNativePlanV1,
  plan: ConversationReceiptProposalPlanV1,
): void {
  if (
    !isPlainLineageRecord(native) ||
    !hasExactLineageKeys(native, NATIVE_KEYS) ||
    !isPlainLineageRecord(native.expected) ||
    !hasExactLineageKeys(native.expected, EXPECTED_KEYS) ||
    native.schema_version !== "1.0" ||
    !isBoundedLineageReference(native.root_session_id) ||
    !Number.isSafeInteger(native.expected.last_seq) ||
    native.expected.last_seq < 0 ||
    !Number.isSafeInteger(native.expected.lineage_head_epoch) ||
    native.expected.lineage_head_epoch < 0 ||
    !isMillisecondIsoDate(native.created_at) ||
    !isMillisecondIsoDate(native.expires_at) ||
    native.expires_at <= native.created_at
  )
    throw new Error("invalid conversation receipt native plan");
  for (const digest of [
    native.expected.conversation_lock_digest,
    native.expected.lineage_head_digest,
    native.plan_digest,
  ])
    if (!isLineageDigest(digest)) throw new Error("invalid conversation receipt native digest");
  validateInternalHostAction(native.action);
  if (
    native.action_type !== native.action.type ||
    !sameCanonical(native.action, plan.proposal.action) ||
    native.root_session_id !== plan.proposal.base.root_session_id ||
    native.expected.conversation_id !== plan.proposal.base.conversation_id ||
    native.expected.revision_id !== plan.proposal.base.revision_id ||
    native.expected.last_seq !== plan.proposal.base.last_seq ||
    native.expected.conversation_lock_digest !== plan.proposal.base.conversation_lock_digest ||
    native.expected.lineage_head_digest !== plan.proposal.base.lineage_head_digest ||
    native.expected.lineage_head_epoch !== plan.proposal.base.lineage_head_epoch ||
    native.created_at !== plan.proposal.created_at ||
    native.expires_at !== plan.proposal.expires_at
  )
    throw new Error("conversation receipt native plan closure mismatch");
  const { plan_digest: _digest, ...preimage } = native;
  if (digestV1("VF-CONVERSATION-RECEIPT-NATIVE-PLAN\0v1\0", preimage) !== native.plan_digest)
    throw new Error("invalid conversation receipt native plan digest");
}

export function assertConversationReceiptPlan(value: ConversationReceiptProposalPlanV1): void {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, PLAN_KEYS) ||
    value.schema_version !== "1.0" ||
    !PROPOSAL.test(value.proposal_id)
  )
    throw new Error("invalid conversation receipt proposal plan");
  assertProposal(value.proposal);
  if (
    value.proposal_id !== value.proposal.proposal_id ||
    value.proposal_digest !== value.proposal.proposal_digest ||
    value.proposal.domain !== "conversation" ||
    !sameCanonical(value.proposal.action, value.native_plan.action)
  )
    throw new Error("conversation receipt proposal closure mismatch");
  assertCanonicalRequestAuthority(
    value.canonical_request,
    {
      schema_version: "1.0",
      principal_digest: value.canonical_request.principal_digest,
      authority_scope_digest: value.canonical_request.authority_scope_digest,
      control_session_digest: value.canonical_request.principal_digest,
      csrf_epoch_digest: value.canonical_request.authority_scope_digest,
      actor: value.proposal.requested_by,
    },
    value.proposal,
  );
  if (
    value.proposal.producer_request_binding.kind !== "canonical-action-request" ||
    value.proposal.producer_request_binding.digest !==
      canonicalActionRequestDigest(value.canonical_request)
  )
    throw new Error("conversation receipt request binding mismatch");
  assertNativePlan(value.native_plan, value);
  const effectPlanDigest = (value.native_plan.effect_binding as { plan_digest?: unknown })
    .plan_digest;
  if (!isLineageDigest(effectPlanDigest))
    throw new Error("conversation receipt native effect plan digest is absent");
  assertLineageActionPlanBindingV1(
    value.action_plan,
    effectPlanDigest,
    planKind(value.native_plan.action_type),
    value.proposal,
  );
  if (digestV1("VF-ACTION-PLAN\0v1\0", value.action_plan) !== value.proposal.plan_digest)
    throw new Error("conversation receipt action plan digest mismatch");
  const { record_digest: _record, ...preimage } = value;
  if (digestV1("VF-CONVERSATION-RECEIPT-PROPOSAL-PLAN\0v1\0", preimage) !== value.record_digest)
    throw new Error("invalid conversation receipt proposal record digest");
}

const FACT_PREFIX: Record<ConversationActionAuthorityBindingV1["facts"][number]["kind"], string> = {
  "conversation-lock": "conversation:",
  "conversation-operation": "operation:",
  "public-trace-head": "trace:",
  "lineage-head": "lineage:",
  "lineage-association": "association:",
  "content-object": "content:",
  "literal-staging": "literal:",
};

export function assertConversationActionBinding(value: ConversationActionAuthorityBindingV1): void {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "action_type",
      "binding_digest",
      "facts",
      "phase",
      "plan_digest",
      "schema_version",
    ]) ||
    value.schema_version !== "1.0" ||
    !isLineageDigest(value.plan_digest) ||
    !isLineageDigest(value.binding_digest) ||
    !["expected", "observed"].includes(value.phase) ||
    !Array.isArray(value.facts) ||
    value.facts.length === 0
  )
    throw new Error("invalid conversation action authority binding");
  let prior = "";
  for (const fact of value.facts) {
    if (
      !isPlainLineageRecord(fact) ||
      !hasExactLineageKeys(fact, ["content_digest", "identity", "kind"]) ||
      !(fact.kind in FACT_PREFIX) ||
      !fact.identity.startsWith(FACT_PREFIX[fact.kind]) ||
      !isBoundedLineageReference(fact.identity) ||
      !isLineageDigest(fact.content_digest)
    )
      throw new Error("invalid conversation action authority fact");
    const key = `${fact.kind}\0${fact.identity}`;
    if (prior && Buffer.compare(Buffer.from(prior), Buffer.from(key)) >= 0)
      throw new Error("conversation action authority facts are not unique and sorted");
    prior = key;
  }
  const { binding_digest: _digest, ...preimage } = value;
  if (digestV1("VF-CONVERSATION-ACTION-AUTHORITY-BINDING\0v1\0", preimage) !== value.binding_digest)
    throw new Error("invalid conversation action authority binding digest");
}

export function assertConversationActionReceipt(
  value: ConversationActionReceiptV1,
  plan: ConversationReceiptProposalPlanV1,
  expected: ConversationActionAuthorityBindingV1,
  observed: ConversationActionAuthorityBindingV1,
): void {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "action_type",
      "approval_id",
      "expected_authority_binding_digest",
      "observed_authority_binding_digest",
      "operation_id",
      "outcome",
      "plan_digest",
      "previous_receipt_digest",
      "proposal_id",
      "reason_code",
      "receipt_digest",
      "recorded_at",
      "schema_version",
      "sequence",
    ]) ||
    value.schema_version !== "1.0" ||
    !OPERATION.test(value.operation_id) ||
    !PROPOSAL.test(value.proposal_id) ||
    !APPROVAL.test(value.approval_id) ||
    value.sequence !== 0 ||
    value.previous_receipt_digest !== null ||
    !isMillisecondIsoDate(value.recorded_at) ||
    !isLineageDigest(value.plan_digest) ||
    !isLineageDigest(value.expected_authority_binding_digest) ||
    !isLineageDigest(value.observed_authority_binding_digest) ||
    !isLineageDigest(value.receipt_digest) ||
    !["succeeded", "failed", "needs_recovery"].includes(value.outcome) ||
    (value.outcome === "succeeded") !== (value.reason_code === null) ||
    (value.reason_code !== null &&
      (!/^[a-z][a-z0-9-]{0,127}$/.test(value.reason_code) ||
        !isBoundedLineageReference(value.reason_code)))
  )
    throw new Error("invalid conversation action receipt");
  assertConversationActionBinding(expected);
  assertConversationActionBinding(observed);
  const expectedIdentities = expected.facts.map(({ kind, identity }) => ({ kind, identity }));
  const observedIdentities = observed.facts.map(({ kind, identity }) => ({ kind, identity }));
  if (
    value.proposal_id !== plan.proposal_id ||
    value.action_type !== plan.native_plan.action_type ||
    value.plan_digest !== plan.proposal.plan_digest ||
    value.expected_authority_binding_digest !== expected.binding_digest ||
    value.observed_authority_binding_digest !== observed.binding_digest ||
    expected.action_type !== value.action_type ||
    observed.action_type !== value.action_type ||
    expected.plan_digest !== value.plan_digest ||
    observed.plan_digest !== value.plan_digest ||
    expected.phase !== "expected" ||
    observed.phase !== "observed" ||
    !sameCanonical(expectedIdentities, observedIdentities)
  )
    throw new Error("conversation action receipt authority closure mismatch");
  const { receipt_digest: _digest, ...preimage } = value;
  if (digestV1("VF-CONVERSATION-ACTION-RECEIPT\0v1\0", preimage) !== value.receipt_digest)
    throw new Error("invalid conversation action receipt digest");
  canonicalJsonBytes(value);
}
