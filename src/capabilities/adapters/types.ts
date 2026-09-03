import type { CapabilityManifestHealthProbeKind } from "../../actions/capability-manifest-vocabulary-contract.js";
import type { LegacySourceV1 } from "../../actions/legacy-adopt-types.js";
import type {
  ActionPlanningMode,
  EngineName,
  NonRecoveryActionRootLocatorV1,
} from "../../actions/types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type { CapabilityComponentV1 } from "../manifest/types.js";
import type {
  CapabilityPlanningRequestV1,
  ResolvedCapabilityPackageV1,
} from "../planning/types.js";
import type {
  CapabilityHealthOutcomeV1,
  CapabilityOperationRecoveryPhaseV1,
} from "../wire/operation-state-contract.js";

export type CapabilityAdapterSupportV1 =
  | "host"
  | "manual-runtime-setup"
  | "native-install-required"
  | "external-confirmation-required"
  | "unsupported";

export interface CapabilityAdapterIdentityV1 {
  adapter_id: string;
  adapter_version: string;
  fingerprint: string;
}

export type CapabilityAdapterRegistryEntryV1 = {
  component_type: CapabilityComponentV1["type"];
  engine: EngineName;
} & (
  | {
      support: Exclude<CapabilityAdapterSupportV1, "unsupported">;
      adapter: CapabilityAdapterIdentityV1;
    }
  | { support: "unsupported"; adapter: null }
);

export interface CapabilityAdapterRegistryV1 {
  schema_version: "1.0";
  entries: CapabilityAdapterRegistryEntryV1[];
  legacy_adoption_entries: Array<{
    legacy_source: LegacySourceV1;
    support: "host";
    adapter: CapabilityAdapterIdentityV1;
  }>;
  registry_digest: string;
}

export type CapabilityOwnedResourceKindV1 =
  | "file"
  | "config-key"
  | "managed-registration"
  | "external-effect";

export interface CapabilityOwnedResourceV1 {
  ownership_key: string;
  kind: CapabilityOwnedResourceKindV1;
  public_target: string;
  expected_preimage_sha256: string | null;
  expected_postimage_sha256: string | null;
  private_preimage_digest: string | null;
  private_preimage_ref: string | null;
}

export interface CapabilityProjectionObservationV1 {
  schema_version: "1.0";
  ownership_key: string;
  state: "absent" | "present";
  content_sha256: string | null;
  observed_at: string;
}

export type CapabilityPrivateJsonV1 =
  | null
  | boolean
  | number
  | string
  | CapabilityPrivateJsonV1[]
  | { [key: string]: CapabilityPrivateJsonV1 };

export interface CapabilityAdapterPrivateDescriptorV1 {
  schema_version: "1.0";
  descriptor_kind: "intent" | "rollback";
  descriptor_schema_id: "vf.adapter-owned-projection/1";
  value: CapabilityPrivateEffectDescriptorValueV1;
  descriptor_digest: string;
}

interface CapabilityPrivateEffectPayloadBaseV1 {
  schema_version: "1.0";
  payload_digest: string;
  ownership_key: string;
  expected_preimage_sha256: string | null;
  expected_postimage_sha256: string | null;
  /** The prior approved descriptor binding from which owner-registry CAS bytes
   * are reconstructed. Raw owner-record backup bytes are never retained. */
  preimage_owner_binding?: CapabilityPrivateEffectOwnerPreimageBindingV1 | null;
}

