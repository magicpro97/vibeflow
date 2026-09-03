import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { validateRepairPlan } from "../../actions/internal-repair-validation.js";
import {
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  ACTION_ROOT_LOCATOR_KIND,
} from "../../actions/protocol-contract.js";
import {
  ACTION_CHALLENGE_CLASS,
  type ACTION_DECISION,
  ACTOR_KIND,
  CREDENTIAL_CLASS,
} from "../../actions/public-action-contract.js";
import { assertDigest, assertTimestamp } from "../../actions/record-primitives.js";
import {
  assertApproval,
  assertProposal,
  assertProposalDraft,
  deriveOperationId,
} from "../../actions/records.js";
import { exactObject } from "../../actions/strict-json.js";
import type {
  ActionApprovalV1,
  ActionProposalDraftV1,
  ActionProposalV1,
} from "../../actions/types.js";
import { canonicalJson, digestHex, digestV1 } from "../../durability/index.js";
import {
  AUTHORITY_REPAIR_DIGEST_DOMAIN,
  AUTHORITY_REPAIR_EVENT_STATE,
  AUTHORITY_REPAIR_LIMIT,
  AUTHORITY_REPAIR_REASON_CODE,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  RECOVERY_BOOTSTRAP_ID_PREFIX,
} from "./contract.js";
import type {
  AuthorityRepairEventV1,
  AuthorityRepairOperationV1,
  RecoveryBootstrapIdentityV1,
} from "./types.js";
import {
  assertAuthorityRepairIdentityFields,
  assertPrivateActionRootLocator,
  assertPublicActor,
  assertScopeTriple,
  assertTargetPreimage,
} from "./validation.js";

function fail(message: string): never {
  throw new Error(`invalid authority repair record: ${message}`);
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function materializeRecoveryBootstrapIdentity(input: {
  bootstrap_id: string;
  created_at: string;
}): RecoveryBootstrapIdentityV1 {
  if (!new RegExp(`^${RECOVERY_BOOTSTRAP_ID_PREFIX}[a-f0-9]{64}$`).test(input.bootstrap_id))
    fail("bootstrap identity ID is invalid");
  assertTimestamp(input.created_at, "$.bootstrap_identity.created_at");
  const preimage = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    bootstrap_id: input.bootstrap_id,
    created_at: input.created_at,
  };
  return {
    ...preimage,
    content_digest: digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.BOOTSTRAP_IDENTITY, preimage),
  };
}

export function assertRecoveryBootstrapIdentity(value: RecoveryBootstrapIdentityV1): void {
  exactObject(
    value,
    ["schema_version", "bootstrap_id", "created_at", "content_digest"],
    [],
    "$.bootstrap_identity",
  );
  const expected = materializeRecoveryBootstrapIdentity({
    bootstrap_id: value.bootstrap_id,
    created_at: value.created_at,
  });
  if (!exact(value, expected)) fail("bootstrap identity digest mismatch");
}

/** Bootstrap proposal materialization is intentionally separate from the ordinary action store. */
export function materializeRecoveryBootstrapProposal(
  draft: ActionProposalDraftV1,
): ActionProposalV1 {
  assertProposalDraft(draft);
  if (
    draft.action_root_locator.kind !== ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP ||
    draft.producer_request_binding.kind !==
      ACTION_PRODUCER_REQUEST_BINDING_KIND.RECOVERY_BOOTSTRAP_REPAIR_PLAN ||
    draft.action.type !== HOST_ACTION_KIND.AUTHORITY_REPAIR ||
    draft.requested_by.kind !== ACTOR_KIND.HUMAN_CLI ||
    draft.requested_by.credential_class !== CREDENTIAL_CLASS.RECOVERY
  )
    fail("bootstrap proposal escaped its recovery-only authority");
  validateRepairPlan(draft.action.plan);
  const proposalDigest = digestV1("VF-ACTION-PROPOSAL\0v1\0", draft);
  return {
    ...structuredClone(draft),
    proposal_id: `vf-proposal-${digestHex(proposalDigest)}`,
    proposal_digest: proposalDigest,
  };
}

export function assertRecoveryBootstrapProposal(value: ActionProposalV1): void {
  const { proposal_id: observedId, proposal_digest: observedDigest, ...draft } = value;
  const expected = materializeRecoveryBootstrapProposal(draft);
  if (observedId !== expected.proposal_id || observedDigest !== expected.proposal_digest)
    fail("bootstrap proposal identity mismatch");
}

