/**
 * Project entity vocabulary, file format, and asserts.
 *
 * A Project is the classification target for conversations (design:
 * `{ id, name, goal, context, repos[], engine, created_at }`). This module is the single
 * authority for the closed vocabularies and for the persisted document shape; the store
 * owns durability and the authority owns policy.
 */
import { resolve } from "node:path";
import { type Engine, isAgentEngine } from "../../core/agent-contract.js";

export const PROJECT_SCHEMA_VERSION = "1.0";
export type ProjectSchemaVersionV1 = typeof PROJECT_SCHEMA_VERSION;

/** Slug ids are lowercase ASCII with interior hyphens, max 64 characters. */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const PROJECT_NAME_MAX_LENGTH = 160;
export const PROJECT_GOAL_MAX_LENGTH = 4000;
export const PROJECT_CONTEXT_MAX_LENGTH = 16000;
export const PROJECT_REPO_MAX_LENGTH = 4096;
export const PROJECT_REPO_LIMIT = 64;

/** Reasoning effort vocabulary; mirrors the engine CLI's accepted `--thinking` levels. */
export const PROJECT_THINKING = Object.freeze({
  OFF: "off",
  MINIMAL: "minimal",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  XHIGH: "xhigh",
  MAX: "max",
  AUTO: "auto",
} as const);
export type ProjectThinking = (typeof PROJECT_THINKING)[keyof typeof PROJECT_THINKING];
export const PROJECT_THINKINGS: readonly ProjectThinking[] = Object.freeze(
  Object.values(PROJECT_THINKING),
);

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const isProjectThinking = (value: unknown): value is ProjectThinking =>
  memberOf(PROJECT_THINKINGS, value);

export class ProjectValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectValidationError";
  }
}

const invalid = (message: string): never => {
  throw new ProjectValidationError(message);
};

export interface ProjectEngineV1 {
  readonly cli: Engine;
  readonly model: string | null;
  readonly thinking: ProjectThinking;
}

export interface ProjectV1 {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly context: string;
  readonly repos: readonly string[];
  readonly engine: ProjectEngineV1;
  readonly created_at: string;
}

/** Persisted registry document. Written whole, atomically, on every mutation. */
export interface ProjectManifestV1 {
  readonly schema_version: ProjectSchemaVersionV1;
  readonly revision: number;
  readonly updated_at: string;
  readonly projects: readonly ProjectV1[];
}

/** The on-disk current-document name for {@link ProjectManifestV1}. */
export type ProjectRegistryCurrentV1 = ProjectManifestV1;

export function projectEmptyManifest(): ProjectManifestV1 {
  return Object.freeze({
    schema_version: PROJECT_SCHEMA_VERSION,
    revision: 0,
    updated_at: new Date(0).toISOString(),
    projects: Object.freeze([]) as readonly ProjectV1[],
  });
}

const EPHEMERAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function assertProjectTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !EPHEMERAL_ISO_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    return invalid(`project ${label} must be an ISO-8601 UTC timestamp`);
  return value;
}

export function assertProjectSlug(value: unknown): string {
  if (typeof value !== "string" || !PROJECT_SLUG_PATTERN.test(value))
    return invalid("project id must match ^[a-z0-9][a-z0-9-]{0,63}$");
  return value;
}

function assertBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum)
    return invalid(`project ${label} must be a non-empty string of at most ${maximum} characters`);
  return value;
}

function assertOptionalText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum)
    return invalid(`project ${label} must be a string of at most ${maximum} characters`);
  return value;
}

/**
 * Normalize a repo folder list: absolute paths, order-preserving dedupe, non-empty entries.
 * Relative entries resolve against the current process cwd (the import/folder-picker path).
 */
export function normalizeProjectRepos(value: unknown): string[] {
  if (!Array.isArray(value)) return invalid("project repos must be an array of paths");
  if (value.length > PROJECT_REPO_LIMIT) return invalid("project repos exceeds the entry limit");
  const seen = new Set<string>();
  const repos: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.trim().length === 0 ||
      entry.length > PROJECT_REPO_MAX_LENGTH
    )
      return invalid("project repo entries must be non-empty path strings");
    const absolute = resolve(entry);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    repos.push(absolute);
  }
  return repos;
}

export function assertProjectEngineV1(value: unknown): ProjectEngineV1 {
  if (typeof value !== "object" || value === null)
    return invalid("project engine must be an object");
  const engine = value as Partial<ProjectEngineV1>;
  if (!isAgentEngine(engine.cli)) return invalid("project engine cli is not a known agent engine");
  const model = engine.model ?? null;
  if (model !== null && typeof model !== "string")
    return invalid("project engine model must be a string or null");
  if (!isProjectThinking(engine.thinking))
    return invalid("project engine thinking is not a known level");
  return { cli: engine.cli, model, thinking: engine.thinking };
}

export function assertProjectV1(value: unknown): ProjectV1 {
  if (typeof value !== "object" || value === null)
    return invalid("project entry must be an object");
  const project = value as Partial<ProjectV1>;
  return {
    id: assertProjectSlug(project.id),
    name: assertBoundedString(project.name, "name", PROJECT_NAME_MAX_LENGTH),
    goal: assertOptionalText(project.goal, "goal", PROJECT_GOAL_MAX_LENGTH),
    context: assertOptionalText(project.context, "context", PROJECT_CONTEXT_MAX_LENGTH),
    repos: normalizeProjectRepos(project.repos),
    engine: assertProjectEngineV1(project.engine),
    created_at: assertProjectTimestamp(project.created_at, "created_at"),
  };
}

export function assertProjectManifestV1(value: unknown): ProjectManifestV1 {
  if (typeof value !== "object" || value === null)
    return invalid("project registry must be an object");
  const manifest = value as Partial<ProjectManifestV1>;
  if (manifest.schema_version !== PROJECT_SCHEMA_VERSION)
    return invalid("project registry schema version is unsupported");
  const revision = manifest.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0)
    return invalid("project registry revision must be a non-negative integer");
  if (!Array.isArray(manifest.projects))
    return invalid("project registry projects must be an array");
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    revision: revision as number,
    updated_at: assertProjectTimestamp(manifest.updated_at, "registry updated_at"),
    projects: manifest.projects.map((project) => assertProjectV1(project)),
  };
}