export type CapabilityPrivateEffectPayloadV1 = CapabilityPrivateEffectPayloadBaseV1 &
  (
    | {
        payload_kind: "memory-test-only";
      }
    | {
        payload_kind: "owned-file";
        root: CapabilityScope;
        canonical_relative_path: string;
        marker_relative_path: string;
        file_mode: 0o600 | 0o644 | 0o755;
        preimage_base64: string | null;
        postimage_base64: string | null;
        preimage_marker_base64: string | null;
        postimage_marker_base64: string | null;
      }
    | {
        payload_kind: "json-key-slice";
        root: CapabilityScope;
        canonical_relative_path: string;
        marker_relative_path: string;
        key_path: string[];
        preimage: CapabilityPrivateJsonV1 | null;
        preimage_present: boolean;
        postimage: CapabilityPrivateJsonV1 | null;
        postimage_present: boolean;
        preimage_marker: CapabilityPrivateJsonV1 | null;
        postimage_marker: CapabilityPrivateJsonV1 | null;
        auxiliary_files: Array<{
          canonical_relative_path: string;
          file_mode: 0o600 | 0o644 | 0o755;
          preimage_base64: string | null;
          postimage_base64: string | null;
        }>;
      }
    | {
        /** Closed hook adapter payload. It owns one engine hook JSON leaf and,
         * for Codex only, one marked feature block in the user-global TOML. */
        payload_kind: "hook-config-slice";
        root: CapabilityScope;
        canonical_relative_path: string;
        marker_relative_path: string;
        key_path: string[];
        preimage: CapabilityPrivateJsonV1 | null;
        preimage_present: boolean;
        postimage: CapabilityPrivateJsonV1 | null;
        postimage_present: boolean;
        preimage_marker: CapabilityPrivateJsonV1 | null;
        postimage_marker: CapabilityPrivateJsonV1 | null;
        codex_feature: {
          canonical_relative_path: string;
          block_id: "codex-hooks-feature";
          placement: "append" | "after-features-header";
          preimage_block: string | null;
          postimage_block: string | null;
        } | null;
      }
    | {
        payload_kind: "toml-owned-block";
        root: CapabilityScope;
        canonical_relative_path: string;
        marker_relative_path: string;
        block_id: string;
        preimage_block: string | null;
        postimage_block: string | null;
        preimage_marker: CapabilityPrivateJsonV1 | null;
        postimage_marker: CapabilityPrivateJsonV1 | null;
      }
    | {
        payload_kind: "legacy-claim";
        root: CapabilityScope;
        legacy_source: LegacySourceV1;
        inspection_evidence_digest: string;
        evidence_record_digest: string;
        projection:
          | {
              kind: "file";
              canonical_relative_path: string;
              preimage_base64: string;
            }
          | {
              kind: "json-key-slice";
              canonical_relative_path: string;
              key_path: string[];
              preimage: CapabilityPrivateJsonV1;
            };
      }
  );

export interface CapabilityPrivateEffectBindingV1 {
  schema_version: "1.0";
  descriptor_schema_id: "vf.adapter-owned-projection/1";
  action_root_locator: NonRecoveryActionRootLocatorV1;
  action_root_binding_digest: string;
  descriptor_digest: string;
  private_descriptor_ref: string;
}

/** Minimal prior-binding closure needed to recreate the exact owner record.
 * The descriptor ref is derived from descriptor_digest and is intentionally
 * absent so a new proposal descriptor does not introduce an external object
 * reference into its closed execution graph. */
export interface CapabilityPrivateEffectOwnerPreimageBindingV1 {
  schema_version: "1.0";
  descriptor_schema_id: "vf.adapter-owned-projection/1";
  action_root_locator: NonRecoveryActionRootLocatorV1;
  action_root_binding_digest: string;
  descriptor_digest: string;
}

export interface CapabilityActionRootResolverV1 {
  resolve(locator: NonRecoveryActionRootLocatorV1): string;
}

export interface FilesystemCapabilityEffectBrokerOptionsV1 {
  projectRoot: string;
  userRoot: string;
  projectStateRoot: string;
  userStateRoot: string;
  actionRoots?: CapabilityActionRootResolverV1;
  now?: () => string;
}

export interface CapabilityEffectPreparationRequestV1 {
  schema_version: "1.0";
  request: CapabilityPlanningRequestV1;
  package: ResolvedCapabilityPackageV1;
  component: CapabilityComponentV1;
  target: {
    target_id: string;
    scope: CapabilityScope;
    engine: EngineName;
    participant_id: string | null;
  };
  operation: "ensure" | "remove" | "claim";
  adopt_resource?: Omit<
    CapabilityOwnedResourceV1,
    "kind" | "expected_postimage_sha256" | "private_preimage_digest" | "private_preimage_ref"
  >;
}

