import type { Engine } from "../core/agent-contract.js";
import type { CapabilityScope } from "../core/capability-contract.js";
import type { HostActionKind } from "./host-action-contract.js";
import type { HostActionV1 } from "./internal-action-types.js";
import type { ActionApprovalChallengeState } from "./persistence-contract.js";
import type {
  ActionTargetBindingV1,
  HostRenderedPreviewV1,
  PackagePinV1,
} from "./preview-types.js";
import {
  type ACTION_AUTHORITY_EVENT_KIND,
  type ACTION_OPERATION_STATE,
  type ACTION_PRODUCER_REQUEST_BINDING_KIND,
  ACTION_ROOT_LOCATOR_KIND,
  type ActionOperationReviewDecisionState,
  type ActionOperationState,
} from "./protocol-contract.js";
import type {
  ACTION_EXPECTED_SOURCE_MODE,
  ActionApprovalChallengeClass,
  ActionAuthorityBindingMode,
  ActionDecision,
  ActionDomain,
  ActionEffectClass,
  ActionPlanningMode,
  ActionPlanningNetworkRead,
  ActionRisk,
  ActorKind,
  ChallengeClass,
  CredentialClass,
  PUBLIC_ACTION_SCHEMA_VERSION,
  Reversibility,
} from "./public-action-contract.js";
import type {
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
} from "./public-action-contract.js";
import type { RecoveryAction } from "./public-error-contract.js";
export type { ActionOperationState } from "./protocol-contract.js";
export type { HostActionKind } from "./host-action-contract.js";
export type { RecoveryAction } from "./public-error-contract.js";
export type { CapabilityScope } from "../core/capability-contract.js";
import type { BrowserHostActionRequestV1, HostActionRequestV1 } from "./request-types.js";

export type * from "./internal-action-types.js";
export type * from "./preview-types.js";
export type { BrowserHostActionRequestV1, HostActionRequestV1 } from "./request-types.js";
export type {
  ActionAuthorityBindingMode,
  ActionDecision,
  ActionDomain,
  ActionEffectClass,
  ActionPlanningMode,
  ActionPlanningNetworkRead,
  ActionRisk,
  ActorKind,
  ChallengeClass,
  CredentialClass,
  Reversibility,
} from "./public-action-contract.js";

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export interface PublicActor {
  kind: ActorKind;
  public_actor_id: string;
  credential_class: CredentialClass;
}

export interface ActionRequestAuthorityV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  principal_digest: string;
  authority_scope_digest: string;
  control_session_digest: string;
  csrf_epoch_digest: string;
  actor: PublicActor;
}

/** @deprecated Prefer the shared `Engine` contract for new code. */
export type EngineName = Engine;
export type ExpectedActionSourceV1 =
  | {
      mode: typeof ACTION_EXPECTED_SOURCE_MODE.WRITABLE_REVISION;
      conversation_id: string;
      revision_id: string;
      last_seq: number;
      conversation_lock_digest: string;
    }
  | {
      mode: typeof ACTION_EXPECTED_SOURCE_MODE.LINEAGE_RECOVERY;
      root_session_id: string;
      conversation_id: string;
      revision_id: string;
      last_seq: number;
      conversation_lock_digest: string;
      lineage_head_digest: string;
      lineage_head_epoch: number;
    };

export interface ActionProposalRequestV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  idempotency_key: string;
  anchor_event_id: string | null;
  expected: ExpectedActionSourceV1;
  candidate: BrowserHostActionRequestV1;
}

export type PrivateActionRootLocatorV1 =
  | { kind: typeof ACTION_ROOT_LOCATOR_KIND.CONVERSATION; root_session_id: string }
  | {
      kind: typeof ACTION_ROOT_LOCATOR_KIND.CAPABILITY;
      scope: CapabilityScope;
      scope_identity_digest: string;
    }
  | {
      kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP;
      bootstrap_identity_digest: string;
    };
export type NonRecoveryActionRootLocatorV1 = Exclude<
  PrivateActionRootLocatorV1,
  { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
>;

export function isNonRecoveryActionRootLocatorV1(
  locator: unknown,
): locator is NonRecoveryActionRootLocatorV1 {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) return false;
  const kind = (locator as { kind?: unknown }).kind;
  return (
    kind === ACTION_ROOT_LOCATOR_KIND.CONVERSATION || kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY
  );
}

export type ActionProposalProducerRequestBindingV1 =
  | {
      kind: typeof ACTION_PRODUCER_REQUEST_BINDING_KIND.CANONICAL_ACTION_REQUEST;
      digest: string;
    }
  | {
      kind: typeof ACTION_PRODUCER_REQUEST_BINDING_KIND.RECOVERY_BOOTSTRAP_REPAIR_PLAN;
      digest: string;
    };
export type ActionPlanningOptionsV1 =
  | {
      mode: Extract<ActionPlanningMode, typeof ACTION_PLANNING_MODE.DURABLE>;
      network_read: Extract<
        ActionPlanningNetworkRead,
        typeof ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY
      >;
    }
  | {
      mode: Extract<ActionPlanningMode, typeof ACTION_PLANNING_MODE.TRANSIENT>;
      network_read: Exclude<
        ActionPlanningNetworkRead,
        typeof ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY
      >;
    };
