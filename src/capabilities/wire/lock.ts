import type { CAPABILITY_MANIFEST_DEPENDENCY_SCOPE } from "../../actions/capability-manifest-vocabulary-contract.js";
import type { EngineName, JsonScalar } from "../../actions/types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type { PackageAuthenticityBindingV1, PackagePinV1 } from "../source/types.js";

export const CAPABILITY_LOCK_TARGET_STATE = Object.freeze({
  INSTALLED: "installed",
  DEGRADED: "degraded",
} as const);
export type CapabilityLockTargetState =
  (typeof CAPABILITY_LOCK_TARGET_STATE)[keyof typeof CAPABILITY_LOCK_TARGET_STATE];
export const CAPABILITY_LOCK_TARGET_STATES = Object.freeze(
  Object.values(CAPABILITY_LOCK_TARGET_STATE),
);

export interface CapabilityLockV1 {
  schema_version: "1.0";
  fabric_active: true;
  scope: CapabilityScope;
  generation_id: string;
  generation_ordinal: number;
  parent_generation_digests: string[];
  packages: CapabilityLockEntryV1[];
  policy_digest: string;
  permission_digest: string;
  created_at: string;
  content_digest: string;
}

export interface CapabilityLockEntryV1 {
  package_id: string;
  pin: PackagePinV1;
  manifest_digest: string;
  authenticity_binding: PackageAuthenticityBindingV1;
  lock_entry_digest: string;
  dependencies: CapabilityDependencyBindingV1[];
  public_inputs: Array<{ input_id: string; value: JsonScalar }>;
  secret_input_ids: string[];
  portable_input_digest: string;
  targets: CapabilityLockedTargetV1[];
  ownership_keys: string[];
}

export interface CapabilityLockedTargetV1 {
  target_id: string;
  component_id: string;
  scope: CapabilityScope;
  engine: EngineName | null;
  participant_id: string | null;
  required: boolean;
  state: CapabilityLockTargetState;
  adapter_fingerprints: string[];
  projections: Array<{ ownership_key: string; projection_digest: string }>;
  enforcement_digest: string;
  health_plan_digest: string;
}

export type CapabilityDependencyBindingV1 =
  | {
      required_scope: typeof CAPABILITY_MANIFEST_DEPENDENCY_SCOPE.SAME;
      package_id: string;
      version: string;
      content_sha256: string;
    }
  | {
      required_scope: typeof CAPABILITY_MANIFEST_DEPENDENCY_SCOPE.USER_PREREQUISITE;
      package_id: string;
      version: string;
      content_sha256: string;
      required_health_plan_digest: string;
    };
