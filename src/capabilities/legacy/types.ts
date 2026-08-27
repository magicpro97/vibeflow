import type { LegacySourceV1 } from "../../actions/legacy-adopt-types.js";
import type { StrictLegacyAdoptCandidateV1 } from "../../actions/legacy-adopt-types.js";
import type { EngineName } from "../../actions/types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type { CapabilityOwnedResourceKindV1 } from "../adapters/types.js";

export interface LegacyOwnershipProofV1 {
  record_kind: string;
  logical_id: string;
  content_sha256: string;
}

export interface LegacyOwnedMarkerV1 {
  schema_version: "1.0";
  source: LegacySourceV1;
  raw_identifier: string;
  engine: EngineName;
  vf_owned: boolean;
  ownership_proof: LegacyOwnershipProofV1 | null;
  owned_resources: Array<{
    ownership_key: string;
    kind: CapabilityOwnedResourceKindV1;
    public_target: string;
    expected_preimage_sha256: string;
  }>;
  payload: Uint8Array;
}

export interface LegacyAdoptInspectionRequestV1 {
  schema_version: "1.0";
  idempotency_key: string;
  scope: CapabilityScope;
  legacy_sources: LegacySourceV1[];
}

export interface LegacyAdoptScanRequestV1 {
  schema_version: "1.0";
  scope: CapabilityScope;
  scope_identity_digest: string;
  sources: LegacySourceV1[];
}

export interface LegacyAdoptMaterializedInspectionRequestV1 extends LegacyAdoptScanRequestV1 {
  markers: LegacyOwnedMarkerV1[];
}

export interface LegacyMarkerReaderV1 {
  scan(request: LegacyAdoptScanRequestV1): LegacyOwnedMarkerV1[];
}

export interface LegacyAdoptClaimAuthorityV1 {
  stage(marker: LegacyOwnedMarkerV1, candidate: StrictLegacyAdoptCandidateV1): void;
}
