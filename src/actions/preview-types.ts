import type {
  ActionEffectClass,
  ActionPlanningOptionsV1,
  CapabilityScope,
  EngineName,
  HostActionKind,
  JsonValue,
  RecoveryAction,
  Reversibility,
} from "./types.js";

export type ActionTargetV1 = {
  scope: CapabilityScope;
  engine: EngineName | null;
  participant_id: string | null;
} & (
  | { required: true; on_apply_failure: "abort-scope"; on_health_failure: "abort-scope" }
  | {
      required: false;
      on_apply_failure: "omit-after-rollback";
      on_health_failure: "omit-after-rollback" | "commit-degraded";
    }
);
export interface ActionTargetBindingV1 {
  target_id: string;
  target: ActionTargetV1;
  subject:
    | { kind: "conversation"; action_type: HostActionKind; participant_id: string | null }
    | { kind: "capability"; package_id: string; component_id: string };
}
export interface PackagePinV1 {
  id: string;
  version: string;
  source:
    | {
        kind: "registry";
        registry_origin: string;
        source_url: string;
        commit_oid: string | null;
        signature_envelope_digest: string;
      }
    | { kind: "git"; canonical_url: string; commit_oid: string }
    | { kind: "local-dev"; repo_relative_alias: string }
    | {
        kind: "legacy-adopt";
        legacy_source:
          | "skill-lock"
          | "tool-managed-evidence"
          | "mcp-managed-sidecar"
          | "hook-sentinel"
          | "role-marker";
        inspection_evidence_digest: string;
      };
  content_sha256: string;
  trust: "verified" | "source-pinned" | "dev-unverified" | "legacy-verified";
  nonportable: boolean;
  pin_digest: string;
}
export interface PublicPackagePinV1 {
  id: string;
  version: string;
  source_kind: PackagePinV1["source"]["kind"];
  content_sha256: string;
  trust: PackagePinV1["trust"];
  nonportable: boolean;
  pin_digest: string;
}
export interface PublicReviewFieldV1 {
  json_pointer: string;
  label: string;
  before: JsonValue;
  after: JsonValue;
  private_binding_digest: string | null;
}
export type CapabilityTargetDispositionV1 =
  | { target_id: string; execution: "host"; reason_code: null }
  | {
      target_id: string;
      execution: "manual";
      reason_code: "manual-config-change" | "manual-runtime-setup" | "disclosed-not-enforced";
    }
  | {
      target_id: string;
      execution: "required-user-action";
      reason_code: "native-install-required" | "external-confirmation-required";
    }
  | {
      target_id: string;
      execution: "unsupported";
      reason_code: "adapter-unavailable" | "enforcement-unavailable" | "target-unsupported";
    };
export interface PublicPermissionDeltaV1 {
  permission_id: string;
  change: "add" | "remove" | "expand" | "narrow" | "unchanged";
  public_scope: string;
  enforcement: "brokered" | "sandboxed" | "engine-enforced" | "disclosed-not-enforced";
}
export interface PublicDependencyDeltaV1 {
  package_id: string;
  change: "add" | "remove" | "update" | "unchanged";
  from_version: string | null;
  to_version: string | null;
}
export interface PublicConfigDiffV1 {
  target: string;
  target_ids: string[];
  mode: "surgical" | "full-file" | "manual";
  before_digest: string;
  after_digest: string;
  bounded_before: string | null;
  bounded_after: string | null;
}
export interface PublicEnforcementDisclosureV1 {
  permission_id: string;
  engine: EngineName;
  enforcement: "brokered" | "sandboxed" | "engine-enforced" | "disclosed-not-enforced";
  explanation: string;
}
export interface PublicHealthPlanV1 {
  probe_id: string;
  kind:
    | "binary-version"
    | "file-hash"
    | "mcp-handshake"
    | "hook-selftest"
    | "role-parse"
    | "engine-config";
  evidence_schema_id: string;
  target_ids: string[];
  required: boolean;
  effect_classes: ActionEffectClass[];
  permission_ids: string[];
  enforcement_digest: string;
  timeout_ms: number;
  retries: 0 | 1 | 2;
  evidence_valid_for_ms: number;
}
export interface HostRenderedPreviewV1 {
  title: string;
  summary: string;
  action_type: HostActionKind;
  planning_options: ActionPlanningOptionsV1;
  review_fields: PublicReviewFieldV1[];
  targets: ActionTargetBindingV1[];
  target_dispositions: CapabilityTargetDispositionV1[];
  package_pins: PublicPackagePinV1[];
  permission_delta: PublicPermissionDeltaV1[];
  dependency_delta: PublicDependencyDeltaV1[];
  config_diffs: PublicConfigDiffV1[];
  effect_classes: ActionEffectClass[];
  enforcement: PublicEnforcementDisclosureV1[];
  reversibility: Reversibility;
  health_plan: PublicHealthPlanV1[];
  recovery_actions: RecoveryAction[];
  projector_version: "vf-public-projector/1";
  rules_digest: string;
  redaction_manifest_digest: string;
}
