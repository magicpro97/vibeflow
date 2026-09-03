import type { LegacySource } from "../../actions/capability-manifest-vocabulary-contract.js";
import type {
  CAPABILITY_SIGNATURE_ALGORITHM,
  CAPABILITY_SOURCE_KIND,
  CapabilityPackagePinTrust,
  CapabilityRegistryEnvelopeStatus,
  CapabilityRegistryTrustKeyState,
} from "../../actions/capability-security-contract.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type { CapabilityMetadataV1 } from "../manifest/types.js";

export interface RegistryPackageStatementV1 {
  schema_version: "1.0";
  registry_origin: string;
  package_id: string;
  version: string;
  content_sha256: string;
  provenance: { source_url: string; commit_oid: string | null };
  publisher_id: string;
  issued_at: string;
  expires_at: string;
}

export interface RegistrySignatureEnvelopeV1 {
  schema_version: "1.0";
  statement: RegistryPackageStatementV1;
  signature: {
    algorithm: typeof CAPABILITY_SIGNATURE_ALGORITHM.ED25519;
    key_id: string;
    value_base64url: string;
  };
}

export interface RegistryCapabilityIndexV1 {
  schema_version: "1.0";
  registry_origin: string;
  generated_at: string;
  entries: Array<{
    package_id: string;
    version: string;
    metadata_hint: CapabilityMetadataV1;
    package_url: string;
    signature_envelope: RegistrySignatureEnvelopeV1;
  }>;
  content_digest: string;
}

export interface RegistryTrustKeyV1 {
  key_id: string;
  algorithm: typeof CAPABILITY_SIGNATURE_ALGORITHM.ED25519;
  public_key_spki_base64: string;
  registry_origin: string;
  publisher_id: string | null;
  valid_from: string;
  valid_until: string;
  state: CapabilityRegistryTrustKeyState;
  trust_epoch: number;
  frame_digest: string;
}

export interface RegistryTrustSnapshotV1 {
  schema_version: "1.0";
  scope: CapabilityScope;
  scope_identity_digest: string;
  authority_epoch: number;
  authority_head_digest: string;
  trust_head_digest: string | null;
  trust_epoch: number;
  keys: RegistryTrustKeyV1[];
  snapshot_digest: string;
}

export interface VerifiedRegistryEnvelopeV1 {
  envelope_digest: string;
  key_id: string;
  statement_expires_at: string;
  status: CapabilityRegistryEnvelopeStatus;
  scope: CapabilityScope;
  scope_identity_digest: string;
  authority_epoch: number;
  authority_head_digest: string;
  trust_head_digest: string | null;
  trust_epoch: number;
  trust_snapshot_digest: string;
}

export type PackagePinSourceV1 =
  | {
      kind: typeof CAPABILITY_SOURCE_KIND.REGISTRY;
      registry_origin: string;
      source_url: string;
      commit_oid: string | null;
      signature_envelope_digest: string;
    }
  | { kind: typeof CAPABILITY_SOURCE_KIND.GIT; canonical_url: string; commit_oid: string }
  | { kind: typeof CAPABILITY_SOURCE_KIND.LOCAL_DEV; repo_relative_alias: string }
  | {
      kind: typeof CAPABILITY_SOURCE_KIND.LEGACY_ADOPT;
      legacy_source: LegacySource;
      inspection_evidence_digest: string;
    };

export interface PackagePinV1 {
  id: string;
  version: string;
  source: PackagePinSourceV1;
  content_sha256: string;
  trust: CapabilityPackagePinTrust;
  nonportable: boolean;
  pin_digest: string;
}

export interface PackageAuthenticityBindingV1 {
  schema_version: "1.0";
  pin_digest: string;
  manifest_digest: string;
  registry_signature: {
    envelope_digest: string;
    key_id: string;
    statement_expires_at: string;
  } | null;
  authenticity_digest: string;
}

export interface LegacyInspectionEvidenceV1 {
  schema_version: "1.0";
  legacy_source: Extract<
    PackagePinSourceV1,
    { kind: typeof CAPABILITY_SOURCE_KIND.LEGACY_ADOPT }
  >["legacy_source"];
  raw_identifier_nfc: string;
  adapter_fingerprint: string;
  source_records: Array<{
    record_kind: "lock" | "managed-sidecar" | "sentinel" | "renderer-marker" | "descriptor";
    logical_id: string;
    content_sha256: string;
    record_digest: string;
  }>;
  owned_resources: Array<{
    ownership_key: string;
    public_target: string;
    expected_preimage_sha256: string;
  }>;
  evidence_digest: string;
}

export interface ValidatedLegacyInspectionEvidenceV1 extends LegacyInspectionEvidenceV1 {}
