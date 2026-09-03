import type {
  CAPABILITY_MANIFEST_COMPONENT_TYPE,
  CAPABILITY_MANIFEST_PERMISSION_KIND,
  CAPABILITY_MANIFEST_SCHEMA_VERSION,
  CapabilityManifestAccess,
  CapabilityManifestDependencyScope,
  CapabilityManifestFilesystemRoot,
  CapabilityManifestHealthProbeKind,
  CapabilityManifestHealthRetry,
  CapabilityManifestHookEvent,
  CapabilityManifestIconMediaType,
  CapabilityManifestInputType,
  CapabilityManifestInstallerKind,
  CapabilityManifestInstallerLifecycleScripts,
  CapabilityManifestMcpTransport,
  CapabilityManifestNetworkTransport,
  CapabilityManifestPlatformArch,
  CapabilityManifestPlatformLibc,
  CapabilityManifestPlatformOs,
  CapabilityManifestRuntimeEnforcement,
} from "../../actions/capability-manifest-vocabulary-contract.js";
import type { EngineName, JsonScalar } from "../../actions/types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";

export type { CapabilityScope } from "../../core/capability-contract.js";
export type RuntimeEnforcementV1 = CapabilityManifestRuntimeEnforcement;
export type VersionRangeV1 = string;

export interface PlatformConstraintV1 {
  os: CapabilityManifestPlatformOs;
  arch: CapabilityManifestPlatformArch;
  libc: CapabilityManifestPlatformLibc | null;
}

export interface CapabilityMetadataV1 {
  display_name: string;
  summary: string;
  homepage_url: string | null;
  documentation_url: string | null;
  icon: {
    relative_path: string;
    sha256: string;
    media_type: CapabilityManifestIconMediaType;
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
  kind: CapabilityManifestInstallerKind;
  coordinate: string;
  version: string;
  artifact_sha256: string;
  lifecycle_scripts: CapabilityManifestInstallerLifecycleScripts;
}

export type CapabilityTemplateValueV1 =
  | JsonScalar
  | CapabilityTemplateValueV1[]
  | { [key: string]: CapabilityTemplateValueV1 }
  | { input_ref: string };
export type CapabilityStringValueV1 = string | { input_ref: string };

export type CapabilityComponentV1 = CapabilityComponentBaseV1 &
  (
    | {
        type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.SKILL;
        bundle_path: string;
        bundle_sha256: string;
      }
    | {
        type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.MCP;
        transport: CapabilityManifestMcpTransport;
        executable?: PackageExecutableRefV1;
        args?: CapabilityStringValueV1[];
        url?: CapabilityStringValueV1;
        secret_slots?: string[];
      }
    | {
        type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.TOOL;
        installer: HostInstallerSpecV1;
        expected_binary: string;
        version_constraint: string;
      }
    | {
        type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.HOOK;
        event: CapabilityManifestHookEvent;
        vf_handler_id: string;
      }
    | {
        type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.ROLE;
        role_spec_path: string;
        role_spec_sha256: string;
      }
    | {
        type: typeof CAPABILITY_MANIFEST_COMPONENT_TYPE.ENGINE_SETTING;
        setting_id: string;
        value: CapabilityTemplateValueV1;
      }
  );

export interface CapabilityInputDeclarationV1 {
  input_id: string;
  label: string;
  type: CapabilityManifestInputType;
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
  required_scope: CapabilityManifestDependencyScope;
}

export interface CapabilityConflictV1 {
  package_id: string;
  version_range: string | null;
  reason: string;
}

export type CapabilityPermissionKindScopeV1 =
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.FILESYSTEM;
      scope: {
        root: CapabilityManifestFilesystemRoot;
        access: CapabilityManifestAccess;
        path_prefix: string;
      };
    }
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.NETWORK;
      scope: {
        transport: CapabilityManifestNetworkTransport;
        host: string;
        port: number | null;
        path_prefix: string;
      };
    }
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.PROCESS;
      scope: { executable_class: string; argv_prefix: string[]; allow_additional_args: boolean };
    }
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.SHELL;
      scope: { adapter_id: string; template_id: string };
    }
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.CONFIG;
      scope: {
        engine: EngineName;
        namespace: string;
        access: CapabilityManifestAccess;
        key_prefix: string;
      };
    }
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.SECRET;
      scope: { input_ids: string[] };
    }
  | {
      kind: typeof CAPABILITY_MANIFEST_PERMISSION_KIND.HOOK;
      scope: { engine: EngineName; hook_point: string; participant_id: string | null };
    };

export type CapabilityPermissionV1 = CapabilityPermissionKindScopeV1 & {
  permission_id: string;
  required_enforcement: RuntimeEnforcementV1;
};

export interface CapabilityHealthDeclarationV1 {
  probe_id: string;
  component_ids: string[];
  kind: CapabilityManifestHealthProbeKind;
  required: boolean;
  timeout_ms: number;
  retries: CapabilityManifestHealthRetry;
}

export interface CapabilityManifestV1 {
  schema_version: typeof CAPABILITY_MANIFEST_SCHEMA_VERSION;
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
