import { PUBLIC_ERROR_CODE, PUBLIC_RECOVERY_ACTION } from "../actions/public-error-contract.js";
import { CatalogCursorError } from "../orchestrator/conversation/catalog-cursor.js";
import { StaleTimelineCursorError } from "../orchestrator/conversation/catalog-timeline-cursor.js";
import { ConversationLineageNotFoundError } from "../orchestrator/conversation/lineage-service.js";
import { LineageAuthorityCorruptError } from "../orchestrator/conversation/lineage-store.js";
import {
  type ConversationTimelineService,
  TimelineHeadUnresolvedError,
} from "../orchestrator/conversation/timeline-service.js";
import { deriveBrowserActionAuthority } from "./conversation-action-principal.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";
import { conversationReadError } from "./conversation-list-route.js";

const ALLOWED_QUERY = new Set(["cursor", "limit"]);

export interface ConversationTimelineRouteAuthority {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  timeline: Pick<ConversationTimelineService, "read">;
}

function singleton(search: URLSearchParams, name: string): string | undefined {
  const values = search.getAll(name);
  if (values.length > 1) throw new Error(`duplicate ${name} query parameter`);
  return values[0];
}

function parseTimelineQuery(url: URL): { cursor?: string; limit?: number } {
  for (const key of url.searchParams.keys())
    if (!ALLOWED_QUERY.has(key)) throw new Error("unknown timeline query parameter");
  const cursor = singleton(url.searchParams, "cursor");
  const rawLimit = singleton(url.searchParams, "limit");
  if (rawLimit !== undefined && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
    throw new Error("invalid timeline limit");
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
  };
}

function mapTimelineError(error: unknown): Response {
  if (error instanceof StaleTimelineCursorError)
    return conversationReadError(PUBLIC_ERROR_CODE.STALE_TIMELINE_CURSOR, {
      message: "The selected conversation timeline changed during pagination.",
      recoveryAction: PUBLIC_RECOVERY_ACTION.RESTART_PAGINATION,
      details: {
        restart_cursor: error.restart_cursor,
        head: error.head,
        head_digest: error.head_digest,
        head_epoch: error.head_epoch,
      },
    });
  if (error instanceof TimelineHeadUnresolvedError)
    return conversationReadError(PUBLIC_ERROR_CODE.LINEAGE_HEAD_UNRESOLVED, {
      message: "The conversation lineage needs a head selection.",
      recoveryAction: PUBLIC_RECOVERY_ACTION.SELECT_LINEAGE_HEAD,
      details: {
        root_session_id: error.root_session_id,
        head_status: error.head_status,
        candidate_heads: error.candidate_heads,
        head_digest: error.head_digest,
        head_epoch: error.head_epoch,
      },
    });
  if (error instanceof CatalogCursorError)
    return conversationReadError(
      error.code === PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION
        ? PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION
        : PUBLIC_ERROR_CODE.INVALID_REQUEST,
      { message: "The conversation timeline cursor is invalid." },
    );
  if (error instanceof ConversationLineageNotFoundError)
    return conversationReadError(PUBLIC_ERROR_CODE.NOT_FOUND, {
      message: "The conversation timeline was not found.",
    });
  if (error instanceof LineageAuthorityCorruptError)
    return conversationReadError(PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT, {
      message: "Conversation timeline authority is corrupt.",
      recoveryAction: PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY,
    });
  return conversationReadError(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE, {
    message: "The conversation timeline is unavailable.",
    retryable: true,
    recoveryAction: PUBLIC_RECOVERY_ACTION.RETRY,
  });
}

export async function handleConversationTimelineRoute(
  authority: ConversationTimelineRouteAuthority,
  request: Request,
  url: URL,
  rootSessionId: string,
): Promise<Response> {
  if (!authority.sessions.authorize(request))
    return conversationReadError(PUBLIC_ERROR_CODE.UNAUTHENTICATED, {
      message: "Authentication is required.",
    });
  if (request.method !== "GET")
    return conversationReadError(PUBLIC_ERROR_CODE.NOT_FOUND, {
      message: "The requested resource was not found.",
    });
  let input: { cursor?: string; limit?: number };
  try {
    input = parseTimelineQuery(url);
  } catch {
    return conversationReadError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {
      message: "The timeline query is invalid.",
    });
  }
  try {
    const recipient = deriveBrowserActionAuthority(request, rootSessionId).actor.public_actor_id;
    const body = await authority.timeline.read(rootSessionId, {
      ...input,
      recipient_public_id: recipient,
    });
    return Response.json(body, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapTimelineError(error);
  }
}
