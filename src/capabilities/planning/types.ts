import type { CapabilityHostActionKind } from "../../actions/host-action-contract.js";
import type { StrictLegacyAdoptCandidateV1 } from "../../actions/legacy-adopt-types.js";
import type {
  ActionTargetBindingV1,
  CapabilityTargetDispositionV1,
  PublicHealthPlanV1,
} from "../../actions/preview-types.js";
import type { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import type {
  ActionEffectClass,
  CapabilityScope,
  EngineName,
  HostActionV1,
  Reversibility,
  UserScopePrerequisiteBindingV1,
} from "../../actions/types.js";
import type { CapabilityPlanStatusV1 } from "../../core/capability-contract.js";
import type {
  CapabilityAdapterIdentityV1,
  CapabilityAdapterRegistryV1,
  CapabilityEffectDescriptorV1,
  CapabilityOwnedResourceV1,
} from "../adapters/types.js";
import type { CapabilityManifestV1 } from "../manifest/types.js";
import type { PermissionBindingV1, PermissionDeltaV1 } from "../permissions/types.js";
import type { CapabilityExecutionPrivateInputBindingV1 } from "../private-input/types.js";
import type { PackageAuthenticityBindingV1, PackagePinV1 } from "../source/types.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import type {
  ActionRootJsonObjectBindingV1,
  ActionRootRawBlobBindingV1,
  CapabilityAdapterBoundedEvidenceV1,
  CapabilityPlanningLedgerV1,
  CapabilityResolvedSourceAuthorityBindingV1,
  CapabilitySourceAccessAuthorityBindingV1,
  CapabilitySourceAccessDescriptorV1,
} from "./execution-types.js";

export interface CapabilityRuntimeAuthorityV1 {
  schema_version: "1.0";
  scope: CapabilityScope;
  scope_identity_digest: string;
  authority_epoch: number;
  authority_head_digest: string;
  policy_digest: string;
  grant_digest: string;
  permission_digest: string;
  source_authority_set_digest: string;
}

export interface ResolvedCapabilityPackageV1 {
  schema_version: "1.0";
  pin: PackagePinV1;
  manifest: CapabilityManifestV1;
  manifest_digest: string;
  authenticity_binding: PackageAuthenticityBindingV1;
  files: ReadonlyMap<string, Uint8Array>;
  dependencies: import("../wire/lock.js").CapabilityDependencyBindingV1[];
  public_inputs: Array<{ input_id: string; value: string | number | boolean | null }>;
  secret_input_ids: string[];
  private_input_binding_digest: string;
  private_input_execution?: CapabilityExecutionPrivateInputBindingV1;
  source_authority_binding_digest: string;
  source_execution?: {
    descriptor: CapabilitySourceAccessDescriptorV1;
    authority: CapabilitySourceAccessAuthorityBindingV1;
    resolved: CapabilityResolvedSourceAuthorityBindingV1;
  };
}

export type CapabilityHostActionV1 = Extract<HostActionV1, { type: CapabilityHostActionKind }>;

export interface CapabilityCanonicalActionBindingV1 {
  schema_version: "1.0";
  action_type: CapabilityHostActionV1["type"];
  action_digest: string;
}

export type CapabilityLifecycleIntentV1 =
  | { kind: "install" }
  | { kind: "configure"; package_id: string }
  | { kind: "retarget"; package_id: string }
  | { kind: "update"; package_id: string }
  | { kind: "remove"; package_id: string; cascade: boolean }
  | { kind: "rollback"; generation_id: string }
  | { kind: "restore"; package_id: string; generation_id: string }
  | { kind: "repair"; package_id: string | null }
  | { kind: "adopt"; candidate_digest: string };

