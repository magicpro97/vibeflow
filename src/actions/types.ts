import type { HostActionV1 } from "./internal-action-types.js";
import type {
  ActionTargetBindingV1,
  HostRenderedPreviewV1,
  PackagePinV1,
} from "./preview-types.js";
import type { BrowserHostActionRequestV1, HostActionRequestV1 } from "./request-types.js";

export type * from "./internal-action-types.js";
export type * from "./preview-types.js";
export type { BrowserHostActionRequestV1, HostActionRequestV1 } from "./request-types.js";

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type ActorKind = "human-browser" | "human-cli" | "agent" | "system-recovery";
export type CredentialClass =
  | "loopback-session"
  | "interactive-tty"
  | "automation-grant"
  | "recovery";
export interface PublicActor {
  kind: ActorKind;
  public_actor_id: string;
  credential_class: CredentialClass;
}

export interface ActionRequestAuthorityV1 {
  schema_version: "1.0";
  principal_digest: string;
  authority_scope_digest: string;
  control_session_digest: string;
  csrf_epoch_digest: string;
  actor: PublicActor;
}

export type CapabilityScope = "project" | "user";
export type EngineName = "claude" | "codex" | "copilot" | "opencode" | "antigravity";
export type HostActionKind =
  | "conversation.add_participant"
  | "conversation.remove_participant"
  | "conversation.update_participant"
  | "conversation.update_settings"
  | "conversation.continue_message"
  | "conversation.select_lineage_head"
  | "conversation.associate_lineages"
  | "conversation.publish_suspected_literal"
  | "conversation.stop_operation"
  | "conversation.abandon_revision_operation"
  | "conversation.retry_revision_operation"
  | "conversation.reconcile_revision_operation"
  | "context.compact"
  | "capability.install"
  | "capability.update"
  | "capability.configure"
  | "capability.retarget"
  | "capability.remove"
  | "capability.rollback_scope"
  | "capability.restore_package"
  | "capability.repair"
  | "capability.adopt"
  | "grant.create"
  | "grant.renew"
  | "grant.revoke"
  | "policy.update_authority"
  | "secret.revoke"
  | "registry.trust_key"
  | "authority.repair";

export type ExpectedActionSourceV1 =
  | {
      mode: "writable-revision";
      conversation_id: string;
      revision_id: string;
      last_seq: number;
      conversation_lock_digest: string;
    }
  | {
      mode: "lineage-recovery";
      root_session_id: string;
      conversation_id: string;
      revision_id: string;
      last_seq: number;
      conversation_lock_digest: string;
      lineage_head_digest: string;
      lineage_head_epoch: number;
    };

export interface ActionProposalRequestV1 {
  schema_version: "1.0";
  idempotency_key: string;
  anchor_event_id: string | null;
  expected: ExpectedActionSourceV1;
  candidate: BrowserHostActionRequestV1;
}

export type PrivateActionRootLocatorV1 =
  | { kind: "conversation"; root_session_id: string }
  | { kind: "capability"; scope: CapabilityScope; scope_identity_digest: string }
  | { kind: "recovery-bootstrap"; bootstrap_identity_digest: string };
export type ActionProposalProducerRequestBindingV1 =
  | { kind: "canonical-action-request"; digest: string }
  | { kind: "recovery-bootstrap-repair-plan"; digest: string };
export type ActionPlanningOptionsV1 =
  | { mode: "durable"; network_read: "ordinary-host-policy" }
  | { mode: "transient"; network_read: "forbid" | "allow-if-granted" };
export type ActionRisk = "low" | "medium" | "high" | "critical";
export type ActionEffectClass =
  | "pure-local-read"
  | "local-read-with-cache"
  | "network-read"
  | "process-probe"
  | "project-write"
  | "user-write"
  | "external-compensatable"
  | "external-irreversible";
export type Reversibility = "reversible" | "compensatable" | "manual" | "irreversible";
export type RecoveryAction =
  | "retry"
  | "edit"
  | "refresh-proposal"
  | "restart-pagination"
  | "complete-challenge"
  | "select-lineage-head"
  | "rebuild-catalog"
  | "resume-by-id"
  | "inspect-trace"
  | "resolve-again"
  | "rollback"
  | "repair"
  | "repair-authority"
  | "verified-abandon"
  | "reconcile-revision"
  | "adopt"
  | "renew-grant"
  | "authorize-source"
  | "disable"
  | "retarget"
  | "complete-manual-step"
  | "export-redacted-diagnostics";

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
  authority_binding_mode: "current" | "recovery-checkpoint";
  authority_epoch: number;
  authority_head_digest: string;
  repair_authorization_binding_digest: string | null;
}
export interface UserScopePrerequisiteBindingV1 {
  schema_version: "1.0";
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
  schema_version: "1.0";
  idempotency_key: string;
  origin_event_id: string | null;
  domain: "conversation" | "capability";
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

export type ChallengeClass =
  | "normal-confirm"
  | "fresh-user-scope"
  | "public-literal"
  | "automation-grant"
  | "recovery-tty";
export interface ActionApprovalV1 {
  schema_version: "1.0";
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
  decision: "approved" | "denied";
  decided_at: string;
  expires_at: string;
  approval_digest: string;
}

export type ActionOperationState =
  | "pending_review"
  | "approved"
  | "committing"
  | "succeeded"
  | "failed"
  | "denied"
  | "canceled"
  | "expired"
  | "stale"
  | "needs_recovery";
export type ActionAuthorityPayloadV1 =
  | { kind: "proposal-created"; proposal: ActionProposalV1 }
  | {
      kind: "approval-decision";
      from: "pending_review";
      to: "approved" | "denied";
      approval: ActionApprovalV1;
    }
  | {
      kind: "state-transition";
      from: ActionOperationState;
      to: ActionOperationState;
      operation_id: string | null;
      dispatch_record_digest: string | null;
      domain_terminal_digest: string | null;
      reason_code: string | null;
    };
export interface ActionAuthorityEventV1 {
  schema_version: "1.0";
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
  schema_version: "1.0";
  operation_id: string;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string;
  approval_digest: string;
  domain: "conversation" | "capability";
  action_type: HostActionKind;
  action_root_locator: PrivateActionRootLocatorV1;
  execution_object_closure_digest: string | null;
  plan_digest: string;
  domain_header_digest: string | null;
  created_at: string;
  dispatch_record_digest: string;
}
export interface ApprovalChallengeFrameV1 {
  schema_version: "1.0";
  challenge_id: string;
  sequence: number;
  previous_frame_digest: string | null;
  proposal_id: string;
  proposal_digest: string;
  challenge_class: "fresh-user-scope" | "public-literal";
  principal_digest: string;
  control_session_digest: string;
  csrf_epoch_digest: string;
  response_hmac_sha256: string;
  state: "created" | "failed-attempt" | "consumed" | "expired" | "locked";
  failed_attempts: number;
  approval_decided_by: PublicActor | null;
  approval_expires_at: string | null;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  frame_digest: string;
}
