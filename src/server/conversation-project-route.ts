/**
 * Read-only Project registry surface for the rail, plus the explicit project-move request.
 *
 * The rail needs names and goals for the dividers it draws from `project_id` values already on
 * the catalog DTOs, so `GET` forwards the registry verbatim. The `POST` is the suggestion
 * chip's confirm: it delegates to an injected mover and reports the mover's own error text, so
 * a runtime without a durable re-bind says exactly that instead of pretending the move landed.
 *
 * Both routes sit behind the conversation session authority, because the registry is
 * project-private data and the rail only renders for an authorized conversation surface.
 */
import { PUBLIC_ERROR_CODE, PUBLIC_RECOVERY_ACTION } from "../actions/public-error-contract.js";
import { isAgentEngine } from "../core/agent-contract.js";
import { isConversationProjectId } from "../orchestrator/conversation/conversation-catalog-contract.js";
import { ConversationProjectRebindError } from "../orchestrator/conversation/conversation-project-rebind.js";
import type { ClassificationReason } from "../orchestrator/conversation/project-classifier.js";
import type { ProjectV1 } from "../orchestrator/conversation/project-types.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";
import { conversationReadError } from "./conversation-list-route.js";
import {
  authorizeMessageQueueRoute,
  messageQueueRouteError,
  queueNoStore,
  strictQueueBody,
} from "./conversation-message-queue-http.js";

/** The project fields the rail renders. Mirrors `ProjectV1` without leaking `repos[]`/`context`. */
export interface ProjectRailProjectV1 {
  id: string;
  name: string;
  goal: string;
  engine: ProjectV1["engine"];
}

/** Durable re-bind: binds `root_session_id` to `project_id`, or rejects with a reason. */
export type ConversationProjectMoverV1 = (input: {
  root_session_id: string;
  project_id: string;
}) => Promise<void> | void;

/** Registry write for the settings panel's per-project engine override. */
export type ConversationProjectUpdaterV1 = (input: {
  project_id: string;
  engine: ProjectV1["engine"];
}) => void;

/** Classifier verdict for one message. `reason` is the tier; `confidence` is per-tier evidence. */
export interface ConversationProjectClassificationV1 {
  project_id: string;
  confidence: number;
  reason: ClassificationReason;
}

/**
 * Classify a message against the live registry.
 *
 * The whole tier ladder is composed here rather than in the browser, because the acceptance
 * floors (`ai` >= 0.6, an `fts` winner being above the score floor and clear of the runner-up)
 * are server authority. The UI only decides whether a returned verdict may be *shown*.
 *
 * `project_id` is the conversation's *current* project, forwarded so the AI tier can run on that
 * project's engine override. It never votes on the verdict — the ladder decides that.
 *
 * A corrupt or unreadable registry classifies to the fallback instead of failing the request:
 * classification is advisory, so its failure must never take a message turn down.
 */
export type ConversationProjectClassifierV1 = (input: {
  message: string;
  repo_root?: string;
  project_id?: string;
}) => Promise<ConversationProjectClassificationV1>;

/**
 * The project registry surface as the browser authority exposes it. Every operation is present:
 * `ConversationProjectRouteAuthorityV1` marks them optional because *some* runtime may lack one,
 * but this composition always supplies all three, so the route never reports "unavailable" and
 * the rail/chip/settings call sites need no optional chaining.
 */
export interface ConversationProjectSurfaceV1 {
  listProjects(): readonly ProjectV1[];
  updateProject(input: { project_id: string; engine: ProjectV1["engine"] }): void;
  classify(input: {
    message: string;
    repo_root?: string;
    project_id?: string;
  }): Promise<ConversationProjectClassificationV1>;
}

