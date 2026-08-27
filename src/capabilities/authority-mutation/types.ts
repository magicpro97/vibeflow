import type {
  CAPABILITY_AUTHORITY_CHANGE,
  CapabilityAuthorityChange,
} from "../../actions/capability-security-contract.js";
import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type {
  ActionApprovalV1,
  ActionAuthorityResolverV1,
  ActionProposalV1,
  ActionRequestAuthorityV1,
  CanonicalActionRequestV1,
  DurableActionAuthorityReaderV1,
  HostActionRequestV1,
  HostActionV1,
  PublicActor,
} from "../../actions/index.js";
import type {
  ACTION_OPERATION_STATE,
  ACTION_ROOT_LOCATOR_KIND,
} from "../../actions/protocol-contract.js";
import type {
  ACTION_DOMAIN,
  ACTION_EFFECT_CLASS,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  ACTION_REVERSIBILITY_VALUE,
} from "../../actions/public-action-contract.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityTransitionEvidenceV1,
} from "../authority/index.js";
import type { DurableAuthorityTransitionResolverV1 } from "../source/durable-authority-transition-resolver.js";
import type { CapabilityStorePathsV1 } from "../storage/paths.js";

export const ORDINARY_AUTHORITY_ACTION_KIND = Object.freeze({
  GRANT_CREATE: HOST_ACTION_KIND.GRANT_CREATE,
  GRANT_RENEW: HOST_ACTION_KIND.GRANT_RENEW,
  GRANT_REVOKE: HOST_ACTION_KIND.GRANT_REVOKE,
  POLICY_UPDATE_AUTHORITY: HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
  SECRET_REVOKE: HOST_ACTION_KIND.SECRET_REVOKE,
  REGISTRY_TRUST_KEY: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
} as const satisfies Readonly<
  Record<string, (typeof HOST_ACTION_KIND)[keyof typeof HOST_ACTION_KIND]>
>);

export const ORDINARY_AUTHORITY_ACTION_KINDS = Object.freeze(
  Object.values(ORDINARY_AUTHORITY_ACTION_KIND),
);

export type OrdinaryAuthorityActionKindV1 =
  (typeof ORDINARY_AUTHORITY_ACTION_KIND)[keyof typeof ORDINARY_AUTHORITY_ACTION_KIND];

export type OrdinaryAuthorityRequestActionV1 = Extract<
  HostActionRequestV1,
  { type: OrdinaryAuthorityActionKindV1 }
>;

export type OrdinaryAuthorityActionV1 = Extract<
  HostActionV1,
  { type: OrdinaryAuthorityActionKindV1 }
>;

export interface AuthorityAutomationGrantProofV1 {
  schema_version: "1.0";
  scope: CapabilityScope;
  public_actor_id: string;
  grant_id: string;
  grant_frame_digest: string;
  authority_epoch: number;
  authority_head_digest: string;
}

export interface AuthorityAutomationGrantBindingV1 extends AuthorityAutomationGrantProofV1 {
  scope_identity_digest: string;
  action_type: OrdinaryAuthorityActionKindV1;
  not_before: string;
  expires_at: string;
  binding_digest: string;
}

export const AUTHORITY_CHANGE_EFFECT_KIND = Object.freeze({
  JOURNAL_ONLY: "journal-only",
  SETTINGS_REPLACEMENT: "settings-replacement",
} as const);
export type AuthorityChangeEffectKindV1 =
  (typeof AUTHORITY_CHANGE_EFFECT_KIND)[keyof typeof AUTHORITY_CHANGE_EFFECT_KIND];

export const AUTHORITY_CHANGE_TERMINAL_OUTCOME = Object.freeze({
  FAILED: "failed",
  NEEDS_RECOVERY: "needs_recovery",
} as const);
export type AuthorityChangeTerminalOutcomeV1 =
  (typeof AUTHORITY_CHANGE_TERMINAL_OUTCOME)[keyof typeof AUTHORITY_CHANGE_TERMINAL_OUTCOME];

export const AUTHORITY_CHANGE_TERMINAL_REASON = Object.freeze({
  AUTHORITY_STALE: "authority-stale",
  PRE_EFFECT_REVALIDATION_FAILED: "pre-effect-revalidation-failed",
  PARTIAL_STATE_UNPROVEN: "partial-state-unproven",
} as const);
export type AuthorityChangeTerminalReasonV1 =
  (typeof AUTHORITY_CHANGE_TERMINAL_REASON)[keyof typeof AUTHORITY_CHANGE_TERMINAL_REASON];

