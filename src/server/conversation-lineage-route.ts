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
    return conversationReadError("stale_lineage_cursor", {
      message: "The conversation lineage changed during pagination.",
      recoveryAction: "restart-pagination",
      details: {
        restart_cursor: error.restart_cursor,
        head_digest: error.head_digest,
        head_epoch: error.head_epoch,
      },
    });
  if (error instanceof FutureLineageCursorError)
    return conversationReadError("future_event_cursor", {
      message: "The lineage cursor is ahead of the current public sequence.",
      recoveryAction: "restart-pagination",
      details: { current_last_seq: error.current_last_public_sequence },
    });
  if (error instanceof CatalogCursorError)
    return conversationReadError(
      error.code === "unsupported_schema_version"
        ? "unsupported_schema_version"
        : "invalid_request",
      { message: "The conversation lineage cursor is invalid." },
    );
  if (error instanceof ConversationLineageNotFoundError)
    return conversationReadError("not_found", {
      message: "The conversation lineage was not found.",
    });
  if (error instanceof LineageAuthorityCorruptError)
    return conversationReadError("authority_corrupt", {
      message: "Conversation lineage authority is corrupt.",
      recoveryAction: "repair-authority",
    });
  return conversationReadError("service_unavailable", {
    message: "The conversation lineage is unavailable.",
    retryable: true,
    recoveryAction: "retry",
  });
}

export async function handleConversationLineageRoute(
  authority: ConversationLineageRouteAuthority,
  request: Request,
  url: URL,
  conversationId: string,
): Promise<Response> {
  if (!authority.sessions.authorize(request))
    return conversationReadError("unauthenticated", { message: "Authentication is required." });
  if (request.method !== "GET")
    return conversationReadError("not_found", { message: "The requested resource was not found." });
  let input: { cursor?: string; limit?: number };
  try {
    input = parseLineageQuery(url);
  } catch {
    return conversationReadError("invalid_request", { message: "The lineage query is invalid." });
  }
  try {
    const body = await authority.lineage.read(conversationId, input);
    return Response.json(body, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapLineageError(error);
  }
}
