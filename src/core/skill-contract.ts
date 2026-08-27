/** Dependency-free skill lifecycle vocabulary shared by core, audit, and browser projections. */
const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const SKILL_STATUS = Object.freeze({
  VERIFIED: "verified",
  ENRICHED: "enriched",
  EXPERIMENTAL: "experimental",
  BASELINE: "baseline",
  TEMPLATE: "template",
  DRAFT: "draft",
  UNVERIFIED: "unverified",
  DEPRECATED: "deprecated",
} as const);

export type SkillStatus = (typeof SKILL_STATUS)[keyof typeof SKILL_STATUS];
export const SKILL_STATUSES = Object.freeze(Object.values(SKILL_STATUS));

export const SKILL_SOURCE = Object.freeze({
  REPO: "repo",
  SHARED: "shared",
  BUILTIN: "builtin",
} as const);

export type SkillSource = (typeof SKILL_SOURCE)[keyof typeof SKILL_SOURCE];
export const SKILL_SOURCES = Object.freeze(Object.values(SKILL_SOURCE));

export const SKILL_SCOPE = Object.freeze({
  COMMON: "common",
  ORGANIZATION: "organization",
  PROJECT: "project",
  ADAPTER: "adapter",
} as const);
export type SkillScope = (typeof SKILL_SCOPE)[keyof typeof SKILL_SCOPE];
export const SKILL_SCOPES = Object.freeze(Object.values(SKILL_SCOPE));

export const SKILL_TYPE = Object.freeze({
  REPO: "repo",
  KNOWLEDGE: "knowledge",
} as const);
export type SkillType = (typeof SKILL_TYPE)[keyof typeof SKILL_TYPE];
export const SKILL_TYPES = Object.freeze(Object.values(SKILL_TYPE));

export const SKILL_FILESYSTEM_REQUIREMENT = Object.freeze({
  READ: "read",
  WRITE: "write",
  NONE: "none",
} as const);
export type SkillFilesystemRequirement =
  (typeof SKILL_FILESYSTEM_REQUIREMENT)[keyof typeof SKILL_FILESYSTEM_REQUIREMENT];
export const SKILL_FILESYSTEM_REQUIREMENTS = Object.freeze(
  Object.values(SKILL_FILESYSTEM_REQUIREMENT),
);

export const SKILL_MCP_TRANSPORT = Object.freeze({
  STDIO: "stdio",
  HTTP: "http",
  SSE: "sse",
} as const);
export type SkillMcpTransport = (typeof SKILL_MCP_TRANSPORT)[keyof typeof SKILL_MCP_TRANSPORT];
export const SKILL_MCP_TRANSPORTS = Object.freeze(Object.values(SKILL_MCP_TRANSPORT));

export const SKILL_DOMAIN_ROLE = Object.freeze({
  CANONICAL: "canonical",
  CHILD: "child",
} as const);
export type SkillDomainRole = (typeof SKILL_DOMAIN_ROLE)[keyof typeof SKILL_DOMAIN_ROLE];
export const SKILL_DOMAIN_ROLES = Object.freeze(Object.values(SKILL_DOMAIN_ROLE));

export const SKILL_FRESHNESS = Object.freeze({
  FRESH: "fresh",
  STALE: "stale",
  UNKNOWN: "unknown",
} as const);
export type SkillFreshness = (typeof SKILL_FRESHNESS)[keyof typeof SKILL_FRESHNESS];
export const SKILL_FRESHNESS_VALUES = Object.freeze(Object.values(SKILL_FRESHNESS));

export const isSkillStatus = (value: unknown): value is SkillStatus =>
  memberOf(SKILL_STATUSES, value);

export const isSkillSource = (value: unknown): value is SkillSource =>
  memberOf(SKILL_SOURCES, value);

export const isSkillScope = (value: unknown): value is SkillScope => memberOf(SKILL_SCOPES, value);
export const isSkillType = (value: unknown): value is SkillType => memberOf(SKILL_TYPES, value);
export const isSkillFilesystemRequirement = (value: unknown): value is SkillFilesystemRequirement =>
  memberOf(SKILL_FILESYSTEM_REQUIREMENTS, value);
export const isSkillMcpTransport = (value: unknown): value is SkillMcpTransport =>
  memberOf(SKILL_MCP_TRANSPORTS, value);
export const isSkillDomainRole = (value: unknown): value is SkillDomainRole =>
  memberOf(SKILL_DOMAIN_ROLES, value);
export const isSkillFreshness = (value: unknown): value is SkillFreshness =>
  memberOf(SKILL_FRESHNESS_VALUES, value);
