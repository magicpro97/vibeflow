import { describe, expect, test } from "bun:test";
import type {
  ConversationListener,
  ConversationService,
  ConversationSnapshot,
  Unsubscribe,
} from "../src/orchestrator/conversation/types.js";
import type { PublicStoredTraceEvent } from "../src/orchestrator/trace/types.js";
import {
  conversationUrlHost,
  isConversationLoopbackHost,
} from "../src/server/conversation-host.js";
import {
  type ConversationHttpAuthority,
  handleConversationRoute,
} from "../src/server/conversation-route.js";
import { handleConversationSse } from "../src/server/conversation-sse.js";

const snapshot: ConversationSnapshot = {
  conversation_id: "conversation-a",
  lifecycle: "ACTIVE",
  health: "healthy",
  policy: "direct",
  topic: "coverage",
  participants: [],
  rounds: [],
  consensus_score: null,
  last_seq: 4,
};

const traceEvent = (seq: number): PublicStoredTraceEvent =>
  ({
    workflow_id: "workflow-a",
    conversation_id: "conversation-a",
    revision_id: "revision-a",
    run_id: "run-a",
    turn_id: `turn-${seq}`,
    operation_id: "operation-a",
    attempt_id: "attempt-a",
    event_id: `event-${seq}`,
    seq,
    ts: "2026-08-23T00:00:00.000Z",
    public_session_ref: null,
    event: {
      type: "error",
      payload: { agent_id: null, code: `code-${seq}`, message: `message-${seq}` },
    },
  }) as PublicStoredTraceEvent;

const baseService = (overrides: Record<string, unknown> = {}) =>
  ({
    start: async () => {
      throw new Error("not used");
    },
    message: async () => {
      throw new Error("not used");
    },
    pause: async () => {
      throw new Error("not used");
    },
    resume: async () => {
      throw new Error("not used");
    },
    stop: async () => {
      throw new Error("not used");
    },
    snapshot: async () => snapshot,
    resolveApproval: async () => {
      throw new Error("not used");
    },
    cancelOperation: async () => {
      throw new Error("not used");
    },
    ...overrides,
  }) as unknown as ConversationService;

const httpAuthority = (service: ConversationService): ConversationHttpAuthority => ({
  service,
  sessions: { loopback: true, authorize: () => true, issueCookie: () => null },
  streamTokens: {
    authorize: () => true,
    issue: () => ({ stream_token: "token", stream_token_expires_at: "never" }),
  },
  csrf: () => true,
});

const route = (authority: ConversationHttpAuthority, request: Request) =>
  handleConversationRoute(authority, request, new URL(request.url));

const sseUrl = () =>
  new URL("http://local/api/conversations/conversation-a/events?stream_token=good");

async function responseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing response stream");
  let value = "";
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    value += new TextDecoder().decode(part.value);
  }
  return value;
}

describe("conversation server final behavioral coverage", () => {
  test("normalizes bracketed IPv6 hosts and rejects malformed bracket authorities", () => {
    expect(isConversationLoopbackHost("[::1]:4321")).toBe(true);
    expect(isConversationLoopbackHost("[::1]")).toBe(true);
    expect(isConversationLoopbackHost("[::1")).toBe(false);
    expect(isConversationLoopbackHost("[::1]:port")).toBe(false);
    expect(conversationUrlHost("::1")).toBe("[::1]");
  });

  test("rejects stream read failures, invalid UTF-8, malformed JSON, and missing snapshots", async () => {
    const authority = httpAuthority(baseService());
    const failedStream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("body read failed");
      },
    });
    const failedRead = new Request("http://local/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: failedStream,
    });
    expect((await route(authority, failedRead)).status).toBe(400);

    const invalidUtf8 = new Request("http://local/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0xff]),
    });
    expect((await route(authority, invalidUtf8)).status).toBe(400);

    const malformedJson = new Request("http://local/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect((await route(authority, malformedJson)).status).toBe(400);

    const missing = httpAuthority(baseService({ snapshot: async () => null }));
    const missingResponse = await route(
      missing,
      new Request("http://local/api/conversations/conversation-a/snapshot"),
    );
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({ code: "conversation_not_found" });
  });

  test("maps snapshot and subscription authority failures without opening a live stream", async () => {
    const url = sseUrl();
    const snapshotFailure = await handleConversationSse(
      {
        service: baseService({ snapshot: async () => Promise.reject(new Error("read failed")) }),
        tokens: { authorize: () => true },
      },
      new Request(url.toString()),
      url,
      "conversation-a",
    );
    expect(snapshotFailure.status).toBe(500);

    const throws = await handleConversationSse(
      {
        service: baseService({
          subscribe: () => {
            throw new Error("subscribe failed");
          },
        }),
        tokens: { authorize: () => true },
        heartbeatMs: 0,
      },
      new Request(url.toString()),
      url,
      "conversation-a",
    );
    expect(await responseText(throws)).toContain('"code":"stream_unavailable"');

    const missing = await handleConversationSse(
      {
        service: baseService({ subscribe: () => null }),
        tokens: { authorize: () => true },
        heartbeatMs: 0,
      },
      new Request(url.toString()),
      url,
      "conversation-a",
    );
    expect(await responseText(missing)).toContain('"code":"conversation_not_found"');
  });

  test("closes immediately when the request arrives already aborted", async () => {
    let subscriptions = 0;
    const abort = new AbortController();
    abort.abort();
    const url = sseUrl();
    const response = await handleConversationSse(
      {
        service: baseService({
          subscribe: () => {
            subscriptions += 1;
            return Object.assign(() => undefined, { replayReady: Promise.resolve() });
          },
        }),
        tokens: { authorize: () => true },
        heartbeatMs: 0,
      },
      new Request(url.toString(), { signal: abort.signal }),
      url,
      "conversation-a",
    );
    expect(await responseText(response)).toBe("");
    expect(subscriptions).toBe(0);
  });

  test("delivers post-replay events and fails closed when frame serialization throws", async () => {
    let listener: ConversationListener | undefined;
    let unsubscribes = 0;
    const service = baseService({
      subscribe(_id: string, next: ConversationListener) {
        listener = next;
        return Object.assign(
          () => {
            unsubscribes += 1;
          },
          { replayReady: Promise.resolve() },
        ) as Unsubscribe;
      },
    });
    const url = sseUrl();
    const response = await handleConversationSse(
      { service, tokens: { authorize: () => true }, heartbeatMs: 0 },
      new Request(url.toString()),
      url,
      "conversation-a",
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response stream");
    const initial = await reader.read();
    expect(initial.done).toBe(false);
    listener?.(traceEvent(5));
    const live = await reader.read();
    expect(new TextDecoder().decode(live.value)).toContain("id: 5\nevent: trace");

    const invalid = traceEvent(6) as PublicStoredTraceEvent & {
      event: { payload: { leaked_bigint: bigint } };
    };
    invalid.event.payload.leaked_bigint = 1n;
    listener?.(invalid);
    expect((await reader.read()).done).toBe(true);
    expect(unsubscribes).toBe(1);
  });

  test("starts and cancels a real heartbeat after replay readiness", async () => {
    const service = baseService({
      subscribe: () => Object.assign(() => undefined, { replayReady: Promise.resolve() }),
    });
    const url = sseUrl();
    const response = await handleConversationSse(
      { service, tokens: { authorize: () => true }, heartbeatMs: 1 },
      new Request(url.toString()),
      url,
      "conversation-a",
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response stream");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: snapshot");
    const heartbeat = await reader.read();
    expect(new TextDecoder().decode(heartbeat.value)).toContain("event: heartbeat");
    await reader.cancel();
  });
});