export function materializeRecoveryBootstrapApproval(input: {
  proposal: ActionProposalV1;
  decision: typeof ACTION_DECISION.APPROVED | typeof ACTION_DECISION.DENIED;
  decided_at: string;
  expires_at: string;
}): ActionApprovalV1 {
  const { proposal } = input;
  assertRecoveryBootstrapProposal(proposal);
  const actor = proposal.requested_by;
  const decided = assertTimestamp(input.decided_at, "$.bootstrap_approval.decided_at");
  const expires = assertTimestamp(input.expires_at, "$.bootstrap_approval.expires_at");
  const latest = Math.min(
    Date.parse(proposal.expires_at),
    decided + AUTHORITY_REPAIR_LIMIT.APPROVAL_TTL_MS,
  );
  if (expires <= decided || expires > latest) fail("bootstrap approval expiry is invalid");
  const preimage = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    plan_digest: proposal.plan_digest,
    adapter_set_digest: proposal.adapter_set_digest,
    target_set_digest: digestV1("VF-ACTION-TARGET-SET\0v1\0", proposal.target_set),
    package_pin_set_digest: digestV1("VF-ACTION-PACKAGE-PIN-SET\0v1\0", proposal.package_pins),
    source_authority_set_digest: proposal.source_authority_set_digest,
    policy_digest: proposal.policy_digest,
    grant_digest: proposal.grant_digest,
    permission_digest: proposal.permission_digest,
    authority_epoch: proposal.base.authority_epoch,
    authority_head_digest: proposal.base.authority_head_digest,
    reversibility: proposal.reversibility,
    decided_by: structuredClone(actor),
    credential_class: CREDENTIAL_CLASS.RECOVERY,
    challenge_class: ACTION_CHALLENGE_CLASS.RECOVERY_TTY,
    challenge_digest: null,
    decision: input.decision,
    decided_at: input.decided_at,
    expires_at: input.expires_at,
  } as const;
  const approvalDigest = digestV1("VF-ACTION-APPROVAL\0v1\0", preimage);
  return {
    ...preimage,
    approval_id: `vf-approval-${digestHex(approvalDigest)}`,
    approval_digest: approvalDigest,
  };
}

export function assertRecoveryBootstrapApproval(
  proposal: ActionProposalV1,
  value: ActionApprovalV1,
): void {
  if (!exact(value.decided_by, proposal.requested_by)) fail("bootstrap approver changed");
  const expected = materializeRecoveryBootstrapApproval({
    proposal,
    decision: value.decision,
    decided_at: value.decided_at,
    expires_at: value.expires_at,
  });
  if (!exact(value, expected)) fail("bootstrap approval digest mismatch");
}

export function materializeAuthorityRepairOperation(
  proposal: ActionProposalV1,
  approval: ActionApprovalV1,
): AuthorityRepairOperationV1 {
  const ordinary =
    proposal.action_root_locator.kind !== ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP;
  if (ordinary) {
    assertProposal(proposal);
    assertApproval(proposal, approval);
    if (proposal.action.type !== HOST_ACTION_KIND.AUTHORITY_REPAIR)
      fail("ordinary repair proposal carries another action");
  } else {
    assertRecoveryBootstrapProposal(proposal);
    assertRecoveryBootstrapApproval(proposal, approval);
  }
  if (proposal.action.type !== HOST_ACTION_KIND.AUTHORITY_REPAIR)
    fail("repair operation carries another action");
  const plan = proposal.action.plan;
  const preimage = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    repair_id: plan.repair_id,
    operation_id: deriveOperationId(proposal, approval.approval_id),
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    plan_digest: plan.plan_digest,
    action_plan_binding_digest: proposal.plan_digest,
    action_root_locator: structuredClone(proposal.action_root_locator),
    domain: plan.domain,
    authority_scope: plan.authority_scope,
    scope_id: plan.scope_id,
    target_preimage: structuredClone(plan.target_preimage),
    last_valid_record_digest: plan.last_valid_record_digest,
    proposed_restored_authority_digest: plan.proposed_restored_authority_digest,
    repair_authorization_binding_digest: plan.repair_authorization_binding_digest,
    permission_digest: plan.permission_digest,
    approval_id: approval.approval_id,
    approval_digest: approval.approval_digest,
    created_by: structuredClone(approval.decided_by),
    created_at: approval.decided_at,
  };
  return {
    ...preimage,
    header_digest: digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.OPERATION, preimage),
  };
}

