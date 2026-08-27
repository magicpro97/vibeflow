import { PUBLIC_ERROR_CODE, PUBLIC_RECOVERY_ACTION } from "../actions/public-error-contract.js";
import {
  CatalogCursorError,
  FutureLineageCursorError,
} from "../orchestrator/conversation/catalog-cursor.js";
import {
  ConversationLineageNotFoundError,
  type ConversationLineageService,
  StaleLineageCursorError,
} from "../orchestrator/conversation/lineage-service.js";
import { LineageAuthorityCorruptError } from "../orchestrator/conversation/lineage-store.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";
import { conversationReadError } from "./conversation-list-route.js";

const ALLOWED_QUERY = new Set(["cursor", "limit"]);

export interface ConversationLineageRouteAuthority {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  lineage: Pick<ConversationLineageService, "read">;
}

function singleton(search: URLSearchParams, name: string): string | undefined {
  const values = search.getAll(name);
  if (values.length > 1) throw new Error(`duplicate ${name} query parameter`);
  return values[0];
}

function parseLineageQuery(url: URL): { cursor?: string; limit?: number } {
  for (const key of url.searchParams.keys())
    if (!ALLOWED_QUERY.has(key)) throw new Error("unknown lineage query parameter");
  const cursor = singleton(url.searchParams, "cursor");
  const rawLimit = singleton(url.searchParams, "limit");
  if (rawLimit !== undefined && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
    throw new Error("invalid lineage limit");
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
  };
}

function mapLineageError(error: unknown): Response {
  if (error instanceof StaleLineageCursorError)
    return conversationReadError(PUBLIC_ERROR_CODE.STALE_LINEAGE_CURSOR, {
      message: "The conversation lineage changed during pagination.",
      recoveryAction: PUBLIC_RECOVERY_ACTION.RESTART_PAGINATION,
      details: {
        restart_cursor: error.restart_cursor,
        head_digest: error.head_digest,
        head_epoch: error.head_epoch,
      },
    });
  if (error instanceof FutureLineageCursorError)
    return conversationReadError(PUBLIC_ERROR_CODE.FUTURE_EVENT_CURSOR, {
      message: "The lineage cursor is ahead of the current public sequence.",
      recoveryAction: PUBLIC_RECOVERY_ACTION.RESTART_PAGINATION,
      details: { current_last_seq: error.current_last_public_sequence },
    });
  if (error instanceof CatalogCursorError)
    return conversationReadError(
      error.code === PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION
        ? PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION
        : PUBLIC_ERROR_CODE.INVALID_REQUEST,
      { message: "The conversation lineage cursor is invalid." },
    );
  if (error instanceof ConversationLineageNotFoundError)
    return conversationReadError(PUBLIC_ERROR_CODE.NOT_FOUND, {
      message: "The conversation lineage was not found.",
    });
  if (error instanceof LineageAuthorityCorruptError)
    return conversationReadError(PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT, {
      message: "Conversation lineage authority is corrupt.",
      recoveryAction: PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY,
    });
  return conversationReadError(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE, {
    message: "The conversation lineage is unavailable.",
    retryable: true,
    recoveryAction: PUBLIC_RECOVERY_ACTION.RETRY,
  });
}

export async function handleConversationLineageRoute(
  authority: ConversationLineageRouteAuthority,
  request: Request,
  url: URL,
  conversationId: string,
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
    input = parseLineageQuery(url);
  } catch {
    return conversationReadError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {
      message: "The lineage query is invalid.",
    });
  }
  try {
    const body = await authority.lineage.read(conversationId, input);
    return Response.json(body, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapLineageError(error);
  }
}