export interface ConversationProjectRouteAuthorityV1 {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  csrf?(request: Request): boolean;
  /** Live registry read; a throwing registry must not take the rail down. */
  listProjects(): readonly ProjectV1[];
  /** Absent when the runtime cannot persist an override; the route then reports exactly that. */
  updateProject?: ConversationProjectUpdaterV1;
  /** Absent when the runtime has no durable re-bind; the route then reports exactly that. */
  moveProject?: ConversationProjectMoverV1;
  /** Absent when the runtime cannot classify; the route then reports exactly that. */
  classify?: ConversationProjectClassifierV1;
}

export const CONVERSATION_PROJECT_ROUTE = Object.freeze({
  LIST: "/api/conversation-projects",
  CLASSIFY: "/api/conversation-projects/classify",
  /** PATCH `/api/conversation-projects/{id}` — engine override. */
  ITEM_PREFIX: "/api/conversation-projects/",
  MOVE: "/api/conversation-projects/move",
} as const);

const railProject = (project: ProjectV1): ProjectRailProjectV1 => ({
  id: project.id,
  name: project.name,
  goal: project.goal,
  engine: project.engine,
});

/**
 * A corrupt registry must not blank the rail: projects degrade to empty, the conversations then
 * group under the catch-all, and the rail still renders — the designed fallback, not an error.
 */
function readRailProjects(authority: ConversationProjectRouteAuthorityV1): readonly ProjectV1[] {
  try {
    return authority.listProjects();
  } catch {
    return [];
  }
}

/**
 * Route kind for a path. The reserved literals are matched FIRST: `move` and `classify` are
 * themselves valid project slugs, so a path-first item parse would swallow both reserved routes
 * into the PATCH branch and answer `null` (a 404) for every move and classification.
 */
function projectRouteKind(pathname: string): "list" | "move" | "classify" | "item" | null {
  if (pathname === CONVERSATION_PROJECT_ROUTE.LIST) return "list";
  if (pathname === CONVERSATION_PROJECT_ROUTE.MOVE) return "move";
  if (pathname === CONVERSATION_PROJECT_ROUTE.CLASSIFY) return "classify";
  return projectIdFromPath(pathname) === null ? null : "item";
}

/** `.../conversation-projects/{id}` — one decoded slug segment, or null. */
function projectIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(CONVERSATION_PROJECT_ROUTE.ITEM_PREFIX)) return null;
  const raw = pathname.slice(CONVERSATION_PROJECT_ROUTE.ITEM_PREFIX.length);
  if (raw === "" || raw.includes("/")) return null;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return isConversationProjectId(id) ? id : null;
}

/** The engine override body is a closed shape: `cli` is the anchor, the rest are optional. */
function engineOverride(body: unknown): ProjectV1["engine"] | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { engine?: unknown }).engine;
  if (typeof value !== "object" || value === null) return null;
  const engine = value as { cli?: unknown; model?: unknown; thinking?: unknown };
  if (typeof engine.cli !== "string" || !isAgentEngine(engine.cli)) return null;
  // The registry authority re-validates every field; this only closes the wire shape.
  if (engine.model !== undefined && engine.model !== null && typeof engine.model !== "string")
    return null;
  if (typeof engine.thinking !== "string") return null;
  return { cli: engine.cli, model: engine.model ?? null, thinking: engine.thinking };
}

