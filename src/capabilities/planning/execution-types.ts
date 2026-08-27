import type { CAPABILITY_SOURCE_KIND } from "../../actions/capability-security-contract.js";
import type { AuthorizableActionKind } from "../../actions/host-action-contract.js";
import type { ACTION_EFFECT_CLASS } from "../../actions/public-action-contract.js";
import type {
  ActionEffectClass,
  ActionPlanningOptionsV1,
  CapabilityScope,
  EngineName,
  PublicActor,
} from "../../actions/types.js";
import type {
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityAdapterRegistryV1,
} from "../adapters/types.js";
import type { PermissionBindingV1 } from "../permissions/types.js";
import type { CapabilityExecutionPrivateInputRecordV1 } from "../private-input/types.js";
import type { PackageAuthenticityBindingV1 } from "../source/types.js";
import type { CapabilityExecutionLedgerMode } from "./execution-ledger-contract.js";
import type { CapabilityAdapterPlanV1, CapabilityProjectionSnapshotV1 } from "./types.js";

export type CapabilityExecutionObjectSchemaIdV1 =
  | "vf.capability-adapter-registry/1"
  | "vf.adapter-plan/1"
  | "vf.projection-snapshot/1"
  | "vf.adapter-bounded-evidence/1"
  | "vf.adapter-private-descriptor/1"
  | "vf.step-enforcement-binding/1"
  | "vf.probe-enforcement-binding/1"
  | "vf.permission-binding/1"
  | "vf.adapter-set-binding/1"
  | "vf.source-access-descriptor/1"
  | "vf.source-access-authority-binding/1"
  | "vf.package-authenticity-binding/1"
  | "vf.resolved-source-authority-binding/1"
  | "vf.control-credential-binding/1";

export interface ActionRootJsonObjectBindingV1 {
  object_schema_id: CapabilityExecutionObjectSchemaIdV1;
  object_digest: string;
  object_ref: string;
  canonical_byte_length: number;
}

export type CapabilityExecutionRawBlobKindV1 =
  | "owned-resource-preimage"
  | "inspection-private-evidence"
  | "suspected-literal-content"
  | "policy-settings-preimage"
  | "policy-settings-replacement";

export interface ActionRootRawBlobBindingV1 {
  blob_kind: CapabilityExecutionRawBlobKindV1;
  content_digest: string;
  raw_sha256: string;
  byte_length: number;
  blob_ref: string;
}

export interface CapabilityAdapterSetBindingV1 {
  schema_version: "1.0";
  adapter_registry_digest: string;
  adapters: Array<{
    adapter_id: string;
    adapter_version: string;
    fingerprint: string;
    target_ids: string[];
  }>;
}

export interface CapabilityStepEnforcementBindingV1 {
  schema_version: "1.0";
  targets: Array<{
    target_id: string;
    permissions: Array<Omit<PermissionBindingV1["permissions"][number], "target_ids">>;
  }>;
  enforcement_digest: string;
}

export interface CapabilityProbeEnforcementBindingV1 extends CapabilityStepEnforcementBindingV1 {
  probe_id: string;
}

export interface CapabilityAdapterBoundedEvidenceV1 {
  schema_version: "1.0";
  evidence_schema_id: string;
  evidence_kind: "inspection";
  adapter_fingerprint: string;
  scope: CapabilityScope;
  scope_identity_digest: string;
  package_pin_digest: string;
  manifest_digest: string;
  component_id: string;
  source_authority_binding_digest: string;
  private_input_binding_digest: string | null;
  authority_epoch: number;
  authority_head_digest: string;
  policy_digest: string;
  grant_digest: string;
  permission_digest: string;
  operation_id: null;
  plan_id: null;
  step_id: null;
  probe_id: null;
  observed_receipt_state: null;
  receipt_attempt: null;
  observed_preimage_sha256: string | null;
  observed_postimage_sha256: string | null;
  error_code: null;
  health_probe_kind: null;
  health_timeout_ms: null;
  health_attempt_count: null;
  health_outcome: null;
  target_ids: string[];
  facts: Array<{
    fact_id: string;
    outcome: "present" | "absent" | "match" | "mismatch";
    value: string | number | boolean | null;
  }>;
  native_identifier_producer_receipt_digests: string[];
  private_payload_content_digest: string | null;
  observed_at: string;
  expires_at: string | null;
  evidence_digest: string;
}

export interface CapabilitySourceAccessRequestContextV1 {
  schema_version: "1.0";
  origin: "conversation" | "standalone";
  planning_options: ActionPlanningOptionsV1;
  interactivity: "foreground-control" | "background" | "non-interactive";
  requested_by: PublicActor;
  principal_digest: string;
  authorization_action_type: AuthorizableActionKind | null;
}

