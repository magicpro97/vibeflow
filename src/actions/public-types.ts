import type { PublicApiErrorV1 } from "./errors.js";
import type {
  ActionTargetBindingV1,
  ActionTargetV1,
  HostRenderedPreviewV1,
  PublicPackagePinV1,
} from "./preview-types.js";
import type {
  ActionEffectClass,
  ActionOperationState,
  ActionRisk,
  ChallengeClass,
  HostActionKind,
  PublicActor,
  RecoveryAction,
  Reversibility,
} from "./types.js";

export type PublicOperationPhaseV1 =
  | "dispatch"
  | "operation-started"
  | "target-applied"
  | "target-omitted"
  | "target-reversed"
  | "target-degraded"
  | "target-failed"
  | "target-blocked"
  | "target-needs-recovery"
  | "operation-succeeded"
  | "operation-failed"
  | "operation-needs-recovery"
  | `revision:${"preparing" | "prepared" | "published" | "starting" | "started" | "abandoned" | "start_failed" | "needs_recovery"}`
  | `participant-start:${"prepared" | "effect_in_progress" | "observed" | "accepted" | "cancel_in_progress" | "canceled" | "failed" | "uncertain"}`
  | `authority-change:${"prepared" | "effect_in_progress" | "observed" | "epoch-committed" | "failed" | "needs-recovery"}`
  | `authority-repair:${"prepared" | "preimage_fsynced" | "restore_in_progress" | "restored" | "verified" | "failed" | "needs_recovery"}`
  | `conversation-receipt:${"succeeded" | "failed" | "needs_recovery"}`
  | "lineage-head:committed"
  | "lineage-association:committed"
  | "context-compaction:committed"
  | "public-literal:published";

export interface PublicOperationProgressV1 {
  sequence: number;
  phase: PublicOperationPhaseV1;
  status: "pending" | "running" | "succeeded" | "failed" | "reversed";
  message_code: `operation.${PublicOperationPhaseV1}`;
  at: string;
}
export interface PublicTargetResultV1 {
  target_id: string;
  target: ActionTargetV1;
  subject: ActionTargetBindingV1["subject"];
  outcome:
    | "applied"
    | "failed"
    | "manual"
    | "required-user-action"
    | "unsupported"
    | "omitted"
    | "reversed"
    | "degraded"
    | "blocked"
    | "needs-recovery";
  health: "ready" | "degraded" | "unknown" | "stale" | "failed";
  evidence_digest: string | null;
}
export interface PublicActionProposalViewV1 {
  schema_version: "1.0";
  proposal_id: string;
  proposal_digest: string;
  origin_event_id: string | null;
  action_type: HostActionKind;
  domain: "conversation" | "capability";
  scope: "conversation" | "project" | "user";
  authority_binding_mode: "current" | "recovery-checkpoint";
  risk: ActionRisk;
  effect_classes: ActionEffectClass[];
  targets: ActionTargetBindingV1[];
  package_pins: PublicPackagePinV1[];
  adapter_set_digest: string;
  plan_digest: string;
  policy_digest: string;
  permission_digest: string;
  reversibility: Reversibility;
  preview: HostRenderedPreviewV1;
  created_at: string;
  expires_at: string;
}
export interface PublicActionApprovalViewV1 {
  schema_version: "1.0";
  approval_id: string;
  approval_digest: string;
  proposal_id: string;
  proposal_digest: string;
  decision: "approved" | "denied";
  challenge_class: ChallengeClass;
  decided_by: PublicActor;
  decided_at: string;
  expires_at: string;
}
export interface ActionOperationViewV1 {
  schema_version: "1.0";
  operation_id: string | null;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string | null;
  approval_digest: string | null;
  correlation_id: string;
  domain: "conversation" | "capability";
  state: ActionOperationState;
  phase_sequence: number | null;
  latest_event_cursor: string | null;
  progress: PublicOperationProgressV1[];
  targets: PublicTargetResultV1[];
  delivery: "not-applicable" | "pending" | "delivered" | "failed";
  result_ref: string | null;
  error: PublicApiErrorV1["error"] | null;
  recovery_actions: RecoveryAction[];
  created_at: string;
  updated_at: string;
}
export interface ActionProposalResponseV1 {
  schema_version: "1.0";
  proposal: PublicActionProposalViewV1;
  approval: PublicActionApprovalViewV1 | null;
  operation: ActionOperationViewV1;
}
export interface ActionApprovalChallengeRequestV1 {
  schema_version: "1.0";
  proposal_digest: string;
  challenge_class: "fresh-user-scope" | "public-literal";
}
export interface ActionApprovalChallengeResponseV1 {
  schema_version: "1.0";
  challenge_id: string;
  challenge_class: "fresh-user-scope" | "public-literal";
  display_phrase: string;
  expires_at: string;
}
export interface ActionApprovalRequestV1 {
  schema_version: "1.0";
  proposal_digest: string;
  decision: "approved" | "denied";
  challenge_id: string | null;
  challenge_response: string | null;
}
export interface ActionCommitRequestV1 {
  schema_version: "1.0";
  proposal_digest: string;
  approval_id: string;
}
export interface ActionCancelRequestV1 {
  schema_version: "1.0";
  proposal_digest: string;
  reason: string | null;
}
export interface PendingActionProposalListResponseV1 {
  schema_version: "1.0";
  items: ActionProposalResponseV1[];
  next_cursor: string | null;
  authority_watermark: string;
}
export interface ActionApprovalResponseV1 {
  schema_version: "1.0";
  approval: PublicActionApprovalViewV1;
  operation: ActionOperationViewV1;
}
export interface ActionMutationResponseV1 {
  schema_version: "1.0";
  operation: ActionOperationViewV1;
}
export interface ActionOperationEventV1 {
  schema_version: "1.0";
  operation_id: string;
  phase_sequence: number;
  state: ActionOperationState;
  progress: PublicOperationProgressV1 | null;
  target: PublicTargetResultV1 | null;
  error: PublicApiErrorV1["error"] | null;
  occurred_at: string;
  event_cursor: string;
}
export interface ActionOperationEventsResponseV1 {
  schema_version: "1.0";
  items: ActionOperationEventV1[];
  next_cursor: string | null;
}
export interface ActionDomainTerminalReceiptV1 {
  schema_version: "1.0";
  operation_id: string;
  proposal_id: string;
  proposal_digest: string;
  dispatch_record_digest: string;
  outcome: "succeeded" | "failed" | "needs_recovery";
  reason_code: string | null;
  recorded_at: string;
  receipt_digest: string;
}
