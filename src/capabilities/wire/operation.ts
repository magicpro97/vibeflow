import type { ActionTargetBindingV1 } from "../../actions/preview-types.js";
import {
  ACTION_OPERATION_DISPATCH_REPLAY_STATES,
  type ActionOperationDispatchReplayState,
  PUBLIC_OPERATION_FIXED_PHASE,
  type PublicOperationFixedPhaseV1,
} from "../../actions/protocol-contract.js";
import type {
  PrivateActionRootLocatorV1,
  UserScopePrerequisiteBindingV1,
} from "../../actions/types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type {
  CAPABILITY_WAL_PAYLOAD_KIND,
  CapabilityAdapterReceiptStateV1,
  CapabilityHealthOutcomeV1,
  CapabilityPreEffectFrontierV1,
  CapabilityPreEffectObservedStateV1,
  CapabilityPreEffectRefusalReasonV1,
} from "./operation-state-contract.js";

export * from "./operation-state-contract.js";

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export interface CapabilityOperationV1 {
  schema_version: "1.0";
  operation_id: string;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string;
  approval_digest: string;
  scope: CapabilityScope;
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

export interface CapabilityPreEffectRefusalV1 {
  schema_version: "1.0";
  operation_id: string;
  frontier_kind: CapabilityPreEffectFrontierV1;
  plan_id: string | null;
  step_id: string | null;
  target_ids: string[];
  reason_code: CapabilityPreEffectRefusalReasonV1;
  binding_key: string;
  expected_digest: string | null;
  observed_digest: string | null;
  observed_state: CapabilityPreEffectObservedStateV1;
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
  state: CapabilityAdapterReceiptStateV1;
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

export const CAPABILITY_OUTBOX_PHASE = Object.freeze({
  OPERATION_STARTED: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_STARTED,
  TARGET_APPLIED: PUBLIC_OPERATION_FIXED_PHASE.TARGET_APPLIED,
  TARGET_OMITTED: PUBLIC_OPERATION_FIXED_PHASE.TARGET_OMITTED,
  TARGET_REVERSED: PUBLIC_OPERATION_FIXED_PHASE.TARGET_REVERSED,
  TARGET_DEGRADED: PUBLIC_OPERATION_FIXED_PHASE.TARGET_DEGRADED,
  TARGET_FAILED: PUBLIC_OPERATION_FIXED_PHASE.TARGET_FAILED,
  TARGET_BLOCKED: PUBLIC_OPERATION_FIXED_PHASE.TARGET_BLOCKED,
  TARGET_NEEDS_RECOVERY: PUBLIC_OPERATION_FIXED_PHASE.TARGET_NEEDS_RECOVERY,
  OPERATION_SUCCEEDED: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_SUCCEEDED,
  OPERATION_FAILED: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_FAILED,
  OPERATION_NEEDS_RECOVERY: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_NEEDS_RECOVERY,
} as const satisfies Readonly<Record<string, PublicOperationFixedPhaseV1>>);

export type CapabilityOutboxPhaseV1 =
  (typeof CAPABILITY_OUTBOX_PHASE)[keyof typeof CAPABILITY_OUTBOX_PHASE];

export const CAPABILITY_OUTBOX_PHASES = Object.freeze(Object.values(CAPABILITY_OUTBOX_PHASE));

export const CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN = Object.freeze({
  CREATED: "created",
} as const);

export type CapabilityWalOperationTransitionFromV1 =
  | (typeof CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN)[keyof typeof CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN]
  | ActionOperationDispatchReplayState;

export const CAPABILITY_WAL_OPERATION_TRANSITION_FROM_STATES = Object.freeze([
  ...Object.values(CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN),
  ...ACTION_OPERATION_DISPATCH_REPLAY_STATES,
] as const satisfies readonly CapabilityWalOperationTransitionFromV1[]);

export const CAPABILITY_OUTBOX_TRANSITION = Object.freeze({
  CREATED: "created",
  DELIVERED: "delivered",
  DELIVERY_FAILED: "delivery-failed",
} as const);

export type CapabilityOutboxTransitionV1 =
  (typeof CAPABILITY_OUTBOX_TRANSITION)[keyof typeof CAPABILITY_OUTBOX_TRANSITION];

export const CAPABILITY_OUTBOX_TRANSITIONS = Object.freeze(
  Object.values(CAPABILITY_OUTBOX_TRANSITION),
);

export const CAPABILITY_OUTBOX_DELIVERY = Object.freeze({
  PENDING: "pending",
  DELIVERED: "delivered",
  FAILED: "failed",
} as const);

export type CapabilityOutboxDeliveryV1 =
  (typeof CAPABILITY_OUTBOX_DELIVERY)[keyof typeof CAPABILITY_OUTBOX_DELIVERY];

export const CAPABILITY_OUTBOX_DELIVERIES = Object.freeze(
  Object.values(CAPABILITY_OUTBOX_DELIVERY),
);

export const CAPABILITY_OUTBOX_DELIVERY_BY_TRANSITION = Object.freeze({
  [CAPABILITY_OUTBOX_TRANSITION.CREATED]: CAPABILITY_OUTBOX_DELIVERY.PENDING,
  [CAPABILITY_OUTBOX_TRANSITION.DELIVERED]: CAPABILITY_OUTBOX_DELIVERY.DELIVERED,
  [CAPABILITY_OUTBOX_TRANSITION.DELIVERY_FAILED]: CAPABILITY_OUTBOX_DELIVERY.FAILED,
} satisfies Readonly<Record<CapabilityOutboxTransitionV1, CapabilityOutboxDeliveryV1>>);

export const isCapabilityOutboxPhase = (value: unknown): value is CapabilityOutboxPhaseV1 =>
  memberOf(CAPABILITY_OUTBOX_PHASES, value);

export const isCapabilityWalOperationTransitionFrom = (
  value: unknown,
): value is CapabilityWalOperationTransitionFromV1 =>
  memberOf(CAPABILITY_WAL_OPERATION_TRANSITION_FROM_STATES, value);

export const isCapabilityOutboxTransition = (
  value: unknown,
): value is CapabilityOutboxTransitionV1 => memberOf(CAPABILITY_OUTBOX_TRANSITIONS, value);

export const isCapabilityOutboxDelivery = (value: unknown): value is CapabilityOutboxDeliveryV1 =>
  memberOf(CAPABILITY_OUTBOX_DELIVERIES, value);

export type CapabilityWalPayloadV1 =
  | {
      kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.OPERATION_TRANSITION;
      from: CapabilityWalOperationTransitionFromV1;
      to: ActionOperationDispatchReplayState;
      reason_code: string | null;
    }
  | { kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.ADAPTER_STEP; receipt: AdapterReceiptV1 }
  | {
      kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.HEALTH;
      plan_id: string;
      observation_digest: string;
      target_id: string;
      probe_id: string;
      outcome: CapabilityHealthOutcomeV1;
      checked_at: string;
      expires_at: string;
      evidence_digest: string;
    }
  | {
      kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.PRE_EFFECT_REFUSAL;
      refusal: CapabilityPreEffectRefusalV1;
    }
  | {
      kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.LOCK_CHECKPOINT;
      prior_generation_id: string;
      prior_lock_digest: string;
      checkpoint_bytes_sha256: string;
      checkpoint_digest: string;
    }
  | {
      kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.HEALTH_INVENTORY_PREPARED;
      generation_id: string;
      lock_digest: string;
      health_inventory_digest: string;
      expected_health_pointer_digest: string | null;
      /** Present on newly prepared publications. Optional only so retained v1
       * WAL rows written before exact post-pointer binding remain readable. */
      expected_health_pointer_epoch?: number | null;
      next_health_pointer_epoch?: number;
      next_health_pointer_digest?: string;
    }
  | {
      kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.LOCK_COMMIT;
      generation_id: string;
      lock_digest: string;
      health_inventory_digest: string;
      expected_health_pointer_digest: string | null;
      /** Mirrors the exact post-pointer identity from the prepared row. */
      expected_health_pointer_epoch?: number | null;
      next_health_pointer_epoch?: number;
      next_health_pointer_digest?: string;
      directory_fsync_completed: true;
    }
  | {
      kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.OUTBOX;
      outbox_event_id: string;
      payload_ref: string;
      phase: CapabilityOutboxPhaseV1;
      phase_sequence: number;
      public_payload_digest: string;
      transition: CapabilityOutboxTransitionV1;
      delivery: CapabilityOutboxDeliveryV1;
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
