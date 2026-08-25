import type { EngineName } from "../../actions/types.js";
import type { CapabilityMetadataV1 } from "../manifest/types.js";
import type { ResolvedCapabilityPackageV1 } from "../planning/types.js";
import type { PackagePinV1 } from "../source/types.js";
import type { CapabilityStatusV1, PublicCapabilityInputStateV1 } from "../wire/query.js";

export interface CapabilityDiscoveryEntryV1 {
  package_id: string;
  version: string;
  pin: PackagePinV1;
  manifest_digest: string;
  metadata: CapabilityMetadataV1;
  compatible_engines: EngineName[];
  scan_status: "passed" | "failed" | "unknown";
  cache_status: "available" | "missing";
  stale: boolean;
  entry_digest: string;
}

export interface CapabilityDiscoverySnapshotV1 {
  generation_digest: string;
  offline: boolean;
  entries: CapabilityDiscoveryEntryV1[];
}

export interface CapabilityDiscoveryReaderV1 {
  read(): CapabilityDiscoverySnapshotV1;
}

export interface CapabilityQueryRequestV1 {
  view: "search" | "list" | "status" | "detail";
  scope: "project" | "user";
  query?: string;
  package_id?: string;
  engines?: EngineName[];
  statuses?: CapabilityStatusV1[];
  cursor?: string | null;
  limit?: number;
}

export interface CapabilityDetailRequestV1 {
  scope: "project" | "user";
  package_id: string;
  package_pin_digest?: string;
  version?: string;
  content_sha256?: string;
}

export interface CapabilityPackageReadRequestV1 {
  package_id: string;
  package_pin_digest: string;
  version: string;
  content_sha256: string;
}

export interface CapabilityPackageReaderV1 {
  read(request: CapabilityPackageReadRequestV1): ResolvedCapabilityPackageV1 | null;
}

export interface CapabilityPrivateInputPresenceRequestV1 {
  scope: "project" | "user";
  package_id: string;
  package_pin_digest: string;
  manifest_digest: string;
  input_id: string;
}

export interface CapabilityPrivateInputPresenceReaderV1 {
  readValidatedPresence(
    request: CapabilityPrivateInputPresenceRequestV1,
  ): Extract<PublicCapabilityInputStateV1["current"], { kind: "unset" | "private" }>;
}
