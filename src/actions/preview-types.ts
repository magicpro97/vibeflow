import type { LegacySource } from "./capability-manifest-vocabulary-contract.js";
import type {
  ACTION_PACKAGE_PIN_SOURCE_KIND,
  ACTION_PREVIEW_PROJECTOR_VERSION,
  ACTION_TARGET_DISPOSITION_EXECUTION_VALUE,
  ActionConfigDiffMode,
  ActionDependencyChange,
  ActionEffectClass,
  ActionHealthPlanKind,
  ActionHealthPlanRetry,
  ActionPackagePinTrust,
  ActionPermissionChange,
  ActionPermissionEnforcement,
  ActionTargetManualReasonCode,
  ActionTargetRequiredUserActionReasonCode,
  ActionTargetUnsupportedReasonCode,
  Reversibility,
} from "./public-action-contract.js";
import type {
  PUBLIC_ACTION_TARGET_APPLY_FAILURE,
  PUBLIC_ACTION_TARGET_HEALTH_FAILURE,
  PUBLIC_ACTION_TARGET_SUBJECT_KIND,
  PublicActionTargetScopeV1,
} from "./public-operation-contract.js";
import type {
  ActionPlanningOptionsV1,
  CapabilityScope,
  EngineName,
  HostActionKind,
  JsonValue,
  RecoveryAction,
} from "./types.js";

export type ActionTargetV1 = {
  scope: PublicActionTargetScopeV1 & CapabilityScope;
  engine: EngineName | null;
  participant_id: string | null;
} & (
  | {
      required: true;
      on_apply_failure: typeof PUBLIC_ACTION_TARGET_APPLY_FAILURE.ABORT_SCOPE;
      on_health_failure: typeof PUBLIC_ACTION_TARGET_HEALTH_FAILURE.ABORT_SCOPE;
    }
  | {
      required: false;
      on_apply_failure: typeof PUBLIC_ACTION_TARGET_APPLY_FAILURE.OMIT_AFTER_ROLLBACK;
      on_health_failure:
        | typeof PUBLIC_ACTION_TARGET_HEALTH_FAILURE.OMIT_AFTER_ROLLBACK
        | typeof PUBLIC_ACTION_TARGET_HEALTH_FAILURE.COMMIT_DEGRADED;
    }
);
export interface ActionTargetBindingV1 {
  target_id: string;
  target: ActionTargetV1;
  subject:
    | {
        kind: typeof PUBLIC_ACTION_TARGET_SUBJECT_KIND.CONVERSATION;
        action_type: HostActionKind;
        participant_id: string | null;
      }
    | {
        kind: typeof PUBLIC_ACTION_TARGET_SUBJECT_KIND.CAPABILITY;
        package_id: string;
        component_id: string;
      };
}
export interface PackagePinV1 {
  id: string;
  version: string;
  source:
    | {
        kind: typeof ACTION_PACKAGE_PIN_SOURCE_KIND.REGISTRY;
        registry_origin: string;
        source_url: string;
        commit_oid: string | null;
        signature_envelope_digest: string;
      }
    | {
        kind: typeof ACTION_PACKAGE_PIN_SOURCE_KIND.GIT;
        canonical_url: string;
        commit_oid: string;
      }
    | {
        kind: typeof ACTION_PACKAGE_PIN_SOURCE_KIND.LOCAL_DEV;
        repo_relative_alias: string;
      }
    | {
        kind: typeof ACTION_PACKAGE_PIN_SOURCE_KIND.LEGACY_ADOPT;
        legacy_source: LegacySource;
        inspection_evidence_digest: string;
      };
  content_sha256: string;
  trust: ActionPackagePinTrust;
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
  | {
      target_id: string;
      execution: typeof ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.HOST;
      reason_code: null;
    }
  | {
      target_id: string;
      execution: typeof ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.MANUAL;
      reason_code: ActionTargetManualReasonCode;
    }
  | {
      target_id: string;
      execution: typeof ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.REQUIRED_USER_ACTION;
      reason_code: ActionTargetRequiredUserActionReasonCode;
    }
  | {
      target_id: string;
      execution: typeof ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.UNSUPPORTED;
      reason_code: ActionTargetUnsupportedReasonCode;
    };
export interface PublicPermissionDeltaV1 {
  permission_id: string;
  change: ActionPermissionChange;
  public_scope: string;
  enforcement: ActionPermissionEnforcement;
}
export interface PublicDependencyDeltaV1 {
  package_id: string;
  change: ActionDependencyChange;
  from_version: string | null;
  to_version: string | null;
}
export interface PublicConfigDiffV1 {
  target: string;
  target_ids: string[];
  mode: ActionConfigDiffMode;
  before_digest: string;
  after_digest: string;
  bounded_before: string | null;
  bounded_after: string | null;
}
export interface PublicEnforcementDisclosureV1 {
  permission_id: string;
  engine: EngineName;
  enforcement: ActionPermissionEnforcement;
  explanation: string;
}
export interface PublicHealthPlanV1 {
  probe_id: string;
  kind: ActionHealthPlanKind;
  evidence_schema_id: string;
  target_ids: string[];
  required: boolean;
  effect_classes: ActionEffectClass[];
  permission_ids: string[];
  enforcement_digest: string;
  timeout_ms: number;
  retries: ActionHealthPlanRetry;
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
  projector_version: typeof ACTION_PREVIEW_PROJECTOR_VERSION;
  rules_digest: string;
  redaction_manifest_digest: string;
}
