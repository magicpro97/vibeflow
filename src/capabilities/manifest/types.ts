import type { EngineName, JsonScalar } from "../../actions/types.js";

export type CapabilityScope = "project" | "user";
export type RuntimeEnforcementV1 =
  | "brokered"
  | "sandboxed"
  | "engine-enforced"
  | "disclosed-not-enforced";
export type VersionRangeV1 = string;

export interface PlatformConstraintV1 {
  os: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  libc: "glibc" | "musl" | null;
}

export interface CapabilityMetadataV1 {
  display_name: string;
  summary: string;
  homepage_url: string | null;
  documentation_url: string | null;
  icon: {
    relative_path: string;
    sha256: string;
    media_type: "image/png" | "image/webp";
  } | null;
}

export interface CapabilityComponentBaseV1 {
  component_id: string;
  targets: EngineName[];
  required: boolean;
}

export interface PackageExecutableRefV1 {
  component_id: string;
  relative_path: string;
  sha256: string;
}

export interface HostInstallerSpecV1 {
  kind: "npm" | "bun" | "pipx" | "uv" | "go" | "cargo" | "download";
  coordinate: string;
  version: string;
  artifact_sha256: string;
  lifecycle_scripts: "disabled";
}

export type CapabilityTemplateValueV1 =
  | JsonScalar
  | CapabilityTemplateValueV1[]
  | { [key: string]: CapabilityTemplateValueV1 }
  | { input_ref: string };
export type CapabilityStringValueV1 = string | { input_ref: string };

export type CapabilityComponentV1 = CapabilityComponentBaseV1 &
  (
    | { type: "skill"; bundle_path: string; bundle_sha256: string }
    | {
        type: "mcp";
        transport: "stdio" | "http" | "sse";
        executable?: PackageExecutableRefV1;
        args?: CapabilityStringValueV1[];
        url?: CapabilityStringValueV1;
        secret_slots?: string[];
      }
    | {
        type: "tool";
        installer: HostInstallerSpecV1;
        expected_binary: string;
        version_constraint: string;
      }
    | {
        type: "hook";
        event: "pre-tool" | "post-tool" | "pre-commit" | "pre-push";
        vf_handler_id: string;
      }
    | { type: "role"; role_spec_path: string; role_spec_sha256: string }
    | { type: "engine-setting"; setting_id: string; value: CapabilityTemplateValueV1 }
  );

export interface CapabilityInputDeclarationV1 {
  input_id: string;
  label: string;
  type: "string" | "boolean" | "integer" | "enum" | "project-path" | "secret-handle";
  required: boolean;
  default_value: JsonScalar;
  enum_values: string[];
  min: number | null;
  max: number | null;
  pattern: string | null;
}

export interface CapabilityDependencyV1 {
  package_id: string;
  version_range: string;
  required_scope: "same" | "user-prerequisite";
}

export interface CapabilityConflictV1 {
  package_id: string;
  version_range: string | null;
  reason: string;
}

export type CapabilityPermissionKindScopeV1 =
  | {
      kind: "filesystem";
      scope: { root: "project" | "user-home"; access: "read" | "write"; path_prefix: string };
    }
  | {
      kind: "network";
      scope: {
        transport: "https" | "git-https" | "mcp-https";
        host: string;
        port: number | null;
        path_prefix: string;
      };
    }
  | {
      kind: "process";
      scope: { executable_class: string; argv_prefix: string[]; allow_additional_args: boolean };
    }
  | { kind: "shell"; scope: { adapter_id: string; template_id: string } }
  | {
      kind: "config";
      scope: {
        engine: EngineName;
        namespace: string;
        access: "read" | "write";
        key_prefix: string;
      };
    }
  | { kind: "secret"; scope: { input_ids: string[] } }
  | {
      kind: "hook";
      scope: { engine: EngineName; hook_point: string; participant_id: string | null };
    };

export type CapabilityPermissionV1 = CapabilityPermissionKindScopeV1 & {
  permission_id: string;
  required_enforcement: RuntimeEnforcementV1;
};

export interface CapabilityHealthDeclarationV1 {
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
}

export interface CapabilityManifestV1 {
  schema_version: "1.0";
  id: string;
  version: string;
  metadata: CapabilityMetadataV1;
  compatibility: {
    vf: VersionRangeV1;
    engines: Partial<Record<EngineName, VersionRangeV1>>;
    platforms?: PlatformConstraintV1[];
  };
  components: CapabilityComponentV1[];
  dependencies: CapabilityDependencyV1[];
  conflicts: CapabilityConflictV1[];
  permissions: CapabilityPermissionV1[];
  inputs: CapabilityInputDeclarationV1[];
  health: CapabilityHealthDeclarationV1[];
}

export interface ValidatedCapabilityManifestV1 {
  manifest: CapabilityManifestV1;
  manifest_digest: string;
  canonical_bytes: Buffer;
  source_bytes: Buffer;
}
