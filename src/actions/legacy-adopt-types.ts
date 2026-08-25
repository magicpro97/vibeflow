import type { ActionTargetBindingV1, PackagePinV1 } from "./preview-types.js";
import type { CapabilityPermissionKindScopeV1 } from "./request-types.js";

export type LegacySourceV1 =
  | "skill-lock"
  | "tool-managed-evidence"
  | "mcp-managed-sidecar"
  | "hook-sentinel"
  | "role-marker";

export type LegacyEngineV1 = "claude" | "codex" | "copilot" | "opencode" | "antigravity";

interface LegacyComponentBaseV1 {
  component_id: string;
  targets: LegacyEngineV1[];
  required: boolean;
}

export type LegacySyntheticComponentV1 =
  | (LegacyComponentBaseV1 & {
      type: "skill";
      bundle_path: string;
      bundle_sha256: string;
    })
  | (LegacyComponentBaseV1 & {
      type: "mcp";
      transport: "stdio" | "http" | "sse";
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
      type: "tool";
      installer: {
        kind: "npm" | "bun" | "pipx" | "uv" | "go" | "cargo" | "download";
        coordinate: string;
        version: string;
        artifact_sha256: string;
        lifecycle_scripts: "disabled";
      };
      expected_binary: string;
      version_constraint: string;
    })
  | (LegacyComponentBaseV1 & {
      type: "hook";
      event: "pre-tool" | "post-tool" | "pre-commit" | "pre-push";
      vf_handler_id: string;
    })
  | (LegacyComponentBaseV1 & {
      type: "role";
      role_spec_path: string;
      role_spec_sha256: string;
    });

export interface LegacyManifestDependencyV1 {
  package_id: string;
  version_range: string;
  required_scope: "same" | "user-prerequisite";
}

export type LegacyDependencyBindingV1 =
  | {
      required_scope: "same";
      package_id: string;
      version: string;
      content_sha256: string;
    }
  | {
      required_scope: "user-prerequisite";
      package_id: string;
      version: string;
      content_sha256: string;
      required_health_plan_digest: string;
    };

export type LegacyManifestPermissionV1 = CapabilityPermissionKindScopeV1 & {
  permission_id: string;
  required_enforcement: "brokered" | "sandboxed" | "engine-enforced" | "disclosed-not-enforced";
};

export interface LegacySyntheticManifestV1 {
  schema_version: "1.0";
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
      os: "darwin" | "linux" | "win32";
      arch: "arm64" | "x64";
      libc: "glibc" | "musl" | null;
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
    kind:
      | "binary-version"
      | "file-hash"
      | "mcp-handshake"
      | "hook-selftest"
      | "role-parse"
      | "engine-config";
    required: boolean;
    timeout_ms: number;
    retries: 0 | 1 | 2;
  }>;
}

export interface StrictLegacyAdoptCandidateV1 {
  schema_version: "1.0";
  candidate_id: string;
  scope: "project" | "user";
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