export function assertAuthorityRepairOperation(value: AuthorityRepairOperationV1): void {
  exactObject(
    value,
    [
      "schema_version",
      "repair_id",
      "operation_id",
      "proposal_id",
      "proposal_digest",
      "plan_digest",
      "action_plan_binding_digest",
      "action_root_locator",
      "domain",
      "authority_scope",
      "scope_id",
      "target_preimage",
      "last_valid_record_digest",
      "proposed_restored_authority_digest",
      "repair_authorization_binding_digest",
      "permission_digest",
      "approval_id",
      "approval_digest",
      "created_by",
      "created_at",
      "header_digest",
    ],
    [],
    "$.repair_operation",
  );
  assertAuthorityRepairIdentityFields(value);
  assertScopeTriple(value);
  assertTargetPreimage(value.target_preimage);
  assertPrivateActionRootLocator(value.action_root_locator);
  assertPublicActor(value.created_by);
  for (const key of [
    "proposal_digest",
    "plan_digest",
    "action_plan_binding_digest",
    "last_valid_record_digest",
    "proposed_restored_authority_digest",
    "repair_authorization_binding_digest",
    "permission_digest",
    "approval_digest",
    "header_digest",
  ] as const)
    assertDigest(value[key], `$.repair_operation.${key}`);
  assertTimestamp(value.created_at, "$.repair_operation.created_at");
  const { header_digest: observed, ...preimage } = value;
  if (observed !== digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.OPERATION, preimage))
    fail("repair operation header digest mismatch");
}

export function materializeAuthorityRepairEvent(
  operation: AuthorityRepairOperationV1,
  input: Omit<
    AuthorityRepairEventV1,
    "schema_version" | "repair_id" | "operation_id" | "header_digest" | "event_digest"
  >,
): AuthorityRepairEventV1 {
  assertAuthorityRepairOperation(operation);
  const preimage = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    repair_id: operation.repair_id,
    operation_id: operation.operation_id,
    header_digest: operation.header_digest,
    ...input,
  };
  const event = {
    ...preimage,
    event_digest: digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.EVENT, preimage),
  };
  assertAuthorityRepairEvent(event);
  return event;
}

export function assertAuthorityRepairEvent(value: AuthorityRepairEventV1): void {
  exactObject(
    value,
    [
      "schema_version",
      "repair_id",
      "operation_id",
      "header_digest",
      "sequence",
      "previous_event_digest",
      "state",
      "observed_authority_digest",
      "reason_code",
      "recorded_at",
      "event_digest",
    ],
    [],
    "$.repair_event",
  );
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0)
    fail("repair event sequence is invalid");
  if (value.previous_event_digest !== null)
    assertDigest(value.previous_event_digest, "$.repair_event.previous_event_digest");
  assertDigest(value.header_digest, "$.repair_event.header_digest");
  assertTimestamp(value.recorded_at, "$.repair_event.recorded_at");
  const states = Object.values(AUTHORITY_REPAIR_EVENT_STATE);
  if (!states.some((candidate) => candidate === value.state)) fail("repair event state is invalid");
  const hasObservation =
    value.state === AUTHORITY_REPAIR_EVENT_STATE.RESTORED ||
    value.state === AUTHORITY_REPAIR_EVENT_STATE.VERIFIED ||
    value.state === AUTHORITY_REPAIR_EVENT_STATE.FAILED ||
    value.state === AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY;
  if (hasObservation !== (value.observed_authority_digest !== null))
    fail("repair event observation nullability mismatch");
  if (value.observed_authority_digest !== null)
    assertDigest(value.observed_authority_digest, "$.repair_event.observed_authority_digest");
  const hasReason =
    value.state === AUTHORITY_REPAIR_EVENT_STATE.FAILED ||
    value.state === AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY;
  if (hasReason !== (value.reason_code !== null)) fail("repair event reason nullability mismatch");
  if (
    value.reason_code !== null &&
    !Object.values(AUTHORITY_REPAIR_REASON_CODE).some(
      (candidate) => candidate === value.reason_code,
    )
  )
    fail("repair event reason is invalid");
  const { event_digest: observed, ...preimage } = value;
  if (observed !== digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.EVENT, preimage))
    fail("repair event digest mismatch");
}

export * from "./bootstrap-event-records.js";
export * from "./bootstrap-activation-records.js";
