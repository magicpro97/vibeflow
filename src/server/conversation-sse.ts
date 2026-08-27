import { httpStatusForPublicError, publicActionError } from "../actions/errors.js";
import {
  PUBLIC_API_ERROR_SCHEMA_VERSION,
  PUBLIC_ERROR_CODE,
  PUBLIC_RECOVERY_ACTION,
} from "../actions/public-error-contract.js";
import { canonicalJsonBytes, digestV1 } from "../durability/index.js";
import {
  CONVERSATION_CURSOR_ERROR_CODE,
  type ConversationCursorErrorCode,
} from "../orchestrator/conversation/conversation-catalog-contract.js";
import {
  type PublicConversationMessageQueueInvalidationV1,
  isPublicConversationMessageQueueInvalidationWireV1,
} from "../orchestrator/conversation/conversation-message-queue-wire.js";
import {
  CONVERSATION_SSE_ERROR_CODE,
  CONVERSATION_SSE_EVENT,
  CONVERSATION_SSE_HTTP_ERROR_CODE,
  type ConversationSseErrorCode,
  type ConversationSseHttpErrorCode,
  serializeSseDataEvent,
} from "../orchestrator/conversation/conversation-sse-contract.js";
import type {
  ConversationListener,
  ConversationService,
  ConversationSnapshot,
  ConversationSseFrame,
  Unsubscribe,
} from "../orchestrator/conversation/types.js";
import type { PublicStoredTraceEvent } from "../orchestrator/trace/types.js";

export interface ConversationStreamAuthorizer {
  authorize(conversationId: string, token: string): boolean;
}

export interface ConversationSseAuthority {
  service: ConversationService;
  tokens: ConversationStreamAuthorizer;
  heartbeatMs?: number;
  messageQueue?: {
    rootSessionId(conversationId: string): string | null;
    subscribe(
      rootSessionId: string,
      listener: (event: PublicConversationMessageQueueInvalidationV1) => void,
    ): Unsubscribe | null;
  };
}

export type ConversationCursorResult =
  | { ok: true; cursor: number }
  | {
      ok: false;
      code: Extract<
        ConversationCursorErrorCode,
        | typeof CONVERSATION_CURSOR_ERROR_CODE.INVALID_CURSOR
        | typeof CONVERSATION_CURSOR_ERROR_CODE.CONFLICTING_CURSOR
      >;
    };

