import { randomUUID } from "node:crypto";
import {
  type PublicErrorCode,
  httpStatusForPublicError,
  publicActionError,
} from "../actions/errors.js";
import { PUBLIC_ERROR_CODE, PUBLIC_RECOVERY_ACTION } from "../actions/public-error-contract.js";
import type { RecoveryAction } from "../actions/types.js";
import {
  CatalogCursorError,
  StaleCatalogCursorError,
} from "../orchestrator/conversation/catalog-cursor.js";
import {
  CatalogDegradedError,
  type ConversationCatalogListInputV1,
  type ConversationCatalogService,
} from "../orchestrator/conversation/catalog-service.js";
import { CatalogProjectionCorruptError } from "../orchestrator/conversation/catalog-storage.js";
import { CONVERSATION_LIFECYCLES } from "../orchestrator/conversation/conversation-public-wire-contract.js";
import { LineageAuthorityCorruptError } from "../orchestrator/conversation/lineage-store.js";
import type { ConversationLifecycle } from "../orchestrator/trace/types.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";

const ALLOWED_QUERY = new Set(["q", "lifecycle", "policy", "cursor", "limit"]);
const LIFECYCLES = new Set<ConversationLifecycle>(CONVERSATION_LIFECYCLES);

export interface ConversationListRouteAuthority {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  catalog: Pick<ConversationCatalogService, "list">;
}

export type ConversationReadErrorOptions = {
  message: string;
  retryable?: boolean;
  recoveryAction?: RecoveryAction | null;
  details?: unknown;
};

export function conversationReadError(
  code: PublicErrorCode,
  options: ConversationReadErrorOptions,
): Response {
  const body = publicActionError({
    code,
    message: options.message,
    correlation_id: `vf-http-${randomUUID()}`,
    retryable: options.retryable ?? false,
    recovery_action: options.recoveryAction ?? null,
    details: options.details ?? null,
  } as never);
  return Response.json(body, {
    status: httpStatusForPublicError(code),
    headers: { "cache-control": "no-store" },
  });
}

function singleton(search: URLSearchParams, name: string): string | undefined {
  const values = search.getAll(name);
  if (values.length > 1) throw new Error(`duplicate ${name} query parameter`);
  return values[0];
}

function commaList(value: string | undefined, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(",");
  if (!items.length || items.some((item) => item.length === 0))
    throw new Error(`invalid ${name} query parameter`);
  return items;
}

function pageLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) throw new Error("invalid limit query parameter");
  return Number(value);
}

function parseListQuery(url: URL): ConversationCatalogListInputV1 {
  for (const key of url.searchParams.keys())
    if (!ALLOWED_QUERY.has(key)) throw new Error("unknown conversation list query parameter");
  const query = singleton(url.searchParams, "q");
  const lifecycleValues = commaList(singleton(url.searchParams, "lifecycle"), "lifecycle");
  const policy = commaList(singleton(url.searchParams, "policy"), "policy");
  const cursor = singleton(url.searchParams, "cursor");
  const limit = pageLimit(singleton(url.searchParams, "limit"));
  if (lifecycleValues?.some((item) => !LIFECYCLES.has(item as ConversationLifecycle)))
    throw new Error("invalid lifecycle query parameter");
  return {
    ...(query === undefined ? {} : { query }),
    ...(lifecycleValues === undefined
      ? {}
      : { lifecycle: lifecycleValues as ConversationLifecycle[] }),
    ...(policy === undefined ? {} : { policy }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function mapListError(error: unknown): Response {
  if (error instanceof StaleCatalogCursorError)
    return conversationReadError(PUBLIC_ERROR_CODE.STALE_CATALOG_CURSOR, {
      message: "The conversation catalog changed during pagination.",
      recoveryAction: PUBLIC_RECOVERY_ACTION.RESTART_PAGINATION,
      details: {
        restart_cursor: error.restart_cursor,
        catalog_generation: error.catalog_generation,
      },
    });
  if (error instanceof CatalogCursorError)
    return conversationReadError(
      error.code === PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION
        ? PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION
        : PUBLIC_ERROR_CODE.INVALID_REQUEST,
      { message: "The conversation catalog cursor is invalid." },
    );
  if (error instanceof CatalogDegradedError)
    return conversationReadError(PUBLIC_ERROR_CODE.CATALOG_DEGRADED, {
      message: "The conversation catalog is temporarily degraded.",
      retryable: true,
      recoveryAction: error.recoverableById
        ? PUBLIC_RECOVERY_ACTION.RESUME_BY_ID
        : PUBLIC_RECOVERY_ACTION.REBUILD_CATALOG,
      details: { recoverable_by_id: error.recoverableById },
    });
  if (
    error instanceof CatalogProjectionCorruptError ||
    error instanceof LineageAuthorityCorruptError
  )
    return conversationReadError(PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT, {
      message: "Conversation catalog authority is corrupt.",
      recoveryAction: PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY,
    });
  return conversationReadError(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE, {
    message: "The conversation catalog is unavailable.",
    retryable: true,
    recoveryAction: PUBLIC_RECOVERY_ACTION.RETRY,
  });
}

export async function handleConversationListRoute(
  authority: ConversationListRouteAuthority,
  request: Request,
  url: URL,
): Promise<Response> {
  if (!authority.sessions.authorize(request))
    return conversationReadError(PUBLIC_ERROR_CODE.UNAUTHENTICATED, {
      message: "Authentication is required.",
    });
  if (request.method !== "GET")
    return conversationReadError(PUBLIC_ERROR_CODE.NOT_FOUND, {
      message: "The requested resource was not found.",
    });
  let input: ConversationCatalogListInputV1;
  try {
    input = parseListQuery(url);
  } catch {
    return conversationReadError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {
      message: "The conversation list query is invalid.",
    });
  }
  try {
    const body = await authority.catalog.list(input);
    return Response.json(body, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapListError(error);
  }
}
