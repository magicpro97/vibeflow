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
  const data = frame.data === "" ? "" : JSON.stringify(frame.data);
  return `${id}event: ${frame.event}\ndata: ${data}\n\n`;
}

const jsonError = (status: number, code: string): Response =>
  Response.json({ code }, { status, headers: { "cache-control": "no-store" } });

function validEvent(event: PublicStoredTraceEvent, id: string): boolean {
  return event.conversation_id === id && Number.isSafeInteger(event.seq) && event.seq > 0;
}

function snapshotFrame(value: ConversationSnapshot, cursor: number): ConversationSseFrame {
  return { id: String(Math.max(value.last_seq, cursor)), event: "snapshot", data: value };
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
    return jsonError(401, "unauthorized");
  const parsed = parseConversationCursor(request, url);
  if (!parsed.ok) return jsonError(400, parsed.code);
  let snapshot: ConversationSnapshot | null;
  try {
    snapshot = await authority.service.snapshot(conversationId);
  } catch {
    return jsonError(500, "stream_unavailable");
  }
  if (!snapshot) return jsonError(404, "conversation_not_found");

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
          data: { code: "stream_unavailable", message: "stream unavailable" },
        });
        cleanup();
        return;
      }
      if (!unsubscribe) {
        enqueue({
          event: "error",
          data: { code: "conversation_not_found", message: "conversation not found" },
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
          data: { code: "stream_unavailable", message: "stream unavailable" },
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
          enqueue(snapshotFrame(snapshot as ConversationSnapshot, parsed.cursor));
          lastSeq = Math.max(lastSeq, boundary, parsed.cursor);
          for (const event of buffered) if (event.seq > boundary) enqueueTrace(event);
          if (heartbeatMs > 0 && active) {
            timer = setInterval(() => enqueue({ event: "heartbeat", data: "" }), heartbeatMs);
          }
        },
        () => {
          enqueue({
            event: "error",
            data: { code: "stream_unavailable", message: "stream unavailable" },
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
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}