export interface ActionProposalBaseV1 {
  root_session_id: string | null;
  conversation_id: string | null;
  revision_id: string | null;
  last_seq: number | null;
  conversation_lock_digest: string | null;
  lineage_head_digest: string | null;
  lineage_head_epoch: number | null;
  capability_scope: CapabilityScope | null;
  capability_generation_ordinal: number | null;
  capability_generation_id: string | null;
  capability_lock_digest: string | null;
  capability_parent_generation_digests: string[];
  user_prerequisites: UserScopePrerequisiteBindingV1[];
  authority_binding_mode: ActionAuthorityBindingMode;
  authority_epoch: number;
  authority_head_digest: string;
  repair_authorization_binding_digest: string | null;
}
export interface UserScopePrerequisiteBindingV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  user_scope_identity_digest: string;
  package_id: string;
  version: string;
  content_sha256: string;
  user_generation_id: string;
  user_lock_digest: string;
  user_lock_entry_digest: string;
  user_authority_epoch: number;
  user_authority_head_digest: string;
  required_health_digest: string;
  checked_at: string;
  expires_at: string;
}
export interface ActionProposalDraftV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  idempotency_key: string;
  origin_event_id: string | null;
  domain: ActionDomain;
  action_root_locator: PrivateActionRootLocatorV1;
  producer_request_binding: ActionProposalProducerRequestBindingV1;
  planning_options: ActionPlanningOptionsV1;
  execution_object_closure_digest: string | null;
  base: ActionProposalBaseV1;
  action: HostActionV1;
  requested_by: PublicActor;
  risk: ActionRisk;
  effect_classes: ActionEffectClass[];
  target_set: ActionTargetBindingV1[];
  package_pins: PackagePinV1[];
  source_authority_set_digest: string;
  adapter_set_digest: string;
  plan_digest: string;
  handoff_selection_digest: string | null;
  policy_digest: string;
  grant_digest: string;
  permission_digest: string;
  reversibility: Reversibility;
  preview: HostRenderedPreviewV1;
  created_at: string;
  expires_at: string;
}
export interface ActionProposalV1 extends ActionProposalDraftV1 {
  proposal_id: string;
  proposal_digest: string;
}

export interface ActionApprovalV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  approval_id: string;
  proposal_id: string;
  proposal_digest: string;
  plan_digest: string;
  adapter_set_digest: string;
  target_set_digest: string;
  package_pin_set_digest: string;
  source_authority_set_digest: string;
  policy_digest: string;
  grant_digest: string;
  permission_digest: string;
  authority_epoch: number;
  authority_head_digest: string;
  reversibility: Reversibility;
  decided_by: PublicActor;
  credential_class: CredentialClass;
  challenge_class: ChallengeClass;
  challenge_digest: string | null;
  decision: ActionDecision;
  decided_at: string;
  expires_at: string;
  approval_digest: string;
}

export type ActionAuthorityPayloadV1 =
  | { kind: typeof ACTION_AUTHORITY_EVENT_KIND.PROPOSAL_CREATED; proposal: ActionProposalV1 }
  | {
      kind: typeof ACTION_AUTHORITY_EVENT_KIND.APPROVAL_DECISION;
      from: typeof ACTION_OPERATION_STATE.PENDING_REVIEW;
      to: ActionOperationReviewDecisionState;
      approval: ActionApprovalV1;
    }
  | {
      kind: typeof ACTION_AUTHORITY_EVENT_KIND.STATE_TRANSITION;
      from: ActionOperationState;
      to: ActionOperationState;
      operation_id: string | null;
      dispatch_record_digest: string | null;
      domain_terminal_digest: string | null;
      reason_code: string | null;
    };
export interface ActionAuthorityEventV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  proposal_id: string;
  sequence: number;
  previous_event_digest: string | null;
  payload: ActionAuthorityPayloadV1;
  recorded_at: string;
  event_digest: string;
}
export interface ActionAuthoritySnapshotV1 {
  proposal: ActionProposalV1;
  approval: ActionApprovalV1 | null;
  state: ActionOperationState;
  operation_id: string | null;
  dispatch_record_digest: string | null;
  domain_terminal_digest: string | null;
  events: ActionAuthorityEventV1[];
}

export interface ActionDispatchRecordV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  operation_id: string;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string;
  approval_digest: string;
  domain: ActionDomain;
  action_type: HostActionKind;
  action_root_locator: PrivateActionRootLocatorV1;
  execution_object_closure_digest: string | null;
  plan_digest: string;
  domain_header_digest: string | null;
  created_at: string;
  dispatch_record_digest: string;
}
export interface ApprovalChallengeFrameV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  challenge_id: string;
  sequence: number;
  previous_frame_digest: string | null;
  proposal_id: string;
  proposal_digest: string;
  challenge_class: ActionApprovalChallengeClass;
  principal_digest: string;
  control_session_digest: string;
  csrf_epoch_digest: string;
  response_hmac_sha256: string;
  state: ActionApprovalChallengeState;
  failed_attempts: number;
  approval_decided_by: PublicActor | null;
  approval_expires_at: string | null;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  frame_digest: string;
}
