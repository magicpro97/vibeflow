import { describe, expect, test } from "bun:test";
import type { PublicConversationMessageQueueInvalidationV1 } from "../src/orchestrator/conversation/conversation-message-queue-records.js";
import type {
  ConversationService,
  ConversationSnapshot,
} from "../src/orchestrator/conversation/types.js";
import type { PublicStoredTraceEvent } from "../src/orchestrator/trace/types.js";
import {
  handleConversationSse,
  parseConversationCursor,
  serializeConversationSseFrame,
} from "../src/server/conversation-sse.js";

const snapshot: ConversationSnapshot = {
  conversation_id: "conversation-a",
  lifecycle: "ACTIVE",
  health: "healthy",
  policy: "direct",
  topic: "topic",
  participants: [],
  rounds: [],
  consensus_score: null,
  last_seq: 4,
};

const event = (seq: number): PublicStoredTraceEvent =>
  ({
    workflow_id: "workflow",
    conversation_id: "conversation-a",
    revision_id: "revision",
    run_id: "run",
    turn_id: `turn-${seq}`,
    operation_id: "operation",
    attempt_id: "attempt",
    event_id: `event-${seq}`,
    seq,
    ts: "2026-08-22T00:00:00.000Z",
    public_session_ref: null,
    event: {
      type: "error",
      payload: { agent_id: null, code: `code-${seq}`, message: `message-${seq}` },
    },
  }) as PublicStoredTraceEvent;

describe("conversation SSE cursor", () => {
  test("accepts one safe cursor source and equal dual cursors", () => {
    expect(
      parseConversationCursor(
        new Request("http://local/events", { headers: { "Last-Event-ID": "12" } }),
        new URL("http://local/events"),
      ),
    ).toEqual({ ok: true, cursor: 12 });
    expect(
      parseConversationCursor(
        new Request("http://local/events?since=12", { headers: { "Last-Event-ID": "12" } }),
        new URL("http://local/events?since=12"),
      ),
    ).toEqual({ ok: true, cursor: 12 });
  });

  test("rejects conflicting, duplicate, signed, fractional, and unsafe cursors", () => {
    const bad = [
      ["?since=2", "1"],
      ["?since=1&since=1", null],
      ["?since=", null],
      ["?since=-1", null],
      ["?since=1.5", null],
      [`?since=${Number.MAX_SAFE_INTEGER + 1}`, null],
      [`?since=${"9".repeat(128)}`, null],
      ["", "9".repeat(128)],
      ["?since=01", null],
    ] as const;
    for (const [query, header] of bad) {
      const headers = header === null ? undefined : { "Last-Event-ID": header };
      expect(
        parseConversationCursor(
          new Request(`http://local/events${query}`, { headers }),
          new URL(`http://local/events${query}`),
        ).ok,
      ).toBe(false);
    }
  });
});

