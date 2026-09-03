import {
  RUNTIME_PLATFORM,
  RUNTIME_PLATFORMS,
  type RuntimePlatform,
} from "../durability/process-identity-contract.js";
import {
  ACTION_HEALTH_PLAN_KIND,
  ACTION_PERMISSION_ENFORCEMENT_VALUE,
} from "./public-action-vocabulary-contract.js";

type ValueOf<Contract> = Contract[keyof Contract];

const values = <const Contract extends Readonly<Record<string, string>>>(contract: Contract) =>
  Object.freeze(Object.values(contract)) as readonly ValueOf<Contract>[];

const memberOf = <Value extends string>(items: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && items.some((candidate) => candidate === value);

export const CAPABILITY_MANIFEST_SCHEMA_VERSION = "1.0" as const;

export const CAPABILITY_MANIFEST_RUNTIME_ENFORCEMENT = ACTION_PERMISSION_ENFORCEMENT_VALUE;
export type CapabilityManifestRuntimeEnforcement = ValueOf<
  typeof CAPABILITY_MANIFEST_RUNTIME_ENFORCEMENT
>;
export const CAPABILITY_MANIFEST_RUNTIME_ENFORCEMENTS = values(
  CAPABILITY_MANIFEST_RUNTIME_ENFORCEMENT,
);

export const CAPABILITY_MANIFEST_PLATFORM_OS = RUNTIME_PLATFORM;
export type CapabilityManifestPlatformOs = RuntimePlatform;
export const CAPABILITY_MANIFEST_PLATFORM_OSES = RUNTIME_PLATFORMS;

export const CAPABILITY_MANIFEST_PLATFORM_ARCH = Object.freeze({
  ARM64: "arm64",
  X64: "x64",
} as const);
export type CapabilityManifestPlatformArch = ValueOf<typeof CAPABILITY_MANIFEST_PLATFORM_ARCH>;
export const CAPABILITY_MANIFEST_PLATFORM_ARCHES = values(CAPABILITY_MANIFEST_PLATFORM_ARCH);

export const CAPABILITY_MANIFEST_PLATFORM_LIBC = Object.freeze({
  GLIBC: "glibc",
  MUSL: "musl",
} as const);
export type CapabilityManifestPlatformLibc = ValueOf<typeof CAPABILITY_MANIFEST_PLATFORM_LIBC>;
export const CAPABILITY_MANIFEST_PLATFORM_LIBCS = values(CAPABILITY_MANIFEST_PLATFORM_LIBC);

export const CAPABILITY_MANIFEST_ICON_MEDIA_TYPE = Object.freeze({
  PNG: "image/png",
  WEBP: "image/webp",
} as const);
export type CapabilityManifestIconMediaType = ValueOf<typeof CAPABILITY_MANIFEST_ICON_MEDIA_TYPE>;
export const CAPABILITY_MANIFEST_ICON_MEDIA_TYPES = values(CAPABILITY_MANIFEST_ICON_MEDIA_TYPE);

export const CAPABILITY_MANIFEST_INSTALLER_KIND = Object.freeze({
  NPM: "npm",
  BUN: "bun",
  PIPX: "pipx",
  UV: "uv",
  GO: "go",
  CARGO: "cargo",
  DOWNLOAD: "download",
} as const);
export type CapabilityManifestInstallerKind = ValueOf<typeof CAPABILITY_MANIFEST_INSTALLER_KIND>;
export const CAPABILITY_MANIFEST_INSTALLER_KINDS = values(CAPABILITY_MANIFEST_INSTALLER_KIND);
export const CAPABILITY_MANIFEST_INSTALLER_LIFECYCLE_SCRIPTS = Object.freeze({
  DISABLED: "disabled",
} as const);
export type CapabilityManifestInstallerLifecycleScripts = ValueOf<
  typeof CAPABILITY_MANIFEST_INSTALLER_LIFECYCLE_SCRIPTS
>;

export const CAPABILITY_MANIFEST_COMPONENT_TYPE = Object.freeze({
  SKILL: "skill",
  MCP: "mcp",
  TOOL: "tool",
  HOOK: "hook",
  ROLE: "role",
  ENGINE_SETTING: "engine-setting",
} as const);
export type CapabilityManifestComponentType = ValueOf<typeof CAPABILITY_MANIFEST_COMPONENT_TYPE>;
export const CAPABILITY_MANIFEST_COMPONENT_TYPES = values(CAPABILITY_MANIFEST_COMPONENT_TYPE);

export const CAPABILITY_MANIFEST_MCP_TRANSPORT = Object.freeze({
  STDIO: "stdio",
  HTTP: "http",
  SSE: "sse",
} as const);
export type CapabilityManifestMcpTransport = ValueOf<typeof CAPABILITY_MANIFEST_MCP_TRANSPORT>;
export const CAPABILITY_MANIFEST_MCP_TRANSPORTS = values(CAPABILITY_MANIFEST_MCP_TRANSPORT);

export const CAPABILITY_MANIFEST_HOOK_EVENT = Object.freeze({
  PRE_TOOL: "pre-tool",
  POST_TOOL: "post-tool",
  PRE_COMMIT: "pre-commit",
  PRE_PUSH: "pre-push",
} as const);
export type CapabilityManifestHookEvent = ValueOf<typeof CAPABILITY_MANIFEST_HOOK_EVENT>;
export const CAPABILITY_MANIFEST_HOOK_EVENTS = values(CAPABILITY_MANIFEST_HOOK_EVENT);

export const CAPABILITY_MANIFEST_INPUT_TYPE = Object.freeze({
  STRING: "string",
  BOOLEAN: "boolean",
  INTEGER: "integer",
  ENUM: "enum",
  PROJECT_PATH: "project-path",
  SECRET_HANDLE: "secret-handle",
} as const);
export type CapabilityManifestInputType = ValueOf<typeof CAPABILITY_MANIFEST_INPUT_TYPE>;
export const CAPABILITY_MANIFEST_INPUT_TYPES = values(CAPABILITY_MANIFEST_INPUT_TYPE);

export const CAPABILITY_MANIFEST_DEPENDENCY_SCOPE = Object.freeze({
  SAME: "same",
  USER_PREREQUISITE: "user-prerequisite",
} as const);
export type CapabilityManifestDependencyScope = ValueOf<
  typeof CAPABILITY_MANIFEST_DEPENDENCY_SCOPE
>;
export const CAPABILITY_MANIFEST_DEPENDENCY_SCOPES = values(CAPABILITY_MANIFEST_DEPENDENCY_SCOPE);

export const CAPABILITY_MANIFEST_PERMISSION_KIND = Object.freeze({
  FILESYSTEM: "filesystem",
  NETWORK: "network",
  PROCESS: "process",
  SHELL: "shell",
  CONFIG: "config",
  SECRET: "secret",
  HOOK: "hook",
} as const);
export type CapabilityManifestPermissionKind = ValueOf<typeof CAPABILITY_MANIFEST_PERMISSION_KIND>;
export const CAPABILITY_MANIFEST_PERMISSION_KINDS = values(CAPABILITY_MANIFEST_PERMISSION_KIND);

export const CAPABILITY_MANIFEST_FILESYSTEM_ROOT = Object.freeze({
  PROJECT: "project",
  USER_HOME: "user-home",
} as const);
export type CapabilityManifestFilesystemRoot = ValueOf<typeof CAPABILITY_MANIFEST_FILESYSTEM_ROOT>;
export const CAPABILITY_MANIFEST_FILESYSTEM_ROOTS = values(CAPABILITY_MANIFEST_FILESYSTEM_ROOT);

export const CAPABILITY_MANIFEST_ACCESS = Object.freeze({
  READ: "read",
  WRITE: "write",
} as const);
export type CapabilityManifestAccess = ValueOf<typeof CAPABILITY_MANIFEST_ACCESS>;
export const CAPABILITY_MANIFEST_ACCESSES = values(CAPABILITY_MANIFEST_ACCESS);

export const CAPABILITY_MANIFEST_NETWORK_TRANSPORT = Object.freeze({
  HTTPS: "https",
  GIT_HTTPS: "git-https",
  MCP_HTTPS: "mcp-https",
} as const);
export type CapabilityManifestNetworkTransport = ValueOf<
  typeof CAPABILITY_MANIFEST_NETWORK_TRANSPORT
>;
export const CAPABILITY_MANIFEST_NETWORK_TRANSPORTS = values(CAPABILITY_MANIFEST_NETWORK_TRANSPORT);

export const CAPABILITY_MANIFEST_HEALTH_PROBE_KIND = ACTION_HEALTH_PLAN_KIND;
export type CapabilityManifestHealthProbeKind = ValueOf<
  typeof CAPABILITY_MANIFEST_HEALTH_PROBE_KIND
>;
export const CAPABILITY_MANIFEST_HEALTH_PROBE_KINDS = values(CAPABILITY_MANIFEST_HEALTH_PROBE_KIND);
export const CAPABILITY_MANIFEST_HEALTH_RETRIES = Object.freeze([0, 1, 2] as const);
export type CapabilityManifestHealthRetry = (typeof CAPABILITY_MANIFEST_HEALTH_RETRIES)[number];

export const LEGACY_SOURCE = Object.freeze({
  SKILL_LOCK: "skill-lock",
  TOOL_MANAGED_EVIDENCE: "tool-managed-evidence",
  MCP_MANAGED_SIDECAR: "mcp-managed-sidecar",
  HOOK_SENTINEL: "hook-sentinel",
  ROLE_MARKER: "role-marker",
} as const);
export type LegacySource = ValueOf<typeof LEGACY_SOURCE>;
export const LEGACY_SOURCES = values(LEGACY_SOURCE);
export const FILESYSTEM_LEGACY_SOURCES = Object.freeze([
  LEGACY_SOURCE.SKILL_LOCK,
  LEGACY_SOURCE.MCP_MANAGED_SIDECAR,
  LEGACY_SOURCE.HOOK_SENTINEL,
] as const);
export type FilesystemLegacySource = (typeof FILESYSTEM_LEGACY_SOURCES)[number];
export const LEGACY_SOURCE_ENGINE_SCOPED_PACKAGE_IDS = Object.freeze([
  LEGACY_SOURCE.MCP_MANAGED_SIDECAR,
  LEGACY_SOURCE.HOOK_SENTINEL,
  LEGACY_SOURCE.ROLE_MARKER,
] as const);

export const LEGACY_SOURCE_COMPONENT_TYPE = Object.freeze({
  [LEGACY_SOURCE.SKILL_LOCK]: CAPABILITY_MANIFEST_COMPONENT_TYPE.SKILL,
  [LEGACY_SOURCE.TOOL_MANAGED_EVIDENCE]: CAPABILITY_MANIFEST_COMPONENT_TYPE.TOOL,
  [LEGACY_SOURCE.MCP_MANAGED_SIDECAR]: CAPABILITY_MANIFEST_COMPONENT_TYPE.MCP,
  [LEGACY_SOURCE.HOOK_SENTINEL]: CAPABILITY_MANIFEST_COMPONENT_TYPE.HOOK,
  [LEGACY_SOURCE.ROLE_MARKER]: CAPABILITY_MANIFEST_COMPONENT_TYPE.ROLE,
} satisfies Readonly<Record<LegacySource, CapabilityManifestComponentType>>);

export const LEGACY_SOURCE_HEALTH_PROBE_KIND = Object.freeze({
  [LEGACY_SOURCE.SKILL_LOCK]: CAPABILITY_MANIFEST_HEALTH_PROBE_KIND.FILE_HASH,
  [LEGACY_SOURCE.TOOL_MANAGED_EVIDENCE]: CAPABILITY_MANIFEST_HEALTH_PROBE_KIND.BINARY_VERSION,
  [LEGACY_SOURCE.MCP_MANAGED_SIDECAR]: CAPABILITY_MANIFEST_HEALTH_PROBE_KIND.MCP_HANDSHAKE,
  [LEGACY_SOURCE.HOOK_SENTINEL]: CAPABILITY_MANIFEST_HEALTH_PROBE_KIND.HOOK_SELFTEST,
  [LEGACY_SOURCE.ROLE_MARKER]: CAPABILITY_MANIFEST_HEALTH_PROBE_KIND.ROLE_PARSE,
} satisfies Readonly<Record<LegacySource, CapabilityManifestHealthProbeKind>>);

export const LEGACY_SOURCE_PACKAGE_ID_PREFIX = Object.freeze({
  [LEGACY_SOURCE.SKILL_LOCK]: "legacy.skill.",
  [LEGACY_SOURCE.TOOL_MANAGED_EVIDENCE]: "legacy.tool.",
  [LEGACY_SOURCE.MCP_MANAGED_SIDECAR]: "legacy.mcp.",
  [LEGACY_SOURCE.HOOK_SENTINEL]: "legacy.hook.",
  [LEGACY_SOURCE.ROLE_MARKER]: "legacy.role.",
} satisfies Readonly<Record<LegacySource, string>>);

export const LEGACY_SOURCE_RECORD_KIND = Object.freeze({
  [LEGACY_SOURCE.SKILL_LOCK]: "lock",
  [LEGACY_SOURCE.TOOL_MANAGED_EVIDENCE]: "descriptor",
  [LEGACY_SOURCE.MCP_MANAGED_SIDECAR]: "managed-sidecar",
  [LEGACY_SOURCE.HOOK_SENTINEL]: "sentinel",
  [LEGACY_SOURCE.ROLE_MARKER]: "renderer-marker",
} as const satisfies Readonly<Record<LegacySource, string>>);
export type LegacySourceRecordKind = ValueOf<typeof LEGACY_SOURCE_RECORD_KIND>;

export const isCapabilityManifestPlatformOs = (
  value: unknown,
): value is CapabilityManifestPlatformOs => memberOf(CAPABILITY_MANIFEST_PLATFORM_OSES, value);
export const isCapabilityManifestPlatformArch = (
  value: unknown,
): value is CapabilityManifestPlatformArch => memberOf(CAPABILITY_MANIFEST_PLATFORM_ARCHES, value);
export const isCapabilityManifestPlatformLibc = (
  value: unknown,
): value is CapabilityManifestPlatformLibc => memberOf(CAPABILITY_MANIFEST_PLATFORM_LIBCS, value);
export const isLegacySource = (value: unknown): value is LegacySource =>
  memberOf(LEGACY_SOURCES, value);
export const isFilesystemLegacySource = (value: unknown): value is FilesystemLegacySource =>
  memberOf(FILESYSTEM_LEGACY_SOURCES, value);
