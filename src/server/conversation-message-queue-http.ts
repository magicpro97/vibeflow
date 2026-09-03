import { randomUUID } from "node:crypto";
import {
  PUBLIC_API_ERROR_ENVELOPE_FIELDS,
  PUBLIC_API_ERROR_FIELD,
  PUBLIC_API_ERROR_MAX_BYTES,
  PUBLIC_API_ERROR_MESSAGE_MAX_BYTES,
} from "../actions/public-error-contract.js";
import { isBoundedWireText, isPlainWireRecord } from "../actions/public-wire-primitives.js";
import { ActionValidationError, parseStrictJson } from "../actions/strict-json.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STALE_REASON,
  type ConversationMessageQueuePublicErrorCodeV1,
  type ConversationMessageQueueRecoveryActionV1,
  isConversationMessageQueuePublicErrorCode,
} from "../orchestrator/conversation/conversation-message-queue-contract.js";
import {
  CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELDS,
  isConversationMessageQueueErrorDetails,
  isConversationMessageQueueErrorMessage,
  isConversationMessageQueueErrorSemantic,
} from "../orchestrator/conversation/conversation-message-queue-error-contract.js";
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
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_LINEAGE_HEAD]: 409,
} satisfies Record<ConversationMessageQueuePublicErrorCodeV1, number>);

interface QueueErrorAuthorityV1 {
  queue: {
    item(rootSessionId: string, queueItemId: string): PublicQueuedUserMessageV1 | null;
  };
}

interface QueueErrorInputV1 {
  code: ConversationMessageQueuePublicErrorCodeV1;
  message: string;
  retryable: boolean;
  recovery_action: ConversationMessageQueueRecoveryActionV1 | null;
  details: Record<string, unknown> | null;
}

const UTF8 = new TextEncoder();
const [QUEUE_ERROR_SCHEMA_VERSION_FIELD, QUEUE_ERROR_BODY_FIELD] = PUBLIC_API_ERROR_ENVELOPE_FIELDS;

function exactRecord(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const record = Object.create(null) as Record<string, unknown>;
  for (const [field, value] of entries)
    Object.defineProperty(record, field, {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  return Object.freeze(record);
}

function snapshotQueueErrorDetails(
  code: ConversationMessageQueuePublicErrorCodeV1,
  source: unknown,
): Record<string, unknown> | null {
  const expectedFields = CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELDS[code];
  if (expectedFields === null) {
    if (source !== null) throw new Error("invalid conversation message queue error details");
    return null;
  }
  if (!isPlainWireRecord(source))
    throw new Error("invalid conversation message queue error details");
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const enumerableFields = Object.entries(descriptors)
    .filter(([, descriptor]) => descriptor.enumerable)
    .map(([field]) => field);
  if (
    enumerableFields.length !== expectedFields.length ||
    expectedFields.some((field) => !enumerableFields.includes(field))
  )
    throw new Error("invalid conversation message queue error details");
  return exactRecord(
    expectedFields.map((field) => {
      const descriptor = descriptors[field];
      if (!descriptor) throw new Error("invalid conversation message queue error details");
      const value = "value" in descriptor ? descriptor.value : descriptor.get?.call(source);
      return [field, value] as const;
    }),
  );
}

export function queueErrorBody(input: QueueErrorInputV1): Response {
  const code = input.code;
  const message = input.message;
  const retryable = input.retryable;
  const recoveryAction = input.recovery_action;
  const detailsSource = input.details;
  if (!isConversationMessageQueuePublicErrorCode(code))
    throw new Error("invalid public conversation message queue error code");
  if (!isBoundedWireText(message, { maxBytes: PUBLIC_API_ERROR_MESSAGE_MAX_BYTES }))
    throw new Error("invalid conversation message queue error message");
  if (!isConversationMessageQueueErrorMessage(code, message))
    throw new Error("conversation message queue error message semantics mismatch");
  if (!isConversationMessageQueueErrorSemantic(code, retryable, recoveryAction))
    throw new Error("invalid conversation message queue error semantics");
  const details = snapshotQueueErrorDetails(code, detailsSource);
  if (!isConversationMessageQueueErrorDetails(code, details))
    throw new Error("invalid conversation message queue error details");
  const error = exactRecord([
    [PUBLIC_API_ERROR_FIELD.CODE, code],
    [PUBLIC_API_ERROR_FIELD.MESSAGE, message],
    [PUBLIC_API_ERROR_FIELD.CORRELATION_ID, `vf-message-queue-${randomUUID()}`],
    [PUBLIC_API_ERROR_FIELD.RETRYABLE, retryable],
    [PUBLIC_API_ERROR_FIELD.RECOVERY_ACTION, recoveryAction],
    [PUBLIC_API_ERROR_FIELD.DETAILS, details],
  ]);
  const body = exactRecord([
    [QUEUE_ERROR_SCHEMA_VERSION_FIELD, CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION],
    [QUEUE_ERROR_BODY_FIELD, error],
  ]);
  const bytes = UTF8.encode(JSON.stringify(body));
  if (bytes.byteLength > PUBLIC_API_ERROR_MAX_BYTES)
    throw new Error("conversation message queue error exceeds 4 KiB byte limit");
  return new Response(bytes, {
    status: QUEUE_ERROR_HTTP_STATUS[code],
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json;charset=utf-8",
    },
  });
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
      message:
        CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
          CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.REQUEST_TOO_LARGE
        ],
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
        message:
          CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
            CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED
          ],
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
      message:
        CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
          CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT
        ],
      retryable: false,
      recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT,
      details: {
        private_context_present: error.privateContextPresent,
        queue_owned: error.queueOwned,
      },
    });
  }
  if (error instanceof ConversationMessageQueueConflictError) {
    const conflictRootSessionId = error.context?.root_session_id ?? rootSessionId;
    const contextMatchesRoute =
      !error.context || !rootSessionId || error.context.root_session_id === rootSessionId;
    if (!contextMatchesRoute)
      return queueErrorBody({
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.AUTHORITY_CORRUPT,
        message: "Conversation message queue authority is unavailable.",
        retryable: false,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.REPAIR_AUTHORITY,
        details: null,
      });
    if (error.code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL && conflictRootSessionId)
      return queueErrorBody({
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
        message:
          CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
            CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL
          ],
        retryable: true,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY,
        details: {
          root_session_id: conflictRootSessionId,
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
        message:
          CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
            CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE
          ],
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
        message:
          CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
            CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE
          ],
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