export interface AuthorityChangeEffectPlanV1 {
  schema_version: "1.0";
  scope: CapabilityScope;
  scope_identity_digest: string;
  change: Exclude<CapabilityAuthorityChange, typeof CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED>;
  authority_subject_id: string;
  effect_kind: AuthorityChangeEffectKindV1;
  expected_preimage_sha256: string | null;
  expected_preimage_byte_length: number | null;
  private_preimage_content_digest: string | null;
  replacement_sha256: string | null;
  replacement_byte_length: number | null;
  private_replacement_content_digest: string | null;
  private_preimage_ref: string | null;
  private_replacement_ref: string | null;
  inverse_descriptor_digest: string | null;
  plan_digest: string;
}

export interface PolicyAuthorityInverseDescriptorV1 {
  schema_version: "1.0";
  scope: CapabilityScope;
  scope_identity_digest: string;
  settings_schema_version: string;
  expected_current_sha256: string;
  expected_current_policy_digest: string;
  restore_sha256: string;
  restore_byte_length: number;
  restore_content_digest: string;
  restore_policy_digest: string;
  private_restore_ref: string;
  descriptor_digest: string;
}

export interface AuthorityChangePlanV1 {
  schema_version: "1.0";
  scope: CapabilityScope;
  scope_identity_digest: string;
  change: Exclude<CapabilityAuthorityChange, typeof CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED>;
  authority_subject_id: string;
  authority_action: OrdinaryAuthorityActionV1;
  expected_authority_epoch: number;
  expected_authority_head_digest: string;
  expected_domain_head_digest: string | null;
  automation_grant_binding: AuthorityAutomationGrantBindingV1 | null;
  permission_digest: string;
  proposed_effect_digest: string;
  recovery_plan_digest: string;
  created_at: string;
  expires_at: string;
  plan_digest: string;
}

export interface AuthorityActionPlanBindingV1 {
  schema_version: "1.0";
  domain: typeof ACTION_DOMAIN.CAPABILITY;
  action_root_locator: {
    kind: typeof ACTION_ROOT_LOCATOR_KIND.CAPABILITY;
    scope: CapabilityScope;
    scope_identity_digest: string;
  };
  planning_options: {
    mode: typeof ACTION_PLANNING_MODE.DURABLE;
    network_read: typeof ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY;
  };
  execution_object_closure_digest: null;
  permission_digest: string;
  steps: [
    {
      order: 0;
      step_id: string;
      plan_kind: "authority-change";
      plan_digest: string;
      target_ids: [];
      effect_classes: Array<
        typeof ACTION_EFFECT_CLASS.PROJECT_WRITE | typeof ACTION_EFFECT_CLASS.USER_WRITE
      >;
      reversibility:
        | typeof ACTION_REVERSIBILITY_VALUE.REVERSIBLE
        | typeof ACTION_REVERSIBILITY_VALUE.COMPENSATABLE
        | typeof ACTION_REVERSIBILITY_VALUE.MANUAL
        | typeof ACTION_REVERSIBILITY_VALUE.IRREVERSIBLE;
    },
  ];
}

export interface AuthorityChangeOperationV1 {
  schema_version: "1.0";
  operation_id: string;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string;
  approval_digest: string;
  action_type: OrdinaryAuthorityActionKindV1;
  action_root_locator: AuthorityActionPlanBindingV1["action_root_locator"];
  action_plan_binding_digest: string;
  authority_change_plan_digest: string;
  scope: CapabilityScope;
  scope_identity_digest: string;
  change: Exclude<CapabilityAuthorityChange, typeof CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED>;
  authority_subject_id: string;
  expected_authority_epoch: number;
  expected_authority_head_digest: string;
  expected_domain_head_digest: string | null;
  proposed_effect_digest: string;
  recovery_plan_digest: string;
  permission_digest: string;
  created_at: string;
  header_digest: string;
}

export interface AuthorityChangeTerminalReceiptV1 {
  schema_version: "1.0";
  operation_id: string;
  sequence: number;
  previous_receipt_digest: string | null;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string;
  approval_digest: string;
  plan_digest: string;
  action_root_locator: AuthorityActionPlanBindingV1["action_root_locator"];
  operation_header_digest: string;
  scope: CapabilityScope;
  scope_identity_digest: string;
  change: Exclude<CapabilityAuthorityChange, typeof CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED>;
  expected_authority_head_digest: string;
  observed_authority_head_digest: string;
  outcome: AuthorityChangeTerminalOutcomeV1;
  reason_code: AuthorityChangeTerminalReasonV1;
  recorded_at: string;
  receipt_digest: string;
}

