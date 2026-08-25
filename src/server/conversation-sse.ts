import {
  type PublicErrorCode,
  httpStatusForPublicError,
  publicActionError,
} from "../actions/errors.js";
import { canonicalJsonBytes, digestV1 } from "../durability/index.js";
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
}

export type ConversationCursorResult =
  | { ok: true; cursor: number }
  | { ok: false; code: "invalid_cursor" | "conflicting_cursor" };

function cursorValue(value: string | null): number | null | undefined {
  if (value === null) return null;
  if (value.length === 0 || value.length > 16) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseConversationCursor(request: Request, url: URL): ConversationCursorResult {
  const query = url.searchParams.getAll("since");
  if (query.length > 1) return { ok: false, code: "invalid_cursor" };
  const headerRaw = request.headers.get("last-event-id");
  if (headerRaw?.includes(",")) return { ok: false, code: "invalid_cursor" };
  const header = cursorValue(headerRaw);
  const since = cursorValue(query[0] ?? null);
  if (header === undefined || since === undefined) return { ok: false, code: "invalid_cursor" };
  if (header !== null && since !== null && header !== since)
    return { ok: false, code: "conflicting_cursor" };
  return { ok: true, cursor: header ?? since ?? 0 };
}

export function serializeConversationSseFrame(frame: ConversationSseFrame): string {
  const id = "id" in frame ? `id: ${frame.id}\n` : "";
  const data = frame.data === "" ? "" : canonicalJsonBytes(frame.data).toString("utf8");
  return `${id}event: ${frame.event}\ndata: ${data}\n\n`;
}

function httpError(
  conversationId: string,
  code: Extract<
    PublicErrorCode,
    "unauthenticated" | "invalid_request" | "not_found" | "service_unavailable"
  >,
): Response {
  const unavailable = code === "service_unavailable";
  const body = publicActionError({
    code,
    message:
      code === "unauthenticated"
        ? "Authentication is required."
        : code === "invalid_request"
          ? "The event cursor is invalid."
          : code === "not_found"
            ? "The conversation was not found."
            : "The stream is unavailable.",
    correlation_id: `vf-stream-${digestV1("VF-CONVERSATION-STREAM-HTTP-ERROR\0v1\0", {
      schema_version: "1.0",
      conversation_id: conversationId,
      code,
    }).slice(7)}`,
    retryable: unavailable,
    recovery_action: unavailable ? "retry" : null,
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

function snapshotFrame(value: ConversationSnapshot): ConversationSseFrame {
  return { id: String(value.last_seq), event: "snapshot", data: value };
}

function streamPublicError(
  conversationId: string,
  code: Extract<PublicErrorCode, "not_found" | "service_unavailable">,
) {
  return publicActionError({
    code,
    message:
      code === "not_found" ? "The conversation was not found." : "The stream is unavailable.",
    correlation_id: `vf-stream-${digestV1("VF-CONVERSATION-STREAM-ERROR\0v1\0", {
      schema_version: "1.0",
      conversation_id: conversationId,
      code,
    }).slice(7)}`,
    retryable: code === "service_unavailable",
    recovery_action: code === "service_unavailable" ? "retry" : null,
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
    return httpError(conversationId, "unauthenticated");
  const parsed = parseConversationCursor(request, url);
  if (!parsed.ok) return httpError(conversationId, "invalid_request");
  let snapshot: ConversationSnapshot | null;
  try {
    snapshot = await authority.service.snapshot(conversationId);
  } catch {
    return httpError(conversationId, "service_unavailable");
  }
  if (!snapshot) return httpError(conversationId, "not_found");
  if (parsed.cursor > snapshot.last_seq)
    return Response.json(
      publicActionError({
        code: "future_event_cursor",
        message: "The event cursor is ahead of the current conversation.",
        correlation_id: `vf-stream-${conversationId}`,
        retryable: false,
        recovery_action: "restart-pagination",
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
      let timer: ReturnType<typeof setInterval> | null = null;
      const pending = new Map<number, PublicStoredTraceEvent>();
      const onAbort = () => cleanup();
      const release = () => {
        const current = unsubscribe;
        unsubscribe = null;
        try {
          current?.();
        } catch {
          // Cleanup remains exact and closes the stream even for a faulty adapter.
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
        enqueue({ id: String(event.seq), event: "trace", data: event });
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
      } catch {
        enqueue({
          event: "error",
          data: streamPublicError(conversationId, "service_unavailable"),
        });
        cleanup();
        return;
      }
      if (!unsubscribe) {
        enqueue({
          event: "error",
          data: streamPublicError(conversationId, "not_found"),
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
          event: "error",
          data: streamPublicError(conversationId, "service_unavailable"),
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
            timer = setInterval(() => enqueue({ event: "heartbeat", data: "" }), heartbeatMs);
          }
        },
        () => {
          enqueue({
            event: "error",
            data: streamPublicError(conversationId, "service_unavailable"),
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