function cursorValue(value: string | null): number | null | undefined {
  if (value === null) return null;
  if (value.length === 0 || value.length > 16) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseConversationCursor(request: Request, url: URL): ConversationCursorResult {
  const query = url.searchParams.getAll("since");
  if (query.length > 1) return { ok: false, code: CONVERSATION_CURSOR_ERROR_CODE.INVALID_CURSOR };
  const headerRaw = request.headers.get("last-event-id");
  if (headerRaw?.includes(","))
    return { ok: false, code: CONVERSATION_CURSOR_ERROR_CODE.INVALID_CURSOR };
  const header = cursorValue(headerRaw);
  const since = cursorValue(query[0] ?? null);
  if (header === undefined || since === undefined)
    return { ok: false, code: CONVERSATION_CURSOR_ERROR_CODE.INVALID_CURSOR };
  if (header !== null && since !== null && header !== since)
    return { ok: false, code: CONVERSATION_CURSOR_ERROR_CODE.CONFLICTING_CURSOR };
  return { ok: true, cursor: header ?? since ?? 0 };
}

export function serializeConversationSseFrame(frame: ConversationSseFrame): string {
  const data = frame.data === "" ? "" : canonicalJsonBytes(frame.data).toString("utf8");
  return serializeSseDataEvent(frame.event, data, "id" in frame ? { id: frame.id } : undefined);
}

function httpError(conversationId: string, code: ConversationSseHttpErrorCode): Response {
  const unavailable = code === CONVERSATION_SSE_HTTP_ERROR_CODE.SERVICE_UNAVAILABLE;
  const body = publicActionError({
    code,
    message:
      code === CONVERSATION_SSE_HTTP_ERROR_CODE.UNAUTHENTICATED
        ? "Authentication is required."
        : code === CONVERSATION_SSE_HTTP_ERROR_CODE.INVALID_REQUEST
          ? "The event cursor is invalid."
          : code === CONVERSATION_SSE_HTTP_ERROR_CODE.NOT_FOUND
            ? "The conversation was not found."
            : "The stream is unavailable.",
    correlation_id: `vf-stream-${digestV1("VF-CONVERSATION-STREAM-HTTP-ERROR\0v1\0", {
      schema_version: PUBLIC_API_ERROR_SCHEMA_VERSION,
      conversation_id: conversationId,
      code,
    }).slice(7)}`,
    retryable: unavailable,
    recovery_action: unavailable ? PUBLIC_RECOVERY_ACTION.RETRY : null,
    details: null,
  });
  return Response.json(body, {
    status: httpStatusForPublicError(code),
    headers: { "cache-control": "no-store" },
  });
}

function validEvent(event: PublicStoredTraceEvent, id: string): boolean {
  return event.conversation_id === id && Number.isSafeInteger(event.seq) && event.seq > 0;
}

function validQueueInvalidation(
  event: PublicConversationMessageQueueInvalidationV1,
  rootSessionId: string,
): boolean {
  return isPublicConversationMessageQueueInvalidationWireV1(event, rootSessionId);
}

function snapshotFrame(value: ConversationSnapshot): ConversationSseFrame {
  return { id: String(value.last_seq), event: CONVERSATION_SSE_EVENT.SNAPSHOT, data: value };
}

function streamPublicError(conversationId: string, code: ConversationSseErrorCode) {
  return publicActionError({
    code,
    message:
      code === CONVERSATION_SSE_ERROR_CODE.NOT_FOUND
        ? "The conversation was not found."
        : "The stream is unavailable.",
    correlation_id: `vf-stream-${digestV1("VF-CONVERSATION-STREAM-ERROR\0v1\0", {
      schema_version: PUBLIC_API_ERROR_SCHEMA_VERSION,
      conversation_id: conversationId,
      code,
    }).slice(7)}`,
    retryable: code === CONVERSATION_SSE_ERROR_CODE.SERVICE_UNAVAILABLE,
    recovery_action:
      code === CONVERSATION_SSE_ERROR_CODE.SERVICE_UNAVAILABLE
        ? PUBLIC_RECOVERY_ACTION.RETRY
        : null,
    details: null,
  }).error;
}

type ReplayAwareUnsubscribe = Unsubscribe & { readonly replayReady?: Promise<void> };

function replayCompletion(unsubscribe: Unsubscribe): Promise<void> | null {
  const ready = (unsubscribe as ReplayAwareUnsubscribe).replayReady;
  return ready && typeof ready.then === "function" ? ready : null;
}

export async function handleConversationSse(
  authority: ConversationSseAuthority,
  request: Request,
  url: URL,
  conversationId: string,
): Promise<Response> {
  const credentials = url.searchParams.getAll("stream_token");
  if (
    credentials.length !== 1 ||
    !credentials[0] ||
    !authority.tokens.authorize(conversationId, credentials[0])
  )
    return httpError(conversationId, CONVERSATION_SSE_HTTP_ERROR_CODE.UNAUTHENTICATED);
  const parsed = parseConversationCursor(request, url);
  if (!parsed.ok)
    return httpError(conversationId, CONVERSATION_SSE_HTTP_ERROR_CODE.INVALID_REQUEST);
  let snapshot: ConversationSnapshot | null;
  try {
    snapshot = await authority.service.snapshot(conversationId);
  } catch {
    return httpError(conversationId, CONVERSATION_SSE_HTTP_ERROR_CODE.SERVICE_UNAVAILABLE);
  }
  if (!snapshot) return httpError(conversationId, CONVERSATION_SSE_HTTP_ERROR_CODE.NOT_FOUND);
  if (parsed.cursor > snapshot.last_seq)
    return Response.json(
      publicActionError({
        code: PUBLIC_ERROR_CODE.FUTURE_EVENT_CURSOR,
        message: "The event cursor is ahead of the current conversation.",
        correlation_id: `vf-stream-${conversationId}`,
        retryable: false,
        recovery_action: PUBLIC_RECOVERY_ACTION.RESTART_PAGINATION,
        details: { current_last_seq: snapshot.last_seq },
      }),
      { status: 409, headers: { "cache-control": "no-store" } },
    );

  const encoder = new TextEncoder();
  const heartbeatMs = authority.heartbeatMs ?? 15_000;
  let cleanup = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let active = true;
      let lastSeq = parsed.cursor;
      let unsubscribe: Unsubscribe | null = null;
      let unsubscribeQueue: Unsubscribe | null = null;
      let timer: ReturnType<typeof setInterval> | null = null;
      const pending = new Map<number, PublicStoredTraceEvent>();
      const onAbort = () => cleanup();
      const release = () => {
        const current = unsubscribe;
        const currentQueue = unsubscribeQueue;
        unsubscribe = null;
        unsubscribeQueue = null;
        try {
          current?.();
        } catch {
          // Cleanup remains exact and closes the stream even for a faulty adapter.
        }
        try {
          currentQueue?.();
        } catch {
          // Queue invalidations are hints; cleanup still closes the stream exactly once.
        }
      };
      cleanup = () => {
        if (!active) return;
        active = false;
        pending.clear();
        if (timer !== null) clearInterval(timer);
        request.signal.removeEventListener("abort", onAbort);
        release();
        try {
          controller.close();
        } catch {
          // A cancelled stream may already be closed by the runtime.
        }
      };
      const enqueue = (frame: ConversationSseFrame): void => {
        if (!active) return;
        try {
          controller.enqueue(encoder.encode(serializeConversationSseFrame(frame)));
        } catch {
          cleanup();
        }
      };
      const enqueueTrace = (event: PublicStoredTraceEvent): void => {
        if (!active || event.seq <= lastSeq) return;
        lastSeq = event.seq;
        enqueue({ id: String(event.seq), event: CONVERSATION_SSE_EVENT.TRACE, data: event });
      };
      const boundary = (snapshot as ConversationSnapshot).last_seq;
      let replayReady = false;
      const listener: ConversationListener = (event) => {
        if (!active || !validEvent(event, conversationId) || event.seq <= lastSeq) return;
        if (!replayReady) {
          pending.set(event.seq, event);
          return;
        }
        enqueueTrace(event);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      try {
        unsubscribe = authority.service.subscribe(conversationId, listener, parsed.cursor);
        const rootSessionId = authority.messageQueue?.rootSessionId(conversationId) ?? null;
        if (rootSessionId) {
          unsubscribeQueue =
            authority.messageQueue?.subscribe(rootSessionId, (event) => {
              if (!active || !validQueueInvalidation(event, rootSessionId)) return;
              enqueue({
                event: CONVERSATION_SSE_EVENT.MESSAGE_QUEUE_INVALIDATED,
                data: structuredClone(event),
              });
            }) ?? null;
        }
      } catch {
        enqueue({
          event: CONVERSATION_SSE_EVENT.ERROR,
          data: streamPublicError(conversationId, CONVERSATION_SSE_ERROR_CODE.SERVICE_UNAVAILABLE),
        });
        cleanup();
        return;
      }
      if (!unsubscribe) {
        enqueue({
          event: CONVERSATION_SSE_EVENT.ERROR,
          data: streamPublicError(conversationId, CONVERSATION_SSE_ERROR_CODE.NOT_FOUND),
        });
        cleanup();
        return;
      }
      // Abort dispatch is synchronous, so it may run while subscribe is producing
      // its handle. Transfer ownership before leaving this stack frame.
      if (!active) {
        release();
        return;
      }
      const completion = replayCompletion(unsubscribe);
      if (!completion) {
        enqueue({
          event: CONVERSATION_SSE_EVENT.ERROR,
          data: streamPublicError(conversationId, CONVERSATION_SSE_ERROR_CODE.SERVICE_UNAVAILABLE),
        });
        cleanup();
        return;
      }
      void completion.then(
        () => {
          if (!active) return;
          replayReady = true;
          const buffered = [...pending.values()].sort((left, right) => left.seq - right.seq);
          pending.clear();
          for (const event of buffered) {
            if (event.seq <= boundary) enqueueTrace(event);
          }
          enqueue(snapshotFrame(snapshot as ConversationSnapshot));
          lastSeq = Math.max(lastSeq, boundary, parsed.cursor);
          for (const event of buffered) if (event.seq > boundary) enqueueTrace(event);
          if (heartbeatMs > 0 && active) {
            timer = setInterval(
              () => enqueue({ event: CONVERSATION_SSE_EVENT.HEARTBEAT, data: "" }),
              heartbeatMs,
            );
          }
        },
        () => {
          enqueue({
            event: CONVERSATION_SSE_EVENT.ERROR,
            data: streamPublicError(
              conversationId,
              CONVERSATION_SSE_ERROR_CODE.SERVICE_UNAVAILABLE,
            ),
          });
          cleanup();
        },
      );
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}