export interface CapabilitySourceAccessDescriptorV1 {
  schema_version: "1.0";
  request_context: CapabilitySourceAccessRequestContextV1;
  intent: "fetch-package" | "read-local-package" | "inspect-legacy";
  authorization_mode: "automatic" | "interactive-control";
  target_engines: EngineName[];
  source:
    | {
        kind: typeof CAPABILITY_SOURCE_KIND.REGISTRY;
        registry_origin: string;
        package_url: string;
      }
    | { kind: typeof CAPABILITY_SOURCE_KIND.GIT; canonical_url: string; commit_oid: string }
    | { kind: typeof CAPABILITY_SOURCE_KIND.LOCAL_DEV; repo_relative_alias: string }
    | {
        kind: typeof CAPABILITY_SOURCE_KIND.LEGACY_ADOPT;
        phase: "inspect";
        legacy_source: import("../../actions/legacy-adopt-types.js").LegacySourceV1;
        engine: EngineName | null;
      }
    | {
        kind: typeof CAPABILITY_SOURCE_KIND.LEGACY_ADOPT;
        phase: "candidate";
        candidate_digest: string;
      };
  credential: {
    schema_version: "1.0";
    scope: CapabilityScope;
    scope_identity_digest: string;
    principal_digest: string;
    kind: "none";
    binding_digest: string;
  };
  expected_content_sha256: string | null;
  network_policy_profile: null;
  max_response_bytes: number;
  cache_write: false;
  required_permission_row_digests: string[];
  descriptor_digest: string;
}

export interface CapabilitySourceAccessAuthorityBindingV1 {
  schema_version: "1.0";
  scope: CapabilityScope;
  scope_identity_digest: string;
  source_descriptor_digest: string;
  effect_classes: Array<
    Extract<
      ActionEffectClass,
      | typeof ACTION_EFFECT_CLASS.PURE_LOCAL_READ
      | typeof ACTION_EFFECT_CLASS.LOCAL_READ_WITH_CACHE
      | typeof ACTION_EFFECT_CLASS.NETWORK_READ
      | typeof ACTION_EFFECT_CLASS.PROCESS_PROBE
    >
  >;
  authorization:
    | { kind: "confirmation-free"; reason: typeof ACTION_EFFECT_CLASS.PURE_LOCAL_READ }
    | {
        kind: "grant";
        grant_id: string;
        grant_frame_digest: string;
        permission_binding_digests: string[];
        expires_at: string;
      }
    | {
        kind: "interactive-control";
        public_actor_id: string;
        control_credential_digest: string;
        expires_at: string;
      };
  policy_digest: string;
  binding_digest: string;
}

export interface CapabilityResolvedSourceAuthorityBindingV1 {
  schema_version: "1.0";
  scope: CapabilityScope;
  scope_identity_digest: string;
  authenticity_digest: string;
  trust_epoch: number;
  trust_head_digest: string | null;
  source_access_authority_digest: string;
  resolved_at: string;
  expires_at: string;
  binding_digest: string;
}

export interface CapabilityControlCredentialBindingV1 {
  schema_version: "1.0";
  public_actor_id: string;
  credential_class: "loopback-session" | "interactive-tty";
  principal_digest: string;
  control_session_digest: string;
  csrf_epoch_digest: string;
  issued_at: string;
  expires_at: string;
  binding_digest: string;
}

export type CapabilityExecutionJsonObjectValueV1 =
  | CapabilityAdapterRegistryV1
  | CapabilityAdapterPlanV1
  | CapabilityProjectionSnapshotV1
  | CapabilityAdapterBoundedEvidenceV1
  | CapabilityAdapterPrivateDescriptorV1
  | CapabilityStepEnforcementBindingV1
  | CapabilityProbeEnforcementBindingV1
  | PermissionBindingV1
  | CapabilityAdapterSetBindingV1
  | CapabilitySourceAccessDescriptorV1
  | CapabilitySourceAccessAuthorityBindingV1
  | PackageAuthenticityBindingV1
  | CapabilityResolvedSourceAuthorityBindingV1
  | CapabilityControlCredentialBindingV1;

export interface CapabilityPlanningJsonObjectV1 {
  stratum: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  binding: ActionRootJsonObjectBindingV1;
  value: CapabilityExecutionJsonObjectValueV1;
}

export interface CapabilityPlanningRawBlobV1 {
  stratum: 1;
  binding: ActionRootRawBlobBindingV1;
  bytes_base64: string;
}

export interface CapabilityPlanningPrivateInputV1 {
  stratum: 1;
  binding_digest: string;
  binding_ref: string;
  record: CapabilityExecutionPrivateInputRecordV1;
}

export interface CapabilityPlanningLedgerV1 {
  schema_version: "1.0";
  mode: CapabilityExecutionLedgerMode;
  json_objects: CapabilityPlanningJsonObjectV1[];
  private_input_bindings: CapabilityPlanningPrivateInputV1[];
  raw_blobs: CapabilityPlanningRawBlobV1[];
}
