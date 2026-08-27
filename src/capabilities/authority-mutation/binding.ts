import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { EMPTY_PERMISSION_DIGEST, assertApproval, assertProposal } from "../../actions/index.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import { canonicalJson } from "../../durability/index.js";
import { actionBlobRef } from "../planning/execution-objects.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import { assertCurrentAutomationGrantBinding } from "./automation-grant-authority.js";
import {
  actionPlanDigest,
  validateActionPlan,
  validateAuthorityPlan,
  validateEffectPlan,
  validateOperationBinding,
  validatePolicyInverse,
} from "./contracts.js";
import {
  POLICY_SETTINGS_CONTENT_KIND,
  policySettingsContentDigest,
  policySettingsRawSha256,
  settingsPolicyState,
} from "./policy.js";
import type { OrdinaryAuthorityDurableStoreV1 } from "./store.js";
import type {
  AuthorityActionPlanBindingV1,
  AuthorityChangeEffectPlanV1,
  AuthorityChangeOperationV1,
  AuthorityChangePlanV1,
  OrdinaryAuthorityMutationOptionsV1,
  PolicyAuthorityInverseDescriptorV1,
  SecretRevocationCandidateV1,
} from "./types.js";

export interface OrdinaryAuthorityProposalClosureV1 {
  action_plan: AuthorityActionPlanBindingV1;
  plan: AuthorityChangePlanV1;
  effect: AuthorityChangeEffectPlanV1;
  inverse: PolicyAuthorityInverseDescriptorV1 | null;
  candidate: SecretRevocationCandidateV1 | null;
  preimage: Buffer | null;
  replacement: Buffer | null;
}

