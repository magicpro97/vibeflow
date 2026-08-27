import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { type ActionApprovalV1, CAPABILITY_AUTHORITY_CHANGE } from "../../actions/index.js";
import { CREDENTIAL_CLASS } from "../../actions/public-action-contract.js";
import { digestV1 } from "../../durability/index.js";
import {
  POLICY_AUTHORITY_STATE,
  applyAuthorityEvent,
  authorityEpochEventDigest,
  foldGrantFrames,
  foldPolicyFrames,
  foldSecretRevocations,
  foldTrustFrames,
  grantFrameDigest,
  policyAuthorityFrameDigest,
  registryTrustFrameDigest,
  secretRevocationFrameDigest,
} from "../authority/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityTransitionEvidenceV1,
  GrantFrameV1,
  PolicyAuthorityFrameV1,
  RegistryTrustKeyFrameV1,
  SecretRevocationFrameV1,
} from "../authority/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import { grantTransitionForAction } from "./contracts.js";
import type { OrdinaryAuthorityRawStateV1 } from "./store.js";
import type {
  AuthorityChangeEffectPlanV1,
  AuthorityChangeOperationV1,
  AuthorityChangePlanV1,
  SecretRevocationCandidateV1,
} from "./types.js";

export interface StagedOrdinaryAuthorityTransitionV1 {
  grant: GrantFrameV1 | null;
  policy: readonly [PolicyAuthorityFrameV1, PolicyAuthorityFrameV1, PolicyAuthorityFrameV1] | null;
  secret: SecretRevocationFrameV1 | null;
  trust: RegistryTrustKeyFrameV1 | null;
  event: AuthorityEpochEventV1;
  evidence: Exclude<
    AuthorityTransitionEvidenceV1,
    { change: typeof CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED }
  >;
  next: AuthorityEpochHeadV1;
}

function fail(message: string): never {
  throw new CapabilityValidationError(message, "authority.transition", "integrity_failure");
}

function required<T>(value: T | null, field: string): T {
  return value ?? fail(`policy effect is missing ${field}`);
}

function common(input: {
  header: AuthorityChangeOperationV1;
  plan: AuthorityChangePlanV1;
  authorityEpoch: number;
}) {
  return {
    schema_version: "1.0" as const,
    authority_epoch: input.authorityEpoch,
    operation_id: input.header.operation_id,
    proposal_id: input.header.proposal_id,
    approval_id: input.header.approval_id,
    plan_digest: input.plan.plan_digest,
    action_root_locator: structuredClone(input.header.action_root_locator),
    operation_header_digest: input.header.header_digest,
  };
}

function grantFrame(input: {
  prior: AuthorityEpochHeadV1;
  raw: OrdinaryAuthorityRawStateV1;
  header: AuthorityChangeOperationV1;
  plan: AuthorityChangePlanV1;
  approval: ActionApprovalV1;
  recordedAt: string;
}): GrantFrameV1 {
  const action = input.plan.authority_action;
  const transition = grantTransitionForAction(action);
  if (!transition) return fail("grant frame requested for a non-grant action");
  const folded = foldGrantFrames(
    input.raw.grants,
    input.prior.scope,
    input.prior.scope_identity_digest,
  );
  const grantId = input.header.authority_subject_id;
  const previous = folded.latest.get(grantId);
  if (action.type !== HOST_ACTION_KIND.GRANT_CREATE && !previous)
    return fail("grant transition predecessor is absent");
  const grant =
    action.type === HOST_ACTION_KIND.GRANT_CREATE || action.type === HOST_ACTION_KIND.GRANT_RENEW
      ? action.grant
      : null;
  if (grant?.permissions.some((permission) => permission.enforcement === "unsupported"))
    return fail("unsupported permission enforcement cannot enter grant authority");
  const permissions = grant
    ? (structuredClone(grant.permissions) as unknown as GrantFrameV1["permissions"])
    : structuredClone((previous as GrantFrameV1).permissions);
  const draft = {
    ...common({
      header: input.header,
      plan: input.plan,
      authorityEpoch: input.prior.authority_epoch + 1,
    }),
    frame_id: "",
    previous_frame_digest: folded.head_frame_digest,
    grant_sequence: input.raw.grants.length + 1,
    transition,
    grant_id: grantId,
    scope: input.prior.scope,
    scope_identity_digest: input.prior.scope_identity_digest,
    principal: grant
      ? {
          public_actor_id: grant.principal_id,
          credential_class: CREDENTIAL_CLASS.AUTOMATION_GRANT,
        }
      : structuredClone((previous as GrantFrameV1).principal),
    action_types: grant
      ? structuredClone(grant.action_types)
      : structuredClone((previous as GrantFrameV1).action_types),
    permissions,
    target_engines: grant
      ? structuredClone(grant.target_engines)
      : structuredClone((previous as GrantFrameV1).target_engines),
    acted_by: structuredClone(input.approval.decided_by),
    recorded_at: input.recordedAt,
    not_before: grant ? input.plan.created_at : (previous as GrantFrameV1).not_before,
    expires_at: grant ? grant.expires_at : (previous as GrantFrameV1).expires_at,
    revoked_at: action.type === HOST_ACTION_KIND.GRANT_REVOKE ? input.recordedAt : null,
    reason_digest: null,
    frame_digest: "",
  } satisfies GrantFrameV1;
  draft.frame_digest = grantFrameDigest(draft);
  draft.frame_id = `vf-grant-frame-${draft.frame_digest.slice("sha256:".length)}`;
  return draft;
}

