import { randomBytes as systemRandomBytes } from "node:crypto";
import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  EMPTY_ADAPTER_SET_DIGEST,
  EMPTY_PERMISSION_DIGEST,
  EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
  actionIdempotencyScopeDigest,
  canonicalActionRequestDigest,
  materializeProposal,
  validateHostActionRequest,
} from "../../actions/index.js";
import {
  ACTION_AUTHORITY_BINDING_MODE,
  ACTION_DOMAIN,
  ACTION_EFFECT_CLASS,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  ACTION_PREVIEW_PROJECTOR_VERSION,
  ACTION_REVERSIBILITY_VALUE,
  ACTION_RISK,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "../../actions/public-action-contract.js";
import { PUBLIC_RECOVERY_ACTION } from "../../actions/public-error-contract.js";
import { CAPABILITY_SCOPE } from "../../core/capability-contract.js";
import { digestV1 } from "../../durability/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import { resolveAutomationGrantBinding } from "./automation-grant-authority.js";
import {
  actionPlanDigest,
  authorityChangeForAction,
  authoritySubjectForAction,
  expectedDomainHead,
  materializeActionPlan,
  materializeAuthorityEffectDigest,
  materializeAuthorityPlan,
  materializeEffectPlan,
} from "./contracts.js";
import { preparePolicyAuthorityChange } from "./policy.js";
import type { OrdinaryAuthorityDurableStoreV1 } from "./store.js";
import { prevalidateOrdinaryAuthorityTransition } from "./transition-prevalidation.js";
import type {
  AuthorityAutomationGrantProofV1,
  AuthorityChangeEffectPlanV1,
  OrdinaryAuthorityActionV1,
  OrdinaryAuthorityMutationOptionsV1,
  OrdinaryAuthorityRequestActionV1,
  PreparedOrdinaryAuthorityProposalV1,
  SecretRevocationCandidateV1,
} from "./types.js";
import { AUTHORITY_CHANGE_EFFECT_KIND } from "./types.js";

const PROPOSAL_WINDOW_MS = 60 * 60_000;

function fail(message: string, path = "authority.proposal"): never {
  throw new CapabilityValidationError(message, path, "integrity_failure");
}

function plus(timestamp: string, milliseconds: number): string {
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== timestamp)
    return fail("ordinary authority clock returned a non-canonical timestamp");
  return new Date(epoch + milliseconds).toISOString();
}

function requestScope(action: OrdinaryAuthorityRequestActionV1) {
  return action.type === HOST_ACTION_KIND.GRANT_CREATE ||
    action.type === HOST_ACTION_KIND.GRANT_RENEW
    ? action.grant.scope
    : action.scope;
}

function grantId(randomBytes: (size: number) => Uint8Array): string {
  const entropy = Buffer.from(randomBytes(32));
  if (entropy.byteLength !== 32) return fail("grant CSPRNG did not return exactly 256 bits");
  return `vf-grant-${entropy.toString("hex")}`;
}

function reversibility(action: OrdinaryAuthorityActionV1) {
  if (action.type === HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY)
    return ACTION_REVERSIBILITY_VALUE.COMPENSATABLE;
  if (
    action.type === HOST_ACTION_KIND.SECRET_REVOKE ||
    action.type === HOST_ACTION_KIND.GRANT_REVOKE
  )
    return ACTION_REVERSIBILITY_VALUE.IRREVERSIBLE;
  return ACTION_REVERSIBILITY_VALUE.MANUAL;
}

function journalEffect(input: {
  action: OrdinaryAuthorityActionV1;
  scope_identity_digest: string;
  subject: string;
}) {
  return materializeEffectPlan({
    schema_version: "1.0",
    scope: requestScope(input.action as OrdinaryAuthorityRequestActionV1),
    scope_identity_digest: input.scope_identity_digest,
    change: authorityChangeForAction(input.action),
    authority_subject_id: input.subject,
    effect_kind: AUTHORITY_CHANGE_EFFECT_KIND.JOURNAL_ONLY,
    expected_preimage_sha256: null,
    expected_preimage_byte_length: null,
    private_preimage_content_digest: null,
    replacement_sha256: null,
    replacement_byte_length: null,
    private_replacement_content_digest: null,
    private_preimage_ref: null,
    private_replacement_ref: null,
    inverse_descriptor_digest: null,
  });
}

