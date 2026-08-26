import { randomUUID } from "node:crypto";
import { ActionValidationError, parseStrictJson } from "../actions/strict-json.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STALE_REASON,
  type ConversationMessageQueueErrorCodeV1,
  type ConversationMessageQueueRecoveryActionV1,
} from "../orchestrator/conversation/conversation-message-queue-contract.js";
import type { PublicQueuedUserMessageV1 } from "../orchestrator/conversation/conversation-message-queue-records.js";
import {
  ConversationMessageQueueConflictError,
  ConversationMessageQueueCorruptError,
} from "../orchestrator/conversation/conversation-message-queue-validation.js";
import { ConversationPrivateContextBrokerConflictError } from "../orchestrator/conversation/conversation-private-context-broker-validation.js";
import { ConversationMessageTargetConflictError } from "../orchestrator/conversation/conversation-user-message-authority.js";
import { BoundedRequestBodyError, readBoundedUtf8Body } from "./bounded-request-body.js";
import { deriveBrowserActionAuthority } from "./conversation-action-principal.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";

export const MESSAGE_QUEUE_BODY_BYTES = CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes;
export const QUEUED_MESSAGE_ID = /^vf-queued-message-[0-9a-f]{64}$/;

const QUEUE_ERROR_HTTP_STATUS = Object.freeze({
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.UNAUTHENTICATED]: 401,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.FORBIDDEN]: 403,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_FOUND]: 404,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.REQUEST_TOO_LARGE]: 413,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.AUTHORITY_CORRUPT]: 423,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL]: 429,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED]: 429,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.INVALID_REQUEST]: 400,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.SERVICE_UNAVAILABLE]: 503,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT]: 409,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT]: 409,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE]: 409,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE]: 409,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY]: 409,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_LINEAGE_HEAD]: 409,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT]: 423,
} satisfies Record<ConversationMessageQueueErrorCodeV1, number>);

interface QueueErrorAuthorityV1 {
  queue: {
    item(rootSessionId: string, queueItemId: string): PublicQueuedUserMessageV1 | null;
  };
}

export function queueErrorBody(input: {
  code: ConversationMessageQueueErrorCodeV1;
  message: string;
  retryable: boolean;
  recovery_action: ConversationMessageQueueRecoveryActionV1 | null;
  details: Record<string, unknown> | null;
}): Response {
  const status = QUEUE_ERROR_HTTP_STATUS[input.code];
  return Response.json(
    {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      error: {
        ...input,
        correlation_id: `vf-message-queue-${randomUUID()}`,
      },
    },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export const queueNoStore = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function strictQueueBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new ActionValidationError("content type must be application/json");
  return parseStrictJson(await readBoundedUtf8Body(request, MESSAGE_QUEUE_BODY_BYTES));
}

export function queuePrincipal(
  authority: {
    principal?: (request: Request, rootSessionId: string) => { principal_digest: string };
  },
  request: Request,
  rootSessionId: string,
): string {
  return (
    authority.principal?.(request, rootSessionId) ??
    deriveBrowserActionAuthority(request, rootSessionId)
  ).principal_digest;
}

export function invalidQueueRequest(): Response {
  return queueErrorBody({
    code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.INVALID_REQUEST,
    message: "The message queue request is invalid.",
    retryable: false,
    recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT,
    details: null,
  });
}

export function messageQueueRouteError(
  error: unknown,
  authority?: QueueErrorAuthorityV1,
  rootSessionId?: string,
  queueItemId?: string,
): Response {
  if (error instanceof BoundedRequestBodyError)
    return queueErrorBody({
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.REQUEST_TOO_LARGE,
      message: `The request body exceeds the ${MESSAGE_QUEUE_BODY_BYTES}-byte limit.`,
      retryable: false,
      recovery_action: null,
      details: { max_body_bytes: MESSAGE_QUEUE_BODY_BYTES },
    });
  if (error instanceof ActionValidationError || error instanceof SyntaxError)
    return invalidQueueRequest();
  if (error instanceof ConversationPrivateContextBrokerConflictError) {
    if (error.code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED)
      return queueErrorBody({
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED,
        message: "Too many private context selections are waiting.",
        retryable: false,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT,
        details: {
          max_pending_private_contexts: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
        },
      });
    if (error.code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT)
      return queueErrorBody({
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT,
        message: "That idempotency key is already bound to another request.",
        retryable: false,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT,
        details: null,
      });
    return queueErrorBody({
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
      message: "Private context changed before this request could commit.",
      retryable: false,
      recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT,
      details: {
        private_context_present: error.privateContextPresent,
        queue_owned: error.queueOwned,
      },
    });
  }
  if (error instanceof ConversationMessageQueueConflictError) {
    if (error.code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL)
      return queueErrorBody({
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
        message: `This conversation already has ${CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems} messages waiting.`,
        retryable: true,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY,
        details: {
          root_session_id: rootSessionId,
          max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
        },
      });
    if (error.code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT)
      return queueErrorBody({
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT,
        message: "That idempotency key is already bound to another request.",
        retryable: false,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT,
        details: null,
      });
    const item =
      rootSessionId && queueItemId && authority
        ? authority.queue.item(rootSessionId, queueItemId)
        : null;
    if (error.code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE && item)
      return queueErrorBody({
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE,
        message: "That queued message changed before the edit could commit.",
        retryable: false,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SEND_AS_NEW,
        details: {
          root_session_id: rootSessionId,
          queue_item_id: queueItemId,
          state: item.state,
          item_digest: item.item_digest,
        },
      });
    if (error.code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE && item)
      return queueErrorBody({
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE,
        message: "That queued message no longer matches the conversation authority it followed.",
        retryable: false,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SEND_AS_NEW,
        details: {
          root_session_id: rootSessionId,
          queue_item_id: item.queue_item_id,
          stale_reason:
            item.stale_reason ?? CONVERSATION_MESSAGE_QUEUE_STALE_REASON.CAUSAL_SUCCESSOR_MISMATCH,
          item_digest: item.item_digest,
        },
      });
    return queueErrorBody({
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.AUTHORITY_CORRUPT,
      message: "Conversation message queue authority is unavailable.",
      retryable: false,
      recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.REPAIR_AUTHORITY,
      details: null,
    });
  }
  if (error instanceof ConversationMessageQueueCorruptError)
    return queueErrorBody({
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.AUTHORITY_CORRUPT,
      message: "Conversation message queue authority is corrupt.",
      retryable: false,
      recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.REPAIR_AUTHORITY,
      details: null,
    });
  if (error instanceof ConversationMessageTargetConflictError)
    return queueErrorBody({
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_LINEAGE_HEAD,
      message: "The message target is not the committed active lineage head.",
      retryable: false,
      recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SELECT_ACTIVE_CONVERSATION,
      details: null,
    });
  return invalidQueueRequest();
}

export function authorizeMessageQueueRoute(
  authority: {
    sessions: Pick<ConversationSessionAuthority, "authorize">;
    csrf?(request: Request): boolean;
  },
  request: Request,
  mutation: boolean,
): Response | null {
  if (!authority.sessions.authorize(request))
    return queueErrorBody({
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.UNAUTHENTICATED,
      message: "Authentication is required.",
      retryable: false,
      recovery_action: null,
      details: null,
    });
  if (mutation && (!authority.csrf || !authority.csrf(request)))
    return queueErrorBody({
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.FORBIDDEN,
      message: "CSRF validation failed.",
      retryable: false,
      recovery_action: null,
      details: null,
    });
  return null;
}
