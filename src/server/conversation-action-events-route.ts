import { publicActionError } from "../actions/errors.js";
import { ActionValidationError } from "../actions/index.js";
import { canonicalJsonBytes, digestV1 } from "../durability/index.js";
import type { ConversationActionDomainRegistryV1 } from "../orchestrator/conversation/conversation-action-registry.js";
import { conversationReadError } from "./conversation-list-route.js";

interface EventAuthority {
  actions: ConversationActionDomainRegistryV1;
  actionHeartbeatMs?: number;
}

type OperationEvents = NonNullable<
  Awaited<ReturnType<ConversationActionDomainRegistryV1["events"]>>
>;
type OperationEvent = OperationEvents[number];

function noStore(body: unknown): Response {
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

function eventFrame(event: OperationEvent) {
  return `id: ${event.event_cursor}\nevent: operation\ndata: ${canonicalJsonBytes(event).toString("utf8")}\n\n`;
}

function streamError(proposalId: string): string {
  const body = publicActionError({
    code: "service_unavailable",
    message: "The operation event stream is unavailable.",
    correlation_id: `vf-operation-stream-${digestV1("VF-OPERATION-STREAM-ERROR\0v1\0", {
      schema_version: "1.0",
      proposal_id: proposalId,
    }).slice(7)}`,
    retryable: true,
    recovery_action: "retry",
    details: null,
  }).error;
  return `event: error\ndata: ${canonicalJsonBytes(body).toString("utf8")}\n\n`;
}

function requestedCursor(request: Request, url: URL): string | null {
  for (const key of url.searchParams.keys())
    if (key !== "after") throw new ActionValidationError("unknown operation event query");
  const afterValues = url.searchParams.getAll("after");
  if (afterValues.length > 1) throw new ActionValidationError("duplicate operation cursor");
  const header = request.headers.get("last-event-id");
  const after = afterValues[0] ?? null;
  const valid = (value: string | null) =>
    value === null || /^vf-operation-event-[0-9a-f]{64}$/.test(value);
  if (!valid(header) || !valid(after)) throw new ActionValidationError("invalid operation cursor");
  // EventSource keeps the original query on reconnect and advances only
  // Last-Event-ID. Once present, the independently validated header is the
  // browser's authoritative replay boundary.
  return header ?? after;
}

function cursorIndex(events: OperationEvents, cursor: string | null): number {
  if (cursor === null) return -1;
  return events.findIndex((event) => event.event_cursor === cursor);
}

function stale(events: OperationEvents, proposalId: string) {
  return conversationReadError("stale_operation_cursor", {
    message: "The operation cursor is stale.",
    recoveryAction: "restart-pagination",
    details: {
      restart_cursor: events[0]?.event_cursor ?? "vf-operation-event-empty",
      proposal_id: proposalId,
      operation_id: events[0]?.operation_id ?? null,
    },
  });
}

function liveStream(input: {
  authority: EventAuthority;
  request: Request;
  conversationId: string;
  proposalId: string;
  afterSequence: number;
}) {
  const encoder = new TextEncoder();
  let cleanup: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let active = true;
      let latest = input.afterSequence;
      let unsubscribe: (() => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let refreshing = false;
      let refreshAgain = false;
      const close = () => {
        if (!active) return;
        active = false;
        if (heartbeat) clearInterval(heartbeat);
        input.request.signal.removeEventListener("abort", close);
        unsubscribe?.();
        unsubscribe = null;
        try {
          controller.close();
        } catch {
          // Cancellation may already have closed the stream.
        }
      };
      cleanup = close;
      const enqueue = (value: string) => {
        if (!active) return;
        try {
          controller.enqueue(encoder.encode(value));
        } catch {
          close();
        }
      };
      const refresh = async () => {
        if (!active) return;
        if (refreshing) {
          refreshAgain = true;
          return;
        }
        refreshing = true;
        try {
          do {
            refreshAgain = false;
            const events = await input.authority.actions.events(
              input.conversationId,
              input.proposalId,
            );
            if (!events) throw new Error("proposal event authority disappeared");
            for (const event of events)
              if (event.phase_sequence > latest) {
                enqueue(eventFrame(event));
                latest = event.phase_sequence;
              }
          } while (refreshAgain && active);
        } catch {
          enqueue(streamError(input.proposalId));
          close();
        } finally {
          refreshing = false;
        }
      };
      input.request.signal.addEventListener("abort", close, { once: true });
      if (input.request.signal.aborted) {
        close();
        return;
      }
      void (async () => {
        const acquired = await input.authority.actions.subscribe(
          input.conversationId,
          input.proposalId,
          () => void refresh(),
        );
        if (!active) {
          acquired?.();
          return;
        }
        unsubscribe = acquired;
        if (!unsubscribe) throw new Error("operation subscription is unavailable");
        await refresh();
        const interval = input.authority.actionHeartbeatMs ?? 15_000;
        if (active && interval > 0)
          heartbeat = setInterval(() => enqueue("event: heartbeat\ndata: \n\n"), interval);
      })().catch(() => {
        enqueue(streamError(input.proposalId));
        close();
      });
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

export async function operationActionEvents(
  authority: EventAuthority,
  request: Request,
  url: URL,
  conversationId: string,
  proposalId: string,
): Promise<Response> {
  const cursor = requestedCursor(request, url);
  const events = await authority.actions.events(conversationId, proposalId);
  if (!events)
    return conversationReadError("not_found", { message: "The proposal was not found." });
  const index = cursorIndex(events, cursor);
  if (cursor !== null && index < 0) return stale(events, proposalId);
  if (request.headers.get("accept") === "text/event-stream")
    return liveStream({
      authority,
      request,
      conversationId,
      proposalId,
      afterSequence: events[index]?.phase_sequence ?? -1,
    });
  const items = events.slice(index + 1, index + 101);
  return noStore({
    schema_version: "1.0",
    items,
    next_cursor:
      index + 1 + items.length < events.length ? (items.at(-1)?.event_cursor ?? null) : null,
  });
}