function fail(message: string, path = "authority.binding"): never {
  throw new CapabilityValidationError(message, path, "integrity_failure");
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function policyClosure(
  store: OrdinaryAuthorityDurableStoreV1,
  plan: AuthorityChangePlanV1,
  effect: AuthorityChangeEffectPlanV1,
) {
  const action = plan.authority_action;
  if (action.type !== HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY)
    return fail("policy closure action type changed");
  const inverseDigest = effect.inverse_descriptor_digest ?? fail("policy inverse digest is absent");
  const inverse = validatePolicyInverse(
    store.readActionObject<PolicyAuthorityInverseDescriptorV1>(inverseDigest, "policy inverse"),
  );
  const preimageDigest =
    effect.private_preimage_content_digest ?? fail("policy preimage digest is absent");
  const replacementDigest =
    effect.private_replacement_content_digest ?? fail("policy replacement digest is absent");
  const preimage = store.readActionBlob(preimageDigest, "policy preimage");
  const replacement = store.readActionBlob(replacementDigest, "policy replacement");
  const prior = settingsPolicyState({
    scope: plan.scope,
    scope_identity_digest: plan.scope_identity_digest,
    bytes: preimage,
  });
  const next = settingsPolicyState({
    scope: plan.scope,
    scope_identity_digest: plan.scope_identity_digest,
    bytes: replacement,
  });
  if (
    effect.expected_preimage_sha256 !== policySettingsRawSha256(preimage) ||
    effect.expected_preimage_byte_length !== preimage.byteLength ||
    preimageDigest !==
      policySettingsContentDigest(POLICY_SETTINGS_CONTENT_KIND.PREIMAGE, preimage) ||
    effect.private_preimage_ref !== actionBlobRef(preimageDigest) ||
    effect.replacement_sha256 !== policySettingsRawSha256(replacement) ||
    effect.replacement_byte_length !== replacement.byteLength ||
    replacementDigest !==
      policySettingsContentDigest(POLICY_SETTINGS_CONTENT_KIND.REPLACEMENT, replacement) ||
    effect.private_replacement_ref !== actionBlobRef(replacementDigest) ||
    prior.settings_schema_version !== action.change.settings_schema_version ||
    prior.policy_digest !== action.change.expected_policy_digest ||
    next.policy_digest !== action.change.replacement_policy_digest ||
    inverse.scope !== plan.scope ||
    inverse.scope_identity_digest !== plan.scope_identity_digest ||
    inverse.settings_schema_version !== action.change.settings_schema_version ||
    inverse.expected_current_sha256 !== effect.replacement_sha256 ||
    inverse.expected_current_policy_digest !== action.change.replacement_policy_digest ||
    inverse.restore_sha256 !== effect.expected_preimage_sha256 ||
    inverse.restore_byte_length !== effect.expected_preimage_byte_length ||
    inverse.restore_content_digest !== preimageDigest ||
    inverse.restore_policy_digest !== action.change.expected_policy_digest ||
    inverse.private_restore_ref !== effect.private_preimage_ref
  )
    return fail("policy raw-byte/inverse closure changed");
  return { inverse, preimage, replacement };
}

function secretClosure(
  store: OrdinaryAuthorityDurableStoreV1,
  plan: AuthorityChangePlanV1,
): SecretRevocationCandidateV1 | null {
  const action = plan.authority_action;
  if (action.type !== HOST_ACTION_KIND.SECRET_REVOKE) return null;
  const match =
    /^actions\/v1\/secret-revocation-candidates\/(vf-secret-revocation-binding-[a-f0-9]{64})\.json$/u.exec(
      action.private_binding_ref,
    );
  if (!match?.[1]) return fail("secret revocation candidate ref is not its fixed logical path");
  const candidate = store.readSecretCandidate(match[1]);
  if (
    candidate.binding_digest !== action.expected_binding_digest ||
    candidate.scope !== plan.scope ||
    candidate.scope_identity_digest !== plan.scope_identity_digest ||
    candidate.secret_handle_id_digest !== plan.authority_subject_id
  )
    return fail("secret candidate does not equal the approved authority plan");
  return candidate;
}

export function readOrdinaryAuthorityProposalClosure(
  store: OrdinaryAuthorityDurableStoreV1,
  proposal: import("../../actions/index.js").ActionProposalV1,
): OrdinaryAuthorityProposalClosureV1 {
  assertProposal(proposal);
  const actionPlan = store.readActionObject<AuthorityActionPlanBindingV1>(
    proposal.plan_digest,
    "authority action plan",
  );
  if (actionPlanDigest(actionPlan) !== proposal.plan_digest || actionPlan.steps.length !== 1)
    return fail("authority action plan fixed-path digest mismatch");
  const plan = validateAuthorityPlan(
    store.readActionObject<AuthorityChangePlanV1>(
      actionPlan.steps[0]?.plan_digest ?? fail("authority native plan is absent"),
      "authority native plan",
    ),
  );
  validateActionPlan(actionPlan, plan);
  const effect = validateEffectPlan(
    store.readActionObject<AuthorityChangeEffectPlanV1>(
      plan.recovery_plan_digest,
      "authority effect plan",
    ),
  );
  if (
    proposal.action_root_locator.kind !== ACTION_ROOT_LOCATOR_KIND.CAPABILITY ||
    proposal.action_root_locator.scope !== store.paths.scope ||
    proposal.action_root_locator.scope_identity_digest !== plan.scope_identity_digest ||
    !exact(proposal.action_root_locator, actionPlan.action_root_locator) ||
    !exact(proposal.action, plan.authority_action) ||
    proposal.base.capability_scope !== plan.scope ||
    proposal.base.authority_epoch !== plan.expected_authority_epoch ||
    proposal.base.authority_head_digest !== plan.expected_authority_head_digest ||
    proposal.permission_digest !== plan.permission_digest ||
    proposal.created_at !== plan.created_at ||
    proposal.expires_at !== plan.expires_at ||
    effect.scope !== plan.scope ||
    effect.scope_identity_digest !== plan.scope_identity_digest ||
    effect.change !== plan.change ||
    effect.authority_subject_id !== plan.authority_subject_id ||
    effect.plan_digest !== plan.recovery_plan_digest
  )
    return fail("proposal, action plan, native plan, and effect plan disagree");
  const policy =
    plan.authority_action.type === HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY
      ? policyClosure(store, plan, effect)
      : null;
  return {
    action_plan: actionPlan,
    plan,
    effect,
    inverse: policy?.inverse ?? null,
    preimage: policy?.preimage ?? null,
    replacement: policy?.replacement ?? null,
    candidate: secretClosure(store, plan),
  };
}

export function assertCurrentOrdinaryAuthorityProposal(input: {
  store: OrdinaryAuthorityDurableStoreV1;
  proposal: import("../../actions/index.js").ActionProposalV1;
  options: OrdinaryAuthorityMutationOptionsV1;
  now: string;
}): OrdinaryAuthorityProposalClosureV1 {
  const closure = readOrdinaryAuthorityProposalClosure(input.store, input.proposal);
  const state = input.store.readCommitted();
  if (
    state.current.authority_epoch !== closure.plan.expected_authority_epoch ||
    state.current.content_digest !== closure.plan.expected_authority_head_digest ||
    state.current.policy_digest !== input.proposal.policy_digest ||
    state.current.grant_digest !== input.proposal.grant_digest ||
    Date.parse(input.now) > Date.parse(input.proposal.expires_at)
  )
    return fail("live authority no longer equals the proposal base", "authority.stale");
  if (closure.plan.automation_grant_binding)
    assertCurrentAutomationGrantBinding({
      store: input.store,
      binding: closure.plan.automation_grant_binding,
      actor: input.proposal.requested_by,
      now: input.now,
    });
  else if (input.proposal.permission_digest !== EMPTY_PERMISSION_DIGEST)
    return fail("interactive authority unexpectedly carries a permission binding");
  if (closure.preimage && !closure.preimage.equals(input.store.readRaw().settings))
    return fail("live settings bytes no longer equal the policy preimage", "authority.stale");
  if (closure.candidate) {
    input.options.secret_candidate_authority?.validateCurrent(closure.candidate);
    if (
      state.secrets.some(
        (row) =>
          row.secret_handle_id_digest === closure.candidate?.secret_handle_id_digest &&
          row.expected_binding_digest === closure.candidate.binding_digest,
      )
    )
      return fail("secret revocation candidate is already revoked", "authority.stale");
  }
  return closure;
}

export function assertOrdinaryAuthorityOperationBinding(input: {
  store: OrdinaryAuthorityDurableStoreV1;
  proposal: import("../../actions/index.js").ActionProposalV1;
  approval: import("../../actions/index.js").ActionApprovalV1;
  header: AuthorityChangeOperationV1;
}) {
  assertApproval(input.proposal, input.approval);
  const closure = readOrdinaryAuthorityProposalClosure(input.store, input.proposal);
  validateOperationBinding({
    proposal: input.proposal,
    approval: input.approval,
    header: input.header,
    plan: closure.plan,
    effect: closure.effect,
    actor: input.approval.decided_by,
  });
  return closure;
}