export interface SecretRevocationCandidateV1 {
  schema_version: "1.0";
  private_binding_id: string;
  scope: CapabilityScope;
  scope_identity_digest: string;
  package_id: string;
  input_id: string;
  secret_handle_id_digest: string;
  broker_binding_epoch: number;
  broker_scope_digest: string;
  source_current_head_digest: string;
  source_action_root_locator: Exclude<
    import("../../actions/index.js").PrivateActionRootLocatorV1,
    { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
  >;
  source_private_input_binding_digest: string;
  created_at: string;
  binding_digest: string;
}

export interface PreparedOrdinaryAuthorityProposalV1 {
  canonical_request: CanonicalActionRequestV1;
  proposal: ActionProposalV1;
  authority_plan: AuthorityChangePlanV1;
  effect_plan: AuthorityChangeEffectPlanV1;
  action_plan: AuthorityActionPlanBindingV1;
  private_closure: AuthorityActionClosureWriteV1;
}

export interface AuthorityActionClosureWriteV1 {
  effect: AuthorityChangeEffectPlanV1;
  inverse: PolicyAuthorityInverseDescriptorV1 | null;
  preimage_bytes: Uint8Array | null;
  replacement_bytes: Uint8Array | null;
  plan: AuthorityChangePlanV1;
  action_plan: AuthorityActionPlanBindingV1;
  action_plan_digest: string;
}

export interface OrdinaryAuthorityTerminalEvidenceV1 {
  operation_id: string;
  outcome: typeof ACTION_OPERATION_STATE.SUCCEEDED | AuthorityChangeTerminalOutcomeV1;
  domain_terminal_digest: string;
  recorded_at: string;
  authority_head: AuthorityEpochHeadV1 | null;
  event: AuthorityEpochEventV1 | null;
  receipt: AuthorityChangeTerminalReceiptV1 | null;
}

export const ORDINARY_AUTHORITY_MUTATION_FAULT_POINT = Object.freeze({
  AFTER_OPERATION_HEADER: "after-operation-header",
  BEFORE_RECOVERY_PREFIX_READ: "before-recovery-prefix-read",
  BEFORE_ACTION_CLOSURE_READ: "before-action-closure-read",
  BEFORE_PRE_EFFECT_REVALIDATION: "before-pre-effect-revalidation",
  AFTER_DOMAIN_FRAME: "after-domain-frame",
  AFTER_POLICY_EFFECT_IN_PROGRESS: "after-policy-effect-in-progress",
  AFTER_POLICY_SETTINGS_CAS: "after-policy-settings-cas",
  AFTER_POLICY_OBSERVED: "after-policy-observed",
  AFTER_EPOCH_EVENT: "after-epoch-event",
  AFTER_EPOCH_HEAD: "after-epoch-head",
} as const);
export type OrdinaryAuthorityMutationFaultPointV1 =
  (typeof ORDINARY_AUTHORITY_MUTATION_FAULT_POINT)[keyof typeof ORDINARY_AUTHORITY_MUTATION_FAULT_POINT];

export interface SecretRevocationCandidateAuthorityV1 {
  validateCurrent(candidate: SecretRevocationCandidateV1): void;
  persist?(candidate: SecretRevocationCandidateV1): void;
}

export interface OrdinaryAuthorityMutationOptionsV1 {
  paths: CapabilityStorePathsV1;
  authority_transition_resolver: DurableAuthorityTransitionResolverV1;
  /** Deferred because the ActionAuthorityStore is constructed with this domain's resolver. */
  action_authority: () => DurableActionAuthorityReaderV1;
  now?: () => string;
  random_bytes?: (size: number) => Uint8Array;
  secret_candidate_authority?: SecretRevocationCandidateAuthorityV1;
  fault?: (point: OrdinaryAuthorityMutationFaultPointV1) => void;
}

export interface OrdinaryAuthorityMutationDomainV1 {
  readonly resolver: ActionAuthorityResolverV1;
  prepareProposal(input: {
    request_action: OrdinaryAuthorityRequestActionV1;
    request_authority: ActionRequestAuthorityV1;
    idempotency_key: string;
    automation_grant_proof?: AuthorityAutomationGrantProofV1 | null;
    secret_candidate?: SecretRevocationCandidateV1 | null;
  }): PreparedOrdinaryAuthorityProposalV1;
  prepareApproved(
    proposal: ActionProposalV1,
    approval: ActionApprovalV1,
  ): AuthorityChangeOperationV1;
  execute(operationId: string): OrdinaryAuthorityTerminalEvidenceV1;
  readTerminal(operationId: string): OrdinaryAuthorityTerminalEvidenceV1 | null;
}

export interface OrdinaryAuthorityCommittedTransitionV1 {
  prior: AuthorityEpochHeadV1;
  event: AuthorityEpochEventV1;
  evidence: Exclude<
    AuthorityTransitionEvidenceV1,
    { change: typeof CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED }
  >;
  next: AuthorityEpochHeadV1;
}

export interface OrdinaryAuthorityOperationBindingV1 {
  proposal: ActionProposalV1;
  approval: ActionApprovalV1;
  header: AuthorityChangeOperationV1;
  plan: AuthorityChangePlanV1;
  effect: AuthorityChangeEffectPlanV1;
  actor: PublicActor;
}
