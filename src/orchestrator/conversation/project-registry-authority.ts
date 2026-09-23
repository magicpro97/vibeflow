/**
 * Project registry policy: the only sanctioned way to mutate the registry.
 *
 * Every mutation validates the request, then persists through {@link ProjectRegistryStore}
 * with a mutator applied to the projects read *inside* the store's write lock, so a caller
 * holding a stale snapshot composes with concurrent writers instead of clobbering them.
 * Duplicate-id and field checks therefore hold on the committed list; the store re-validates
 * that same list before staging it, so a bad entry still cannot reach disk.
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
    return this.store.read().projects.map((project) => structuredClone(project));
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
    this.store.commit((current) => {
      if (current.some((existing) => existing.id === project.id))
        return reject(`project ${project.id} already exists`);
      return [...current, project];
    });
    return structuredClone(project);
  }

  /** Patch fields; `id` and `created_at` are immutable, every other field is optional. */
  update(id: string, patch: ProjectUpdateRequestV1): ProjectV1 {
    assertProjectSlug(id);
    if (typeof patch !== "object" || patch === null)
      return reject("project update request must be an object");
    const manifest = this.store.commit((current) => {
      const existing = current.find((project) => project.id === id);
      if (!existing) return reject(`unknown project ${id}`);
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
      return current.map((project) => (project.id === id ? updated : project));
    });
    // `commit` re-validated the list it persisted, so this is the exact stored project.
    return structuredClone(
      manifest.projects.find((project) => project.id === id) ?? reject(`unknown project ${id}`),
    );
  }

  delete(id: string): void {
    assertProjectSlug(id);
    this.store.commit((current) => {
      if (!current.some((project) => project.id === id)) return reject(`unknown project ${id}`);
      return current.filter((project) => project.id !== id);
    });
  }
}
