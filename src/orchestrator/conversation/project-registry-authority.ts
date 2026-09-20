/**
 * Project registry policy: the only sanctioned way to mutate the registry.
 *
 * Every mutation validates the request, reloads the latest manifest, and persists through
 * {@link ProjectRegistryStore}, so duplicate ids and invalid slugs can never reach disk.
 */
import { ProjectRegistryStore } from "./project-registry-store.js";
import {
  PROJECT_CONTEXT_MAX_LENGTH,
  PROJECT_GOAL_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type ProjectV1,
  ProjectValidationError,
  assertProjectEngineV1,
  assertProjectSlug,
  normalizeProjectRepos,
} from "./project-types.js";

/** Request engines may omit `model`; the authority materializes it as `null`. */
export type ProjectEngineRequestV1 = Omit<ProjectV1["engine"], "model"> & {
  readonly model?: string | null;
};

export interface ProjectCreateRequestV1 {
  readonly id: string;
  readonly name: string;
  readonly goal?: string;
  readonly context?: string;
  readonly repos?: readonly string[];
  readonly engine: ProjectEngineRequestV1;
}

export type ProjectUpdateRequestV1 = Partial<Omit<ProjectCreateRequestV1, "id">>;

const reject = (message: string): never => {
  throw new ProjectValidationError(message);
};

const optionalText = (value: unknown, label: string, maximum: number): string =>
  value === undefined ? "" : assertText(value, label, maximum);

const assertText = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum)
    return reject(`project ${label} must be a non-empty string of at most ${maximum} characters`);
  return value;
};

export class ProjectRegistryAuthority {
  readonly store: ProjectRegistryStore;

  constructor(options: { root: string }) {
    this.store = new ProjectRegistryStore({ root: options.root });
  }

  list(): ProjectV1[] {
    return this.store.read().projects.map((project) => structuredClone(project) as ProjectV1);
  }

  get(id: string): ProjectV1 | undefined {
    return this.list().find((project) => project.id === id);
  }

  create(request: ProjectCreateRequestV1): ProjectV1 {
    if (typeof request !== "object" || request === null)
      return reject("project create request must be an object");
    const project: ProjectV1 = {
      id: assertProjectSlug(request.id),
      name: assertText(request.name, "name", PROJECT_NAME_MAX_LENGTH),
      goal: optionalText(request.goal, "goal", PROJECT_GOAL_MAX_LENGTH),
      context: optionalText(request.context, "context", PROJECT_CONTEXT_MAX_LENGTH),
      repos: normalizeProjectRepos(request.repos ?? []),
      engine: assertProjectEngineV1(request.engine),
      created_at: new Date().toISOString(),
    };
    const projects = this.list();
    if (projects.some((existing) => existing.id === project.id))
      return reject(`project ${project.id} already exists`);
    this.store.commit([...projects, project]);
    return structuredClone(project) as ProjectV1;
  }

  /** Patch fields; `id` and `created_at` are immutable, every other field is optional. */
  update(id: string, patch: ProjectUpdateRequestV1): ProjectV1 {
    const existing = this.get(id);
    if (!existing) return reject(`unknown project ${id}`);
    if (typeof patch !== "object" || patch === null)
      return reject("project update request must be an object");
    const updated: ProjectV1 = {
      ...existing,
      name:
        patch.name === undefined
          ? existing.name
          : assertText(patch.name, "name", PROJECT_NAME_MAX_LENGTH),
      goal:
        patch.goal === undefined
          ? existing.goal
          : assertText(patch.goal, "goal", PROJECT_GOAL_MAX_LENGTH),
      context:
        patch.context === undefined
          ? existing.context
          : assertText(patch.context, "context", PROJECT_CONTEXT_MAX_LENGTH),
      repos: patch.repos === undefined ? existing.repos : normalizeProjectRepos(patch.repos),
      engine: patch.engine === undefined ? existing.engine : assertProjectEngineV1(patch.engine),
    };
    this.store.commit(this.list().map((project) => (project.id === id ? updated : project)));
    return structuredClone(updated) as ProjectV1;
  }

  delete(id: string): void {
    const projects = this.list();
    if (!projects.some((project) => project.id === id)) reject(`unknown project ${id}`);
    this.store.commit(projects.filter((project) => project.id !== id));
  }
}
