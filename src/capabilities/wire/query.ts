import type { EngineName, RecoveryAction } from "../../actions/types.js";
import type { CapabilityInputDeclarationV1 } from "../manifest/types.js";
import type { PackagePinV1 } from "../source/types.js";

export type CapabilityStatusV1 =
  | "absent"
  | "ready"
  | "degraded"
  | "blocked"
  | "failed"
  | "unknown"
  | "stale"
  | "drifted"
  | "orphaned"
  | "unmanaged"
  | "manual"
  | "unsupported"
  | "needs-recovery";

export interface CapabilityQueryItemV1 {
  package_id: string;
  discovery_entry_digest: string | null;
  display_name: string;
  summary: string;
  version: string | null;
  package_pin_digest: string | null;
  content_sha256: string | null;
  scope: "project" | "user" | null;
  status: CapabilityStatusV1;
  source_kind: PackagePinV1["source"]["kind"] | null;
  source_trust: PackagePinV1["trust"] | null;
  scan_status: "passed" | "failed" | "unknown" | "not-applicable";
  cache_status: "available" | "missing" | "not-applicable";
  generation_id: string | null;
  targets: Array<{
    target_id: string;
    component_id: string | null;
    engine: EngineName | null;
    participant_id: string | null;
    required: boolean;
    status: CapabilityStatusV1;
    health_digest: string | null;
  }>;
  recovery_actions: RecoveryAction[];
}

export interface CapabilityQueryResponseV1 {
  schema_version: "1.0";
  items: CapabilityQueryItemV1[];
  next_cursor: string | null;
  source_watermark: string;
}

export interface CapabilityQuerySourceV1 {
  schema_version: "1.0";
  view: "search" | "list" | "status" | "detail";
  scope: "project" | "user";
  scope_identity_digest: string;
  discovery_generation_digest: string | null;
  capability_lock_digest: string | null;
  authority_head_digest: string;
  health_inventory_digest: string | null;
}

export interface PublicCapabilityInputStateV1 {
  declaration: CapabilityInputDeclarationV1;
  current:
    | { kind: "unset" }
    | { kind: "public"; value: string | number | boolean | null }
    | { kind: "private"; present: true };
}

export interface CapabilityBrowserDetailResponseV1 {
  schema_version: "1.0";
  item: CapabilityQueryItemV1;
  package_pin_digest: string;
  content_sha256: string;
  manifest_digest: string;
  inputs: PublicCapabilityInputStateV1[];
  input_schema_digest: string;
  source_watermark: string;
}