export interface CapabilityPreparedEffectV1 {
  resource: CapabilityOwnedResourceV1;
  private_payload: CapabilityPrivateEffectPayloadV1;
  private_preimage_bytes: Uint8Array | null;
  /** Opaque, bounded adapter inspection evidence retained only in the private action graph. */
  private_inspection_evidence_bytes?: Uint8Array | null;
}

export interface CapabilityPrivateEffectDescriptorValueV1 {
  operation: "ensure" | "remove" | "claim";
  adapter: CapabilityAdapterIdentityV1;
  package_pin_digest: string;
  component_id: string;
  target_id: string;
  resource: CapabilityOwnedResourceV1;
  projection_digest: string;
  private_payload: CapabilityPrivateEffectPayloadV1;
}

export interface CapabilityEffectDescriptorV1 {
  schema_version: "1.0";
  descriptor_kind: "intent" | "rollback";
  descriptor_schema_id: "vf.adapter-owned-projection/1";
  operation: "ensure" | "remove" | "claim";
  adapter: CapabilityAdapterIdentityV1;
  package_pin_digest: string;
  component_id: string;
  target_id: string;
  resource: CapabilityOwnedResourceV1;
  private_payload_binding: CapabilityPrivateEffectBindingV1;
  /** Binding published by the forward descriptor; rollback reuses it as owner CAS authority. */
  owner_binding: CapabilityPrivateEffectBindingV1;
  projection_digest: string;
  descriptor_digest: string;
}

export interface CapabilityHealthProbeRequestV1 {
  target_id: string;
  probe_id: string;
  kind: CapabilityManifestHealthProbeKind;
  expected_resources: CapabilityOwnedResourceV1[];
}

export interface CapabilityHealthEvidenceV1 {
  schema_version: "1.0";
  evidence_schema_id: "vf.adapter-health-filesystem/1" | "vf.adapter-health-memory-test/1";
  target_id: string;
  probe_id: string;
  kind: CapabilityHealthProbeRequestV1["kind"];
  outcome: CapabilityHealthOutcomeV1;
  resources: Array<{
    ownership_key: string;
    expected_postimage_sha256: string | null;
    observed_content_sha256: string | null;
  }>;
  evidence_digest: string;
}

export interface CapabilityEffectBrokerV1 {
  prepare(
    request: CapabilityEffectPreparationRequestV1,
    persistence?: ActionPlanningMode,
  ): CapabilityPreparedEffectV1;
  prepareRemoval(
    resource: CapabilityOwnedResourceV1,
    persistence?: ActionPlanningMode,
    actionRootLocator?: NonRecoveryActionRootLocatorV1,
  ): CapabilityPreparedEffectV1;
  retainPrivateDescriptor(
    descriptor: CapabilityAdapterPrivateDescriptorV1,
    persistence: ActionPlanningMode,
    actionRootLocator: NonRecoveryActionRootLocatorV1,
  ): CapabilityPrivateEffectBindingV1;
  resolvePrivatePayload(
    binding: CapabilityPrivateEffectBindingV1,
  ): CapabilityPrivateEffectPayloadV1;
  clearTransientPayloads(): void;
  inspect(
    resource: Pick<CapabilityOwnedResourceV1, "ownership_key" | "public_target" | "kind">,
    privatePayload?: CapabilityPrivateEffectPayloadV1,
  ): CapabilityProjectionObservationV1;
  apply(
    descriptor: CapabilityEffectDescriptorV1,
    privatePayload: CapabilityPrivateEffectPayloadV1,
  ): CapabilityProjectionObservationV1;
  rollback(
    descriptor: CapabilityEffectDescriptorV1,
    privatePayload: CapabilityPrivateEffectPayloadV1,
  ): CapabilityProjectionObservationV1;
  /** Deterministically completes or restores a crash-partial effect. Every
   * internal subprojection must still equal its approved preimage or postimage. */
  reconcile(
    descriptor: CapabilityEffectDescriptorV1,
    privatePayload: CapabilityPrivateEffectPayloadV1,
    direction: CapabilityOperationRecoveryPhaseV1,
  ): CapabilityProjectionObservationV1;
  health(request: CapabilityHealthProbeRequestV1): {
    outcome: CapabilityHealthOutcomeV1;
    evidence_digest: string;
    evidence: CapabilityHealthEvidenceV1;
  };
}
