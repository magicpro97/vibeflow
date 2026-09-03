import type { PublicTargetResultV1 } from "../../actions/public-types.js";
import type { PrivateActionRootLocatorV1 } from "../../actions/types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type { CapabilityEffectBrokerV1 } from "../adapters/types.js";
import type { CapabilityFabricPlanV1, CapabilityRuntimeAuthorityV1 } from "../planning/types.js";
import type { CapabilityDurablePlanningGraphV1 } from "../planning/types.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type {
  CapabilityOperationRecoveryActionV1,
  CapabilityOperationStatusV1,
  CapabilityOperationV1,
  CapabilityWalEventV1,
} from "../wire/operation.js";

export interface CapabilityExecutionAuthorizationV1 {
  schema_version: "1.0";
  proposal_id: string;
  proposal_digest: string;
  approval_id: string;
  approval_digest: string;
  operation_id?: string;
  created_at?: string;
  action_root_locator?: PrivateActionRootLocatorV1;
  conversation_correlation?: CapabilityOperationV1["conversation_correlation"];
}

export interface CapabilityExecutionRequestV1 {
  graph: CapabilityDurablePlanningGraphV1;
  authorization: CapabilityExecutionAuthorizationV1;
}

export interface CapabilityPreparedOperationV1 {
  schema_version: "1.0";
  operation_id: string;
  header_digest: string;
  prepared_at: string;
  header: CapabilityOperationV1;
}

export interface CapabilityOperationResultV1 {
  schema_version: "1.0";
  operation_id: string;
  proposal_id: string;
  plan_digest: string;
  status: CapabilityOperationStatusV1;
  changed: boolean;
  generation_id: string | null;
  targets: PublicTargetResultV1[];
  reason_code: string | null;
  recovery_actions: CapabilityOperationRecoveryActionV1[];
  latest_sequence: number;
}

export interface CapabilityOperationReadRequestV1 {
  operation_id: string;
  after_sequence?: number;
  limit?: number;
}

export interface CapabilityOperationReadV1 extends CapabilityOperationResultV1 {
  events: CapabilityWalEventV1[];
  next_cursor: string | null;
}

export interface CapabilityRuntimeAuthorityReaderV1 {
  read(scope: CapabilityScope): CapabilityRuntimeAuthorityV1;
  /** Reconstructs the exact current permission authority for the immutable
   * typed execution graph. This is evaluated again inside every frontier. */
  readPermissionAuthority(graph: CapabilityDurablePlanningGraphV1, checkedAt: string): string;
  /** Holds the fixed authority writer lock through the callback. Mutation
   * effects and their terminal receipts must execute inside this frontier.
   * The frontier timestamp is sampled after acquiring the lock and before
   * reading any durable authority row. */
  criticalSection<T>(
    scope: CapabilityScope,
    operation: string,
    now: () => string,
    callback: (authority: CapabilityRuntimeAuthorityV1, checkedAt: string) => T,
  ): T;
}

export interface CapabilityRuntimeSourceAuthorityReaderV1 {
  readSourceAuthoritySet(graph: CapabilityDurablePlanningGraphV1, checkedAt: string): string;
}

/** Resolves the exact durable proposal, approval, and dispatch named by an operation header. */
export interface CapabilityOperationActionAuthorityV1 {
  resolvePlanningGraph(header: CapabilityOperationV1): CapabilityDurablePlanningGraphV1;
  verifyPrepared(header: CapabilityOperationV1, plan: CapabilityFabricPlanV1): void;
  verifyDispatched(header: CapabilityOperationV1, plan: CapabilityFabricPlanV1): void;
  verifyReadable(header: CapabilityOperationV1, plan: CapabilityFabricPlanV1): void;
}

export type CapabilityRuntimeFaultPointV1 =
  | "after-header"
  | "after-prepared"
  | "after-effect-in-progress"
  | "after-effect-before-receipt"
  | "after-applied"
  | "after-health-observation"
  | "after-health-row"
  | "after-refusal-observation"
  | "after-refusal"
  | "before-publication-base-validation"
  | "after-lock-checkpoint-materialized"
  | "after-lock-checkpoint"
  | "after-health-inventory-prepared"
  | "after-lock-publish"
  | "after-lock-commit";

export type CapabilityOperationObserverV1 = (event: CapabilityWalEventV1) => void;

export interface CapabilityOperationExecutorOptionsV1 {
  storage: CapabilityStorageV1;
  authority: CapabilityRuntimeAuthorityReaderV1;
  sourceAuthority?: CapabilityRuntimeSourceAuthorityReaderV1;
  actionAuthority?: CapabilityOperationActionAuthorityV1;
  broker: CapabilityEffectBrokerV1;
  now: () => string;
  emit?: CapabilityOperationObserverV1;
}