function policyFrames(input: {
  prior: AuthorityEpochHeadV1;
  raw: OrdinaryAuthorityRawStateV1;
  header: AuthorityChangeOperationV1;
  plan: AuthorityChangePlanV1;
  effect: AuthorityChangeEffectPlanV1;
  recordedAt: string;
}): [PolicyAuthorityFrameV1, PolicyAuthorityFrameV1, PolicyAuthorityFrameV1] {
  const action = input.plan.authority_action;
  if (action.type !== HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY)
    return fail("policy frames requested for a non-policy action");
  const folded = foldPolicyFrames(
    input.raw.policies,
    input.prior.scope,
    input.prior.scope_identity_digest,
  );
  if (
    folded.head_frame_digest !== input.prior.policy_head_digest ||
    (folded.policy_digest !== null && folded.policy_digest !== input.prior.policy_digest)
  )
    return fail("policy journal does not equal the committed policy head");
  const base = {
    ...common({
      header: input.header,
      plan: input.plan,
      authorityEpoch: input.prior.authority_epoch + 1,
    }),
    scope: input.prior.scope,
    scope_identity_digest: input.prior.scope_identity_digest,
    settings_schema_version: action.change.settings_schema_version,
    expected_settings_sha256: required(
      input.effect.expected_preimage_sha256,
      "expected_preimage_sha256",
    ),
    expected_settings_byte_length: required(
      input.effect.expected_preimage_byte_length,
      "expected_preimage_byte_length",
    ),
    private_preimage_content_digest: required(
      input.effect.private_preimage_content_digest,
      "private_preimage_content_digest",
    ),
    replacement_settings_sha256: required(input.effect.replacement_sha256, "replacement_sha256"),
    replacement_settings_byte_length: required(
      input.effect.replacement_byte_length,
      "replacement_byte_length",
    ),
    private_replacement_content_digest: required(
      input.effect.private_replacement_content_digest,
      "private_replacement_content_digest",
    ),
    prior_policy_digest: action.change.expected_policy_digest,
    replacement_policy_digest: action.change.replacement_policy_digest,
    private_preimage_ref: required(input.effect.private_preimage_ref, "private_preimage_ref"),
    private_replacement_ref: required(
      input.effect.private_replacement_ref,
      "private_replacement_ref",
    ),
    recorded_at: input.recordedAt,
  };
  const rows: PolicyAuthorityFrameV1[] = [];
  const states = [
    POLICY_AUTHORITY_STATE.PREPARED,
    POLICY_AUTHORITY_STATE.EFFECT_IN_PROGRESS,
    POLICY_AUTHORITY_STATE.OBSERVED,
  ] as const;
  for (const [offset, state] of states.entries()) {
    const draft: PolicyAuthorityFrameV1 = {
      ...base,
      sequence: input.raw.policies.length + offset,
      previous_frame_digest: rows.at(-1)?.frame_digest ?? folded.head_frame_digest,
      state: state as PolicyAuthorityFrameV1["state"],
      observed_settings_sha256:
        state === POLICY_AUTHORITY_STATE.OBSERVED
          ? required(input.effect.replacement_sha256, "replacement_sha256")
          : null,
      frame_digest: "",
    };
    draft.frame_digest = policyAuthorityFrameDigest(draft);
    rows.push(draft);
  }
  return rows as [PolicyAuthorityFrameV1, PolicyAuthorityFrameV1, PolicyAuthorityFrameV1];
}

