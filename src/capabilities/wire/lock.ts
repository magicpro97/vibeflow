import type { EngineName, JsonScalar } from "../../actions/types.js";
import type { PackageAuthenticityBindingV1, PackagePinV1 } from "../source/types.js";

export interface CapabilityLockV1 {
  schema_version: "1.0";
  fabric_active: true;
  scope: "project" | "user";
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
  scope: "project" | "user";
  engine: EngineName | null;
  participant_id: string | null;
  required: boolean;
  state: "installed" | "degraded";
  adapter_fingerprints: string[];
  projections: Array<{ ownership_key: string; projection_digest: string }>;
  enforcement_digest: string;
  health_plan_digest: string;
}

export type CapabilityDependencyBindingV1 =
  | {
      required_scope: "same";
      package_id: string;
      version: string;
      content_sha256: string;
    }
  | {
      required_scope: "user-prerequisite";
      package_id: string;
      version: string;
      content_sha256: string;
      required_health_plan_digest: string;
    };