describe("conversation SSE stream", () => {
  test("serializes typed frames without embedding credential material", () => {
    const frame = serializeConversationSseFrame({
      id: "2",
      event: "trace",
      data: event(2),
    });
    expect(frame).toStartWith("id: 2\nevent: trace\ndata: ");
    expect(frame).toEndWith("\n\n");
    expect(frame).not.toContain("stream_token");
  });

  test("emits the exact queue invalidation DTO on the existing stream without an SSE id", async () => {
    let queueListener: ((event: PublicConversationMessageQueueInvalidationV1) => void) | null =
      null;
    const service = {
      snapshot: async () => snapshot,
      subscribe: () => Object.assign(() => undefined, { replayReady: Promise.resolve() }),
    } as unknown as ConversationService;
    const url = new URL("http://local/api/conversations/conversation-a/events?stream_token=good");
    const response = await handleConversationSse(
      {
        service,
        tokens: { authorize: () => true },
        heartbeatMs: 0,
        messageQueue: {
          rootSessionId: () => "conversation-root",
          subscribe: (_root, listener) => {
            queueListener = listener;
            return () => undefined;
          },
        },
      },
      new Request(url.toString()),
      url,
      "conversation-a",
    );
    const emitQueue = queueListener as
      | ((event: PublicConversationMessageQueueInvalidationV1) => void)
      | null;
    if (!emitQueue) throw new Error("queue listener was not installed");
    const event: PublicConversationMessageQueueInvalidationV1 = {
      schema_version: "1.0",
      root_session_id: "conversation-root",
      queue_item_id: `vf-queued-message-${"a".repeat(64)}`,
      state: "queued",
      item_digest: `sha256:${"b".repeat(64)}`,
    };
    emitQueue(event);
    emitQueue({ ...event, root_session_id: "wrong-root" });
    emitQueue({ ...event, queue_item_id: "private-claim-id" });

    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing SSE body");
    let output = "";
    try {
      for (let index = 0; index < 2; index += 1) {
        const part = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("queue invalidation was not emitted")), 100),
          ),
        ]);
        if (part.done) break;
        output += new TextDecoder().decode(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const queueFrames = output
      .split("\n\n")
      .filter((frame) => frame.includes("event: message-queue-invalidated"));
    expect(queueFrames).toHaveLength(1);
    expect(queueFrames[0]).not.toContain("id:");
    const data = queueFrames[0]?.split("\ndata: ")[1];
    expect(JSON.parse(data ?? "null")).toEqual(event);
    expect(queueFrames[0]).not.toContain("private-claim-id");
  });

  test("uses only a bound stream token and returns stable cursor/auth failures", async () => {
    const service = { snapshot: async () => snapshot } as unknown as ConversationService;
    const tokens = {
      authorize: (id: string, token: string) => id === "conversation-a" && token === "good",
    };
    const missing = await handleConversationSse(
      { service, tokens, heartbeatMs: 0 },
      new Request("http://local/api/conversations/conversation-a/events"),
      new URL("http://local/api/conversations/conversation-a/events"),
      "conversation-a",
    );
    expect(missing.status).toBe(401);
    const malformed = await handleConversationSse(
      { service, tokens, heartbeatMs: 0 },
      new Request(
        "http://local/api/conversations/conversation-a/events?stream_token=good&since=-1",
      ),
      new URL("http://local/api/conversations/conversation-a/events?stream_token=good&since=-1"),
      "conversation-a",
    );
    expect(malformed.status).toBe(400);
    expect((await malformed.json()) as object).toMatchObject({
      schema_version: "1.0",
      error: { code: "invalid_request" },
    });
  });

  test("rejects future cursors before subscribing and uses exact no-store cache authority", async () => {
    let subscriptions = 0;
    const service = {
      snapshot: async () => snapshot,
      subscribe: () => {
        subscriptions += 1;
        return () => undefined;
      },
    } as unknown as ConversationService;
    const url = new URL(
      "http://local/api/conversations/conversation-a/events?stream_token=good&since=5",
    );
    const response = await handleConversationSse(
      { service, tokens: { authorize: () => true }, heartbeatMs: 0 },
      new Request(url.toString()),
      url,
      "conversation-a",
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()) as object).toMatchObject({
      error: { code: "future_event_cursor", details: { current_last_seq: 4 } },
    });
    expect(subscriptions).toBe(0);
  });

  test("replays after the cursor, deduplicates the live boundary, and cleans up on cancel", async () => {
    let subscribedAfter = -1;
    let unsubscribeCount = 0;
    const service = {
      snapshot: async () => snapshot,
      subscribe(_id: string, listener: (value: PublicStoredTraceEvent) => void, afterSeq = 0) {
        subscribedAfter = afterSeq;
        const replayReady = new Promise<void>((resolve) => {
          queueMicrotask(() => {
            listener(event(2));
            listener(event(3));
            listener(event(3));
            listener(event(4));
            // Arrives at the replay/live boundary and must follow the snapshot checkpoint.
            listener(event(5));
            resolve();
          });
        });
        return Object.assign(
          () => {
            unsubscribeCount += 1;
          },
          { replayReady },
        );
      },
    } as unknown as ConversationService;
    const url = new URL(
      "http://local/api/conversations/conversation-a/events?stream_token=good&since=1",
    );
    const response = await handleConversationSse(
      {
        service,
        tokens: { authorize: () => true },
        heartbeatMs: 0,
      },
      new Request(url.toString()),
      url,
      "conversation-a",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing SSE body");
    let output = "";
    for (let index = 0; index < 8; index += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
      if (output.includes("id: 5\nevent: trace") && output.includes("event: snapshot")) break;
    }
    await reader.cancel();
    expect(subscribedAfter).toBe(1);
    expect(output.match(/event: snapshot/g)).toHaveLength(1);
    expect(output.match(/id: 2\nevent: trace/g)).toHaveLength(1);
    expect(output.match(/id: 3\nevent: trace/g)).toHaveLength(1);
    expect(output.match(/id: 4\nevent: trace/g)).toHaveLength(1);
    expect(output.match(/id: 5\nevent: trace/g)).toHaveLength(1);
    expect(output.indexOf("id: 2\nevent: trace")).toBeLessThan(
      output.indexOf("id: 3\nevent: trace"),
    );
    expect(output.indexOf("id: 4\nevent: trace")).toBeLessThan(output.indexOf("event: snapshot"));
    expect(output.indexOf("event: snapshot")).toBeLessThan(output.indexOf("id: 5\nevent: trace"));
    expect([...output.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual([
      2, 3, 4, 4, 5,
    ]);
    expect(unsubscribeCount).toBe(1);
  });

  test("emits one typed error and closes when asynchronous journal replay fails", async () => {
    let unsubscribeCount = 0;
    const replayReady = Promise.reject(new Error("journal read failed"));
    void replayReady.catch(() => undefined);
    const service = {
      snapshot: async () => ({ ...snapshot, last_seq: 0 }),
      subscribe: () =>
        Object.assign(
          () => {
            unsubscribeCount += 1;
          },
          { replayReady },
        ),
    } as unknown as ConversationService;
    const url = new URL("http://local/api/conversations/conversation-a/events?stream_token=good");
    const response = await handleConversationSse(
      { service, tokens: { authorize: () => true }, heartbeatMs: 1 },
      new Request(url.toString()),
      url,
      "conversation-a",
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing SSE body");
    let output = "";
    try {
      for (let index = 0; index < 2; index += 1) {
        const part = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("stream did not settle")), 100),
          ),
        ]);
        if (part.done) break;
        output += new TextDecoder().decode(part.value);
      }
    } finally {
      await reader.cancel();
    }
    expect(output).toContain("event: error");
    expect(output).toContain('"code":"service_unavailable"');
    expect(output).not.toContain("event: heartbeat");
    expect(unsubscribeCount).toBe(1);
  });

  test("fails closed when a subscription omits replay readiness", async () => {
    let unsubscribeCount = 0;
    const service = {
      snapshot: async () => snapshot,
      subscribe(_id: string, listener: (value: PublicStoredTraceEvent) => void) {
        listener(event(2));
        return () => {
          unsubscribeCount += 1;
        };
      },
    } as unknown as ConversationService;
    const url = new URL(
      "http://local/api/conversations/conversation-a/events?stream_token=good&since=1",
    );
    const response = await handleConversationSse(
      { service, tokens: { authorize: () => true }, heartbeatMs: 0 },
      new Request(url.toString()),
      url,
      "conversation-a",
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing SSE body");
    const first = await reader.read();
    const second = await reader.read();
    await reader.cancel();
    const output = first.done ? "" : new TextDecoder().decode(first.value);
    expect(output).toContain("event: error");
    expect(output).toContain('"code":"service_unavailable"');
    expect(output).not.toContain("event: trace");
    expect(output).not.toContain("event: snapshot");
    expect(second.done).toBe(true);
    expect(unsubscribeCount).toBe(1);
  });

  test("returns 404 for an unknown conversation without opening a subscription", async () => {
    let subscriptions = 0;
    const service = {
      snapshot: async () => null,
      subscribe: () => {
        subscriptions += 1;
        return () => undefined;
      },
    } as unknown as ConversationService;
    const url = new URL(
      "http://local/api/conversations/missing/events?stream_token=token-token-token-token-token-token-token-token",
    );
    const response = await handleConversationSse(
      { service, tokens: { authorize: () => true }, heartbeatMs: 0 },
      new Request(url.toString()),
      url,
      "missing",
    );
    expect(response.status).toBe(404);
    expect(subscriptions).toBe(0);
  });

  test("aborting the request closes the stream and unsubscribes exactly once", async () => {
    let unsubscribeCount = 0;
    const service = {
      snapshot: async () => snapshot,
      subscribe: () =>
        Object.assign(
          () => {
            unsubscribeCount += 1;
          },
          { replayReady: Promise.resolve() },
        ),
    } as unknown as ConversationService;
    const abort = new AbortController();
    const url = new URL("http://local/api/conversations/conversation-a/events?stream_token=good");
    const response = await handleConversationSse(
      { service, tokens: { authorize: () => true }, heartbeatMs: 0 },
      new Request(url.toString(), { signal: abort.signal }),
      url,
      "conversation-a",
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing SSE body");
    expect((await reader.read()).done).toBe(false);
    abort.abort();
    expect((await reader.read()).done).toBe(true);
    await reader.cancel();
    expect(unsubscribeCount).toBe(1);
  });

  test("an abort racing with subscription handoff still releases the returned handle once", async () => {
    let unsubscribeCount = 0;
    const abort = new AbortController();
    const service = {
      snapshot: async () => snapshot,
      subscribe: () => {
        abort.abort();
        return () => {
          unsubscribeCount += 1;
        };
      },
    } as unknown as ConversationService;
    const url = new URL("http://local/api/conversations/conversation-a/events?stream_token=good");
    const response = await handleConversationSse(
      { service, tokens: { authorize: () => true }, heartbeatMs: 0 },
      new Request(url.toString(), { signal: abort.signal }),
      url,
      "conversation-a",
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing SSE body");
    expect((await reader.read()).done).toBe(true);
    await reader.cancel();
    expect(unsubscribeCount).toBe(1);
  });
});