function secretFrame(input: {
  prior: AuthorityEpochHeadV1;
  raw: OrdinaryAuthorityRawStateV1;
  header: AuthorityChangeOperationV1;
  plan: AuthorityChangePlanV1;
  approval: ActionApprovalV1;
  candidate: SecretRevocationCandidateV1 | null;
  recordedAt: string;
}): SecretRevocationFrameV1 {
  const action = input.plan.authority_action;
  if (action.type !== HOST_ACTION_KIND.SECRET_REVOKE || !input.candidate)
    return fail("secret frame lacks its retained candidate");
  const draft: SecretRevocationFrameV1 = {
    ...common({
      header: input.header,
      plan: input.plan,
      authorityEpoch: input.prior.authority_epoch + 1,
    }),
    scope: input.prior.scope,
    scope_identity_digest: input.prior.scope_identity_digest,
    sequence: input.raw.secrets.length,
    previous_frame_digest: input.raw.secrets.at(-1)?.frame_digest ?? null,
    secret_handle_id_digest: input.candidate.secret_handle_id_digest,
    expected_binding_digest: action.expected_binding_digest,
    revoked_by: structuredClone(input.approval.decided_by),
    revoked_at: input.recordedAt,
    reason_digest: null,
    frame_digest: "",
  };
  draft.frame_digest = secretRevocationFrameDigest(draft);
  return draft;
}

function trustFrame(input: {
  prior: AuthorityEpochHeadV1;
  raw: OrdinaryAuthorityRawStateV1;
  header: AuthorityChangeOperationV1;
  plan: AuthorityChangePlanV1;
  recordedAt: string;
}): RegistryTrustKeyFrameV1 {
  const action = input.plan.authority_action;
  if (action.type !== HOST_ACTION_KIND.REGISTRY_TRUST_KEY)
    return fail("trust frame requested for a non-trust action");
  const draft: RegistryTrustKeyFrameV1 = {
    ...common({
      header: input.header,
      plan: input.plan,
      authorityEpoch: input.prior.authority_epoch + 1,
    }),
    scope: input.prior.scope,
    scope_identity_digest: input.prior.scope_identity_digest,
    previous_frame_digest: input.raw.trust.at(-1)?.frame_digest ?? null,
    trust_epoch: input.raw.trust.length + 1,
    transition: action.change.transition,
    key_id: action.change.key_id,
    algorithm: action.change.algorithm,
    public_key_spki_base64: action.change.public_key_spki_base64,
    registry_origin: action.change.registry_origin,
    publisher_id: action.change.publisher_id,
    valid_from: action.change.valid_from,
    valid_until: action.change.valid_until,
    reason_digest: action.change.reason
      ? digestV1("VF-AUTHORITY-REASON\0v1\0", {
          schema_version: "1.0",
          action_type: action.type,
          reason: action.change.reason,
        })
      : null,
    recorded_at: input.recordedAt,
    frame_digest: "",
  };
  draft.frame_digest = registryTrustFrameDigest(draft);
  return draft;
}

function logical(head: AuthorityEpochHeadV1) {
  return {
    grant_head_digest: head.grant_head_digest,
    grant_digest: head.grant_digest,
    policy_head_digest: head.policy_head_digest,
    policy_digest: head.policy_digest,
    secret_revocation_digest: head.secret_revocation_digest,
    trust_head_digest: head.trust_head_digest,
    trust_epoch: head.trust_epoch,
  };
}