function preview(input: {
  action: OrdinaryAuthorityActionV1;
  effectClass: typeof ACTION_EFFECT_CLASS.PROJECT_WRITE | typeof ACTION_EFFECT_CLASS.USER_WRITE;
  reversibility: ReturnType<typeof reversibility>;
  planDigest: string;
}) {
  const label = input.action.type.replaceAll(".", " ");
  return {
    title: `Review ${label}`,
    summary: "Apply one exact, audited capability-authority transition.",
    action_type: input.action.type,
    planning_options: {
      mode: ACTION_PLANNING_MODE.DURABLE,
      network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
    },
    review_fields: [],
    targets: [],
    target_dispositions: [],
    package_pins: [],
    permission_delta: [],
    dependency_delta: [],
    config_diffs: [],
    effect_classes: [input.effectClass],
    enforcement: [],
    reversibility: input.reversibility,
    health_plan: [],
    recovery_actions: [PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY],
    projector_version: ACTION_PREVIEW_PROJECTOR_VERSION,
    rules_digest: digestV1("VF-AUTHORITY-PREVIEW-RULES\0v1\0", input.planDigest),
    redaction_manifest_digest: digestV1("VF-AUTHORITY-PREVIEW-REDACTION\0v1\0", input.planDigest),
  };
}

function secretAction(
  request: Extract<
    OrdinaryAuthorityRequestActionV1,
    { type: typeof HOST_ACTION_KIND.SECRET_REVOKE }
  >,
  identity: string,
  authority: OrdinaryAuthorityMutationOptionsV1["secret_candidate_authority"],
  candidate: SecretRevocationCandidateV1 | null,
): { action: OrdinaryAuthorityActionV1; candidate: SecretRevocationCandidateV1 } {
  if (
    !candidate ||
    candidate.private_binding_id !== request.private_binding_id ||
    candidate.binding_digest !== request.expected_binding_digest ||
    candidate.scope !== request.scope ||
    candidate.scope_identity_digest !== identity
  )
    return fail("secret revocation request does not bind the retained candidate");
  if (!authority) return fail("secret candidate live authority is unavailable");
  authority.validateCurrent(candidate);
  return {
    candidate,
    action: {
      type: HOST_ACTION_KIND.SECRET_REVOKE,
      scope: request.scope,
      private_binding_ref: `actions/v1/secret-revocation-candidates/${candidate.private_binding_id}.json`,
      expected_binding_digest: candidate.binding_digest,
    },
  };
}

export class OrdinaryAuthorityProposalPlannerV1 {
  constructor(
    private readonly store: OrdinaryAuthorityDurableStoreV1,
    private readonly options: OrdinaryAuthorityMutationOptionsV1,
  ) {}

