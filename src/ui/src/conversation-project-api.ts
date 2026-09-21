/**
 * Browser client for the conversation-project routes: the rail's registry read, the composer
 * chip's classifier verdict, the settings panel's engine override write, and the explicit move.
 *
 * The classifier verdict is never computed locally — the tier ladder and its acceptance floors
 * are server authority, and a second implementation in the browser would drift from them. This
 * module only carries the verdict the server returned.
 */
import { api } from "./api.js";
import { HOME_API_ERROR_CONTRACT } from "./conversation-home-error-boundary.js";
import { conversationHomeRequest } from "./conversation-home-http.js";
import type {
  HomeProjectClassification,
  HomeProjectClient,
  HomeProjectRow,
} from "./conversation-home-projects.js";

const PROJECTS = "/api/conversation-projects";

interface ProjectRowWireV1 {
  id: string;
  name: string;
  goal: string;
  engine: HomeProjectRow["engine"];
}

interface ProjectsWireV1 {
  schema_version: string;
  projects: ProjectRowWireV1[];
}

interface ClassificationWireV1 extends HomeProjectClassification {
  schema_version: string;
}

function projectRows(value: unknown): HomeProjectRow[] {
  const body = value as ProjectsWireV1;
  if (!Array.isArray(body.projects)) throw new Error("project registry response is unreadable");
  return body.projects.map((project) => ({
    id: project.id,
    name: project.name,
    goal: project.goal,
    engine: project.engine,
  }));
}

function classification(value: unknown): HomeProjectClassification {
  const body = value as ClassificationWireV1;
  if (typeof body.project_id !== "string" || typeof body.reason !== "string")
    throw new Error("classification response is unreadable");
  return { project_id: body.project_id, confidence: body.confidence, reason: body.reason };
}

export const conversationProjectApi: HomeProjectClient = {
  async listProjects(signal) {
    return projectRows(
      await conversationHomeRequest<unknown>(
        "GET",
        PROJECTS,
        undefined,
        signal,
        undefined,
        HOME_API_ERROR_CONTRACT.PUBLIC,
      ),
    );
  },

  async classifyMessage(input, signal) {
    return classification(
      await conversationHomeRequest<unknown>(
        "POST",
        `${PROJECTS}/classify`,
        { message: input.message },
        signal,
        undefined,
        HOME_API_ERROR_CONTRACT.PUBLIC,
      ),
    );
  },

  async updateProjectEngine(projectId, engine, signal) {
    await conversationHomeRequest<unknown>(
      "PATCH",
      `${PROJECTS}/${encodeURIComponent(projectId)}`,
      { engine },
      signal,
      undefined,
      HOME_API_ERROR_CONTRACT.PUBLIC,
    );
  },

  async moveConversation(input, signal) {
    await conversationHomeRequest<unknown>(
      "POST",
      `${PROJECTS}/move`,
      input,
      signal,
      undefined,
      HOME_API_ERROR_CONTRACT.PUBLIC,
    );
  },

  /**
   * The global block lives in the settings document, not the project registry, so these go
   * through the already-composed `/api/settings` surface rather than the conversation route.
   * The whole block is read and written: the engine fields must survive a switch toggle.
   */
  async readProjectSettings(signal) {
    const body = await api.settings.get(signal);
    return body.projectClassification ?? null;
  },

  async writeProjectSettings(value, signal) {
    const body = await api.settings.set({ projectClassification: value }, signal);
    return body.projectClassification ?? null;
  },
};
