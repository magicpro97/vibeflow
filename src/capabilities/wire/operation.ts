import type { ActionTargetBindingV1 } from "../../actions/preview-types.js";
import type {
  ActionOperationState,
  PrivateActionRootLocatorV1,
  UserScopePrerequisiteBindingV1,
} from "../../actions/types.js";

export interface CapabilityOperationV1 {
  schema_version: "1.0";
  operation_id: string;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string;
  approval_digest: string;
  scope: "project" | "user";
  scope_identity_digest: string;
  action_root_locator: PrivateActionRootLocatorV1;
  execution_object_closure_digest: string;
  base_generation_id: string | null;
  base_lock_digest: string | null;
  parent_generation_digests: string[];
  plan_ids: string[];
  plan_digest: string;
  source_authority_set_digest: string;
  target_set: ActionTargetBindingV1[];
  conversation_correlation: ConversationActionCorrelationV1 | null;
  user_prerequisites: UserScopePrerequisiteBindingV1[];
  authority_epoch: number;
  authority_head_digest: string;
  policy_digest: string;
  grant_digest: string;
  permission_digest: string;
  created_at: string;
  header_digest: string;
}

export interface ConversationActionCorrelationV1 {
  schema_version: "1.0";
  correlation_id: string;
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  origin_event_id: string | null;
  proposal_id: string;
}

export type CapabilityPreEffectRefusalReasonV1 =
  | "scope-base-stale"
  | "authority-head-stale"
  | "policy-stale"
  | "grant-stale"
  | "permission-stale"
  | "user-prerequisite-stale"
  | "source-authority-stale"
  | "private-input-stale"
  | "enforcement-stale"
  | "owned-preimage-stale";

export interface CapabilityPreEffectRefusalV1 {
  schema_version: "1.0";
  operation_id: string;
  frontier_kind: "operation" | "adapter-step" | "health-batch" | "lock-publication";
  plan_id: string | null;
  step_id: string | null;
  target_ids: string[];
  reason_code: CapabilityPreEffectRefusalReasonV1;
  binding_key: string;
  expected_digest: string | null;
  observed_digest: string | null;
  observed_state:
    | "absent"
    | "changed"
    | "expired"
    | "revoked"
    | "epoch-drift"
    | "scope-mismatch"
    | "unavailable";
  checked_at: string;
  observation_digest: string;
}

export interface AdapterReceiptV1 {
  schema_version: "1.0";
  operation_id: string;
  plan_id: string;
  step_id: string;
  target_ids: string[];
  source_authority_binding_digest: string;
  private_input_binding_digest: string;
  attempt: 0;
  state:
    | "prepared"
    | "effect_in_progress"
    | "applied"
    | "reverse_in_progress"
    | "reversed"
    | "failed"
    | "uncertain";
  authority_epoch: number;
  authority_head_digest: string;
  policy_digest: string;
  grant_digest: string;
  permission_digest: string;
  observed_preimage_sha256: string | null;
  observed_postimage_sha256: string | null;
  private_evidence_ref: string | null;
  bounded_evidence_digest: string | null;
  native_identifier_producer_receipt_digests: string[];
  error_code: string | null;
  prepared_at: string;
  observed_at: string | null;
  receipt_digest: string;
}

export type CapabilityOutboxPhaseV1 =
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
  | "operation-needs-recovery";

export type CapabilityWalPayloadV1 =
  | {
      kind: "operation-transition";
      from: ActionOperationState | "created";
      to: ActionOperationState;
      reason_code: string | null;
    }
  | { kind: "adapter-step"; receipt: AdapterReceiptV1 }
  | {
      kind: "health";
      plan_id: string;
      observation_digest: string;
      target_id: string;
      probe_id: string;
      outcome: "ready" | "degraded" | "failed" | "unknown" | "stale";
      checked_at: string;
      expires_at: string;
      evidence_digest: string;
    }
  | { kind: "pre-effect-refusal"; refusal: CapabilityPreEffectRefusalV1 }
  | {
      kind: "lock-checkpoint";
      prior_generation_id: string;
      prior_lock_digest: string;
      checkpoint_bytes_sha256: string;
      checkpoint_digest: string;
    }
  | {
      kind: "health-inventory-prepared";
      generation_id: string;
      lock_digest: string;
      health_inventory_digest: string;
      expected_health_pointer_digest: string | null;
    }
  | {
      kind: "lock-commit";
      generation_id: string;
      lock_digest: string;
      health_inventory_digest: string;
      expected_health_pointer_digest: string | null;
      directory_fsync_completed: true;
    }
  | {
      kind: "outbox";
      outbox_event_id: string;
      payload_ref: string;
      phase: CapabilityOutboxPhaseV1;
      phase_sequence: number;
      public_payload_digest: string;
      transition: "created" | "delivered" | "delivery-failed";
      delivery: "pending" | "delivered" | "failed";
    };

export interface CapabilityWalEventV1 {
  schema_version: "1.0";
  operation_id: string;
  sequence: number;
  previous_event_digest: string | null;
  payload: CapabilityWalPayloadV1;
  recorded_at: string;
  event_digest: string;
}