  prepare(input: {
    request_action: OrdinaryAuthorityRequestActionV1;
    request_authority: import("../../actions/index.js").ActionRequestAuthorityV1;
    idempotency_key: string;
    automation_grant_proof?: AuthorityAutomationGrantProofV1 | null;
    secret_candidate?: SecretRevocationCandidateV1 | null;
  }): PreparedOrdinaryAuthorityProposalV1 {
    validateHostActionRequest(input.request_action);
    const state = this.store.readCommitted();
    const current = state.current;
    const raw = this.store.readRaw();
    if (raw.current.content_digest !== current.content_digest)
      return fail("authority changed while preparing the proposal", "authority.stale");
    const scope = requestScope(input.request_action);
    if (scope !== this.options.paths.scope) return fail("authority request selected another scope");

    let action: OrdinaryAuthorityActionV1 = structuredClone(
      input.request_action,
    ) as OrdinaryAuthorityActionV1;
    let candidate: SecretRevocationCandidateV1 | null = null;
    let generatedGrantId: string | null = null;
    let policy: ReturnType<typeof preparePolicyAuthorityChange> | null = null;
    if (input.request_action.type === HOST_ACTION_KIND.GRANT_CREATE)
      generatedGrantId = grantId(this.options.random_bytes ?? systemRandomBytes);
    if (input.request_action.type === HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY) {
      policy = preparePolicyAuthorityChange({
        request: input.request_action,
        scope_identity_digest: current.scope_identity_digest,
        preimage_bytes: raw.settings,
      });
      action = policy.action;
    } else if (input.request_action.type === HOST_ACTION_KIND.SECRET_REVOKE) {
      const resolved = secretAction(
        input.request_action,
        current.scope_identity_digest,
        this.options.secret_candidate_authority,
        input.secret_candidate ?? null,
      );
      action = resolved.action;
      candidate = resolved.candidate;
    }

    prevalidateOrdinaryAuthorityTransition({
      state: raw,
      action,
      generated_grant_id: generatedGrantId,
    });
    const subject = authoritySubjectForAction(action, generatedGrantId, candidate);
    const change = authorityChangeForAction(action);
    const domainHead = expectedDomainHead(
      current,
      change,
      state.secrets.at(-1)?.frame_digest ?? null,
    );
    const effect: AuthorityChangeEffectPlanV1 =
      policy?.effect_plan ??
      journalEffect({ action, scope_identity_digest: current.scope_identity_digest, subject });
    const createdAt = this.options.now?.() ?? new Date().toISOString();
    const expiresAt = plus(createdAt, PROPOSAL_WINDOW_MS);
    const automationGrantBinding = resolveAutomationGrantBinding({
      store: this.store,
      scope,
      action_type: action.type,
      actor: input.request_authority.actor,
      proof: input.automation_grant_proof ?? null,
      now: createdAt,
    });
    const proposedEffect = materializeAuthorityEffectDigest({
      scope,
      scope_identity_digest: current.scope_identity_digest,
      change,
      authority_subject_id: subject,
      authority_action: action,
      expected_authority_epoch: current.authority_epoch,
      expected_authority_head_digest: current.content_digest,
      expected_domain_head_digest: domainHead,
    });
    const authorityPlan = materializeAuthorityPlan({
      schema_version: "1.0",
      scope,
      scope_identity_digest: current.scope_identity_digest,
      change,
      authority_subject_id: subject,
      authority_action: action,
      expected_authority_epoch: current.authority_epoch,
      expected_authority_head_digest: current.content_digest,
      expected_domain_head_digest: domainHead,
      automation_grant_binding: automationGrantBinding,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      proposed_effect_digest: proposedEffect,
      recovery_plan_digest: effect.plan_digest,
      created_at: createdAt,
      expires_at: expiresAt,
    });
    const effectClass =
      scope === CAPABILITY_SCOPE.PROJECT
        ? ACTION_EFFECT_CLASS.PROJECT_WRITE
        : ACTION_EFFECT_CLASS.USER_WRITE;
    const actionReversibility = reversibility(action);
    const actionPlan = materializeActionPlan({
      scope,
      scope_identity_digest: current.scope_identity_digest,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      native_plan_digest: authorityPlan.plan_digest,
      effect_class: effectClass,
      reversibility: actionReversibility,
    });
    const outerDigest = actionPlanDigest(actionPlan);
    const privateClosure = {
      effect,
      inverse: policy?.inverse ?? null,
      preimage_bytes: policy?.preimage_bytes ?? null,
      replacement_bytes: policy?.replacement_bytes ?? null,
      plan: authorityPlan,
      action_plan: actionPlan,
      action_plan_digest: outerDigest,
    };

    const locator = actionPlan.action_root_locator;
    if (input.request_authority.authority_scope_digest !== actionIdempotencyScopeDigest(locator))
      return fail("request authority does not own the selected capability action root");
    const canonicalRequest = {
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
      origin: "standalone" as const,
      principal_digest: input.request_authority.principal_digest,
      authority_scope_digest: input.request_authority.authority_scope_digest,
      scope,
      planning_options: actionPlan.planning_options,
      action: structuredClone(input.request_action),
    };
    const proposal = materializeProposal({
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
      idempotency_key: input.idempotency_key,
      origin_event_id: null,
      domain: ACTION_DOMAIN.CAPABILITY,
      action_root_locator: locator,
      producer_request_binding: {
        kind: ACTION_PRODUCER_REQUEST_BINDING_KIND.CANONICAL_ACTION_REQUEST,
        digest: canonicalActionRequestDigest(canonicalRequest),
      },
      planning_options: actionPlan.planning_options,
      execution_object_closure_digest: null,
      base: {
        root_session_id: null,
        conversation_id: null,
        revision_id: null,
        last_seq: null,
        conversation_lock_digest: null,
        lineage_head_digest: null,
        lineage_head_epoch: null,
        capability_scope: scope,
        capability_generation_ordinal: null,
        capability_generation_id: null,
        capability_lock_digest: null,
        capability_parent_generation_digests: [],
        user_prerequisites: [],
        authority_binding_mode: ACTION_AUTHORITY_BINDING_MODE.CURRENT,
        authority_epoch: current.authority_epoch,
        authority_head_digest: current.content_digest,
        repair_authorization_binding_digest: null,
      },
      action,
      requested_by: structuredClone(input.request_authority.actor),
      risk:
        actionReversibility === ACTION_REVERSIBILITY_VALUE.IRREVERSIBLE
          ? ACTION_RISK.CRITICAL
          : ACTION_RISK.HIGH,
      effect_classes: [effectClass],
      target_set: [],
      package_pins: [],
      source_authority_set_digest: EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
      adapter_set_digest: EMPTY_ADAPTER_SET_DIGEST,
      plan_digest: outerDigest,
      handoff_selection_digest: null,
      policy_digest: current.policy_digest,
      grant_digest: current.grant_digest,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      reversibility: actionReversibility,
      preview: preview({
        action,
        effectClass,
        reversibility: actionReversibility,
        planDigest: authorityPlan.plan_digest,
      }),
      created_at: createdAt,
      expires_at: expiresAt,
    });
    return {
      canonical_request: canonicalRequest,
      proposal,
      authority_plan: authorityPlan,
      effect_plan: effect,
      action_plan: actionPlan,
      private_closure: privateClosure,
    };
  }
}