export interface CapabilityPlanningRequestV1 {
  schema_version: "1.0";
  intent: CapabilityLifecycleIntentV1;
  scope: CapabilityScope;
  scope_identity_digest: string;
  authority: CapabilityRuntimeAuthorityV1;
  base_lock: CapabilityLockV1 | null;
  desired_packages: ResolvedCapabilityPackageV1[];
  effect_packages?: ResolvedCapabilityPackageV1[];
  adopt_candidate?: StrictLegacyAdoptCandidateV1;
  selected_engines: EngineName[];
  selected_targets?: Array<{
    package_id: string;
    engine: EngineName;
    participant_id: string | null;
  }>;
  current_permissions?: PermissionBindingV1;
  user_prerequisites?: UserScopePrerequisiteBindingV1[];
  /** Present only on the trusted high-level preparation path. */
  canonical_action?: CapabilityHostActionV1;
  /** Trusted logical owner for durable proposal execution objects. */
  action_root_locator?: Exclude<
    import("../../actions/types.js").PrivateActionRootLocatorV1,
    { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
  >;
  /** Exact host-authenticated source-access request context. */
  source_request_context?: import("./execution-types.js").CapabilitySourceAccessRequestContextV1;
}

export interface CapabilityProjectionSnapshotV1 {
  schema_version: "1.0";
  target_states: Array<{
    target_id: string;
    state: "absent" | "owned" | "unmanaged" | "drifted" | "orphaned";
    live_projection_digests: string[];
  }>;
  owned_resources: CapabilityOwnedResourceV1[];
  ownership_evidence_digest: string;
  observed_at: string;
  snapshot_digest: string;
}

export interface CapabilityAdapterStepV1 {
  step_id: string;
  order: number;
  evidence_schema_id: string;
  target_ids: string[];
  required: boolean;
  effect_classes: ActionEffectClass[];
  permission_ids: string[];
  enforcement_digest: string;
  intent: {
    schema_id: string;
    descriptor_digest: string;
    private_descriptor_ref: string;
  };
  owned_resources: CapabilityOwnedResourceV1[];
  rollback: {
    class: Reversibility;
    schema_id: string | null;
    descriptor_digest: string | null;
    private_descriptor_ref: string | null;
  };
  timeout_ms: number;
}

export interface CapabilityAdapterPlanV1 {
  schema_version: "1.0";
  plan_id: string;
  package_pin: PackagePinV1;
  component_id: string;
  targets: ActionTargetBindingV1[];
  source_authority_binding_digest: string;
  adapter: CapabilityAdapterIdentityV1;
  scope: CapabilityScope;
  base_generation_id: string | null;
  inspection_snapshot_digest: string;
  user_prerequisites: UserScopePrerequisiteBindingV1[];
  portable_input_digest: string;
  private_input_binding_digest: string;
  authority: {
    policy_digest: string;
    grant_digest: string;
    permission_digest: string;
    authority_epoch: number;
    authority_head_digest: string;
    trust_epoch: number;
  };
  steps: CapabilityAdapterStepV1[];
  health_plan: PublicHealthPlanV1[];
  reversibility: Reversibility;
  plan_digest: string;
}

export interface CapabilityExecutionObjectClosureV1 {
  schema_version: "1.0";
  action_root_locator: Exclude<
    import("../../actions/types.js").PrivateActionRootLocatorV1,
    { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
  >;
  scope: CapabilityScope;
  scope_identity_digest: string;
  adapter_registry_digest: string;
  adapter_set_digest: string;
  permission_digest: string;
  source_authority_set_digest: string;
  plans: Array<{ order: number; plan_id: string; plan_digest: string }>;
  json_objects: ActionRootJsonObjectBindingV1[];
  private_input_bindings: Array<{
    order: number;
    plan_id: string;
    binding_digest: string;
    binding_ref: string | null;
  }>;
  raw_blobs: ActionRootRawBlobBindingV1[];
  closure_digest: string;
}

export interface CapabilityPlanRuntimeClosureV1 {
  authority: CapabilityRuntimeAuthorityV1;
  adapter_registry: CapabilityAdapterRegistryV1;
  packages: Array<
    Omit<ResolvedCapabilityPackageV1, "files" | "private_input_execution" | "source_execution">
  >;
  effect_packages: Array<
    Omit<ResolvedCapabilityPackageV1, "files" | "private_input_execution" | "source_execution">
  >;
  snapshots: CapabilityProjectionSnapshotV1[];
  inspection_evidence: CapabilityAdapterBoundedEvidenceV1[];
  descriptors: CapabilityEffectDescriptorV1[];
}

export interface CapabilityFabricPlanV1 {
  schema_version: "1.0";
  status: CapabilityPlanStatusV1;
  intent: CapabilityLifecycleIntentV1;
  action_binding: CapabilityCanonicalActionBindingV1 | null;
  scope: CapabilityScope;
  scope_identity_digest: string;
  action_root_locator: Exclude<
    import("../../actions/types.js").PrivateActionRootLocatorV1,
    { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
  >;
  base_generation_id: string | null;
  base_lock_digest: string | null;
  targets: ActionTargetBindingV1[];
  target_dispositions: CapabilityTargetDispositionV1[];
  permission_binding: PermissionBindingV1;
  permission_digest: string;
  permission_delta: PermissionDeltaV1[];
  adapter_registry_digest: string;
  adapter_set_digest: string;
  source_authority_set_digest: string;
  effect_classes: ActionEffectClass[];
  reversibility: Reversibility;
  adapter_plans: CapabilityAdapterPlanV1[];
  runtime_closure: CapabilityPlanRuntimeClosureV1;
  execution_closure: CapabilityExecutionObjectClosureV1;
  execution_closure_digest: string;
  created_at: string;
  plan_digest: string;
}

export interface CapabilityDurablePlanningGraphV1 {
  plan: CapabilityFabricPlanV1;
  action_plan: import("../action-domain/types.js").CapabilityActionPlanBindingV1;
  execution_closure: CapabilityExecutionObjectClosureV1;
  ledger: CapabilityPlanningLedgerV1;
}

export type {
  ActionRootJsonObjectBindingV1,
  ActionRootRawBlobBindingV1,
  CapabilityExecutionObjectSchemaIdV1,
  CapabilityPlanningLedgerV1,
} from "./execution-types.js";
