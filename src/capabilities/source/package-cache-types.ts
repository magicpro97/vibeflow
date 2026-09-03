import type { CapabilityScope } from "../../core/capability-contract.js";
import type {
  PackageAuthenticityBindingV1,
  PackagePinV1,
  RegistrySignatureEnvelopeV1,
} from "./types.js";

export interface CapabilityPackageCacheRecordV1 {
  schema_version: "1.0";
  scope: CapabilityScope;
  scope_identity_digest: string;
  package_pin: PackagePinV1;
  manifest_digest: string;
  authenticity_digest: string;
  tree_entry_count: number;
  tree_expanded_byte_length: number;
  registry_envelope_digest: string | null;
  legacy_inspection_evidence_digest: string | null;
  record_digest: string;
}

export interface CapabilityPackageCachePublicationV1 {
  pin: PackagePinV1;
  tree: import("./tree.js").PackageTreeV1;
  manifest: import("../manifest/types.js").ValidatedCapabilityManifestV1;
  authenticity: PackageAuthenticityBindingV1;
  registry_envelope: RegistrySignatureEnvelopeV1 | null;
  legacy_inspection_evidence: unknown | null;
}