export async function handleConversationProjectRoute(
  authority: ConversationProjectRouteAuthorityV1,
  request: Request,
  url: URL,
): Promise<Response | null> {
  const kind = projectRouteKind(url.pathname);
  if (kind === null) return null;
  const itemId = kind === "item" ? projectIdFromPath(url.pathname) : null;
  const mutation = request.method !== "GET";
  const denied = authorizeMessageQueueRoute(authority, request, mutation);
  if (denied) return denied;
  try {
    if (kind === "classify") {
      if (request.method !== "POST") return null;
      const body = await strictQueueBody(request);
      const {
        message,
        repo_root: repoRoot,
        project_id: projectId,
      } = (typeof body === "object" && body !== null ? body : {}) as {
        message?: unknown;
        repo_root?: unknown;
        project_id?: unknown;
      };
      if (typeof message !== "string" || message.trim() === "")
        return conversationReadError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {
          message: "Expected a non-empty message to classify.",
        });
      if (projectId !== undefined && !isConversationProjectId(projectId))
        return conversationReadError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {
          message: "Expected project_id to be a project slug when present.",
        });
      if (!authority.classify)
        return conversationReadError(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE, {
          message: "This runtime cannot classify conversations yet.",
          retryable: true,
          recoveryAction: PUBLIC_RECOVERY_ACTION.RETRY,
        });
      const verdict = await authority.classify({
        message,
        ...(typeof repoRoot === "string" && repoRoot !== "" ? { repo_root: repoRoot } : {}),
        ...(typeof projectId === "string" ? { project_id: projectId } : {}),
      });
      return queueNoStore({ schema_version: "1.0", ...verdict }, 200);
    }
    if (kind === "item" && itemId !== null) {
      if (request.method !== "PATCH") return null;
      const engine = engineOverride(await strictQueueBody(request));
      if (engine === null)
        return conversationReadError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {
          message: "Expected an engine override with a known cli.",
        });
      if (!authority.updateProject)
        return conversationReadError(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE, {
          message: "This runtime cannot persist a project engine override yet.",
          retryable: true,
          recoveryAction: PUBLIC_RECOVERY_ACTION.RETRY,
        });
      // The registry is the membership authority: `idea` is reserved and never stored, and an
      // unregistered slug has nothing to patch. Decided here so the refusal is authored instead of
      // collapsing into the writer's generic `invalid_request`. A registry that cannot be read
      // proves nothing unknown, so that case falls through to the writer's own failure.
      let known: readonly ProjectV1[] | null = null;
      try {
        known = authority.listProjects();
      } catch {
        known = null;
      }
      if (known !== null && !known.some((project) => project.id === itemId))
        return conversationReadError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {
          message: `Unknown project ${itemId}: the registry does not hold it.`,
        });
      authority.updateProject({ project_id: itemId, engine });
      return queueNoStore({ schema_version: "1.0", project_id: itemId, engine }, 200);
    }
    if (kind === "list") {
      if (request.method !== "GET") return null;
      return queueNoStore(
        { schema_version: "1.0", projects: readRailProjects(authority).map(railProject) },
        200,
      );
    }
    // `kind === "move"`: the only remaining kind.
    if (request.method !== "POST") return null;
    const body = await strictQueueBody(request);
    const { root_session_id: rootSessionId, project_id: projectId } = (
      typeof body === "object" && body !== null ? body : {}
    ) as { root_session_id?: unknown; project_id?: unknown };
    if (
      typeof rootSessionId !== "string" ||
      rootSessionId.length === 0 ||
      !isConversationProjectId(projectId)
    )
      return conversationReadError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {
        message: "Expected a root_session_id and a registered project_id.",
      });
    if (!authority.moveProject)
      return conversationReadError(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE, {
        message: "This runtime cannot re-bind a conversation to another project yet.",
        retryable: true,
        recoveryAction: PUBLIC_RECOVERY_ACTION.RETRY,
      });
    await authority.moveProject({ root_session_id: rootSessionId, project_id: projectId });
    return queueNoStore({ schema_version: "1.0", project_id: projectId, moved: true }, 202);
  } catch (error) {
    // A re-bind refusal carries its own public code and authored copy; everything else keeps the
    // queue route's mapping. Without this the refusal would collapse into a generic 400.
    if (error instanceof ConversationProjectRebindError)
      return conversationReadError(error.code, {
        message: error.message,
        retryable: error.code === PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
        ...(error.code === PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE
          ? { recoveryAction: PUBLIC_RECOVERY_ACTION.RETRY }
          : {}),
      });
    return messageQueueRouteError(error);
  }
}
