import type { Engine } from "../core/agent-contract.js";
import type { CapabilityScope } from "../core/capability-contract.js";
import type {
  CAPABILITY_MANIFEST_COMPONENT_TYPE,
  CAPABILITY_MANIFEST_DEPENDENCY_SCOPE,
  CAPABILITY_MANIFEST_SCHEMA_VERSION,
  CapabilityManifestDependencyScope,
  CapabilityManifestHealthProbeKind,
  CapabilityManifestHealthRetry,
  CapabilityManifestHookEvent,
  CapabilityManifestInstallerKind,
  CapabilityManifestInstallerLifecycleScripts,
  CapabilityManifestMcpTransport,
  CapabilityManifestPlatformArch,
  CapabilityManifestPlatformLibc,
  CapabilityManifestPlatformOs,
  CapabilityManifestRuntimeEnforcement,
  LegacySource,
} from "./capability-manifest-vocabulary-contract.js";
import type { ActionTargetBindingV1, PackagePinV1 } from "./preview-types.js";
import type { CapabilityPermissionKindScopeV1 } from "./request-types.js";

export type LegacySourceV1 = LegacySource;

/** Compatibility alias for persisted legacy-adoption records. */
export type LegacyEngineV1 = Engine;

interface LegacyComponentBaseV1 {
  component_id: string;
  targets: LegacyEngineV1[];
  required: boolean;
}

export type LegacySyntheticComponentV1 =
  | (LegacyComponentBaseV1 & {
      type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.SKILL;
      bundle_path: string;
      bundle_sha256: string;
    })
  | (LegacyComponentBaseV1 & {
      type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.MCP;
      transport: CapabilityManifestMcpTransport;
      executable?: {
        component_id: string;
        relative_path: string;
        sha256: string;
      };
      args?: Array<string | { input_ref: string }>;
      url?: string | { input_ref: string };
      secret_slots?: string[];
    })
  | (LegacyComponentBaseV1 & {
      type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.TOOL;
      installer: {
        kind: CapabilityManifestInstallerKind;
        coordinate: string;
        version: string;
        artifact_sha256: string;
        lifecycle_scripts: CapabilityManifestInstallerLifecycleScripts;
      };
      expected_binary: string;
      version_constraint: string;
    })
  | (LegacyComponentBaseV1 & {
      type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.HOOK;
      event: CapabilityManifestHookEvent;
      vf_handler_id: string;
    })
  | (LegacyComponentBaseV1 & {
      type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.ROLE;
      role_spec_path: string;
      role_spec_sha256: string;
    });

export interface LegacyManifestDependencyV1 {
  package_id: string;
  version_range: string;
  required_scope: CapabilityManifestDependencyScope;
}

export type LegacyDependencyBindingV1 =
  | {
      required_scope: typeof CAPABILITY_MANIFEST_DEPENDENCY_SCOPE.SAME;
      package_id: string;
      version: string;
      content_sha256: string;
    }
  | {
      required_scope: typeof CAPABILITY_MANIFEST_DEPENDENCY_SCOPE.USER_PREREQUISITE;
      package_id: string;
      version: string;
      content_sha256: string;
      required_health_plan_digest: string;
    };

export type LegacyManifestPermissionV1 = CapabilityPermissionKindScopeV1 & {
  permission_id: string;
  required_enforcement: CapabilityManifestRuntimeEnforcement;
};

export interface LegacySyntheticManifestV1 {
  schema_version: typeof CAPABILITY_MANIFEST_SCHEMA_VERSION;
  id: string;
  version: string;
  metadata: {
    display_name: string;
    summary: string;
    homepage_url: null;
    documentation_url: null;
    icon: null;
  };
  compatibility: {
    vf: string;
    engines: Partial<Record<LegacyEngineV1, string>>;
    platforms?: Array<{
      os: CapabilityManifestPlatformOs;
      arch: CapabilityManifestPlatformArch;
      libc: CapabilityManifestPlatformLibc | null;
    }>;
  };
  components: LegacySyntheticComponentV1[];
  dependencies: LegacyManifestDependencyV1[];
  conflicts: [];
  permissions: LegacyManifestPermissionV1[];
  inputs: [];
  health: Array<{
    probe_id: string;
    component_ids: string[];
    kind: CapabilityManifestHealthProbeKind;
    required: boolean;
    timeout_ms: number;
    retries: CapabilityManifestHealthRetry;
  }>;
}

export interface StrictLegacyAdoptCandidateV1 {
  schema_version: typeof CAPABILITY_MANIFEST_SCHEMA_VERSION;
  candidate_id: string;
  scope: CapabilityScope;
  scope_identity_digest: string;
  legacy_source: LegacySourceV1;
  synthetic_manifest: LegacySyntheticManifestV1;
  synthetic_pin: PackagePinV1;
  permissions: LegacyManifestPermissionV1[];
  dependencies: LegacyDependencyBindingV1[];
  targets: ActionTargetBindingV1[];
  owned_resources: Array<{
    ownership_key: string;
    public_target: string;
    expected_preimage_sha256: string;
  }>;
  inspection_evidence_digest: string;
  inspected_at: string;
  expires_at: string;
  candidate_digest: string;
}