export function materializeStagedAuthorityTransition(input: {
  prior: AuthorityEpochHeadV1;
  raw: OrdinaryAuthorityRawStateV1;
  header: AuthorityChangeOperationV1;
  plan: AuthorityChangePlanV1;
  effect: AuthorityChangeEffectPlanV1;
  approval: ActionApprovalV1;
  candidate: SecretRevocationCandidateV1 | null;
  recorded_at: string;
}): StagedOrdinaryAuthorityTransitionV1 {
  const frameInput = { ...input, recordedAt: input.recorded_at };
  const grant =
    input.header.change === CAPABILITY_AUTHORITY_CHANGE.GRANT_CHANGED
      ? grantFrame(frameInput)
      : null;
  const policy =
    input.header.change === CAPABILITY_AUTHORITY_CHANGE.POLICY_CHANGED
      ? policyFrames(frameInput)
      : null;
  const secret =
    input.header.change === CAPABILITY_AUTHORITY_CHANGE.SECRET_REVOKED
      ? secretFrame(frameInput)
      : null;
  const trust =
    input.header.change === CAPABILITY_AUTHORITY_CHANGE.REGISTRY_TRUST_CHANGED
      ? trustFrame(frameInput)
      : null;
  const nextState = logical(input.prior);
  let evidence: StagedOrdinaryAuthorityTransitionV1["evidence"];
  if (grant) {
    const rows = [...input.raw.grants, grant];
    const folded = foldGrantFrames(rows, input.prior.scope, input.prior.scope_identity_digest);
    nextState.grant_head_digest = folded.head_frame_digest;
    nextState.grant_digest = folded.grant_digest;
    evidence = { change: CAPABILITY_AUTHORITY_CHANGE.GRANT_CHANGED, grant_frames: rows };
  } else if (policy) {
    const rows = [...input.raw.policies, ...policy];
    const folded = foldPolicyFrames(rows, input.prior.scope, input.prior.scope_identity_digest);
    nextState.policy_head_digest = folded.head_frame_digest;
    nextState.policy_digest = folded.policy_digest ?? fail("observed policy digest is absent");
    evidence = { change: CAPABILITY_AUTHORITY_CHANGE.POLICY_CHANGED, policy_frames: rows };
  } else if (secret) {
    const rows = [...input.raw.secrets, secret];
    nextState.secret_revocation_digest = foldSecretRevocations(
      rows,
      input.prior.scope,
      input.prior.scope_identity_digest,
    );
    evidence = { change: CAPABILITY_AUTHORITY_CHANGE.SECRET_REVOKED, secret_frames: rows };
  } else if (trust) {
    const rows = [...input.raw.trust, trust];
    foldTrustFrames(rows);
    nextState.trust_head_digest = trust.frame_digest;
    nextState.trust_epoch = trust.trust_epoch;
    evidence = { change: CAPABILITY_AUTHORITY_CHANGE.REGISTRY_TRUST_CHANGED, trust_frames: rows };
  } else return fail("ordinary authority transition has no typed frame");
  const event: AuthorityEpochEventV1 = {
    schema_version: "1.0",
    scope: input.prior.scope,
    scope_identity_digest: input.prior.scope_identity_digest,
    authority_epoch: input.prior.authority_epoch + 1,
    previous_event_digest: input.prior.event_head_digest,
    previous_head_digest: input.prior.content_digest,
    previous_head_checkpoint_digest: input.prior.content_digest,
    change: input.header.change,
    prior_state: logical(input.prior),
    next_state: nextState,
    proposal_id: input.header.proposal_id,
    approval_id: input.header.approval_id,
    operation_id: input.header.operation_id,
    plan_digest: input.plan.plan_digest,
    action_root_locator: structuredClone(input.header.action_root_locator),
    operation_header_digest: input.header.header_digest,
    recorded_at: input.recorded_at,
    event_digest: "",
  };
  event.event_digest = authorityEpochEventDigest(event);
  return {
    grant,
    policy,
    secret,
    trust,
    event,
    evidence,
    next: applyAuthorityEvent(input.prior, event, evidence),
  };
}
