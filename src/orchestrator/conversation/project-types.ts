/**
 * Project entity vocabulary, file format, and asserts.
 *
 * A Project is the classification target for conversations (design:
 * `{ id, name, goal, context, repos[], engine, created_at }`). This module is the single
 * authority for the persisted document shape; the store owns durability and the authority
 * owns policy.
 *
 * NOTE(privacy, Task 3/5): `repos[]` holds ABSOLUTE filesystem paths and `goal`/`context`
 * are free-form operator text. Nothing here is public: any DTO, SSE frame, log line, or UI
 * payload built from a Project must pass through `sanitizePublicText` (or a stricter path
 * policy) first — never project `repos` raw, or `$HOME` layout leaks.
 */
import { resolve } from "node:path";
import { isExactWireTimestamp } from "../../actions/public-wire-primitives.js";
import { type Engine, isAgentEngine } from "../../core/agent-contract.js";
import { CONVERSATION_DEFAULT_PROJECT_ID } from "./conversation-catalog-contract.js";

export const PROJECT_SCHEMA_VERSION = "1.0";
export type ProjectSchemaVersionV1 = typeof PROJECT_SCHEMA_VERSION;

/** Slug ids are lowercase ASCII with interior hyphens, max 64 characters. */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Ids the registry must never hold. `idea` is the conversation fallback for an unclassified
 * conversation (see `CONVERSATION_DEFAULT_PROJECT_ID`), resolved *before* the registry
 * lookup, so a real project with that id would be indistinguishable from "no project" and
 * would survive its own deletion. Reserved everywhere — write and read alike — so the
 * invariant cannot be reintroduced by hand-editing the document.
 */
export const PROJECT_RESERVED_IDS: readonly string[] = Object.freeze([
  CONVERSATION_DEFAULT_PROJECT_ID,
]);

export const PROJECT_NAME_MAX_LENGTH = 160;
export const PROJECT_GOAL_MAX_LENGTH = 4000;
export const PROJECT_CONTEXT_MAX_LENGTH = 16000;
export const PROJECT_REPO_MAX_LENGTH = 4096;
export const PROJECT_REPO_LIMIT = 64;
/**
 * Sanity bound on registry entry count, matching {@link PROJECT_REPO_LIMIT} in spirit; the
 * store's `MAX_PROJECT_REGISTRY_BYTES` remains the byte truth for the document itself.
 */
export const PROJECT_LIMIT = 256;

/**
 * Reasoning-effort label forwarded verbatim to the engine CLI. There is no in-repo authority
 * for this vocabulary yet (no dispatch surface consumes it; Claude Code exposes
 * `--effort low|medium|high|xhigh|max` while other engines differ), so it stays bounded text
 * rather than a closed set that would reject a value an engine actually accepts.
 */
export const PROJECT_THINKING_MAX_LENGTH = 64;

/**
 * Bound on a model identifier. Models are opaque, engine-owned names (not reasoning labels), so
 * they get their own bound rather than reusing {@link PROJECT_THINKING_MAX_LENGTH}: the two
 * fields are unrelated, and a shared cap would silently make one of them wrong if either moves.
 * Matches the binding preview's own `200`-byte sanity limit in spirit, in characters.
 */
export const PROJECT_MODEL_MAX_LENGTH = 200;

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
  readonly thinking: string;
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

/**
 * Canonical millisecond ISO-8601 UTC, via the repo's single wire-timestamp predicate: the
 * shape regex alone accepts rollover dates (`2026-02-30…`) and non-canonical offsets.
 */
export function assertProjectTimestamp(value: unknown, label: string): string {
  if (!isExactWireTimestamp(value))
    return invalid(`project ${label} must be an ISO-8601 UTC timestamp`);
  return value;
}

export function assertProjectSlug(value: unknown): string {
  if (typeof value !== "string" || !PROJECT_SLUG_PATTERN.test(value))
    return invalid("project id must match ^[a-z0-9][a-z0-9-]{0,63}$");
  if (PROJECT_RESERVED_IDS.includes(value))
    return invalid(`project id ${value} is reserved for the unclassified conversation fallback`);
  return value;
}

function assertBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum)
    return invalid(`project ${label} must be a non-empty string of at most ${maximum} characters`);
  return value;
}

/**
 * Free-form text that may legitimately be empty, so writes reject whitespace-only input
 * while reads accept whatever an older document already holds.
 */
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
  return {
    cli: engine.cli,
    model,
    thinking: assertBoundedString(engine.thinking, "engine thinking", PROJECT_THINKING_MAX_LENGTH),
  };
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

/**
 * Validate a whole registry project list. Used on read and again on the exact list a
 * mutator hands the store, so an entry-count blowup or a bypassed field check fails closed
 * before the compare-and-swap instead of reaching disk.
 */
export function assertProjectCollectionV1(value: unknown): ProjectV1[] {
  if (!Array.isArray(value)) return invalid("project registry projects must be an array");
  if (value.length > PROJECT_LIMIT)
    return invalid(`project registry exceeds the ${PROJECT_LIMIT}-project limit`);
  return value.map((project) => assertProjectV1(project));
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
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    revision: revision as number,
    updated_at: assertProjectTimestamp(manifest.updated_at, "registry updated_at"),
    projects: assertProjectCollectionV1(manifest.projects),
  };
}
