const { describe, expect, test } = await import(String("bun:test"));
import { UI_LAN_TOKEN_HEADER } from "../../../core/ui-cli-contract.js";
import {
  ConversationApiError,
  cancelConversationOperation,
  conversationApi,
  conversationArtifactUrl,
  conversationEventsUrl,
  createConversation,
  parseConversationSseRecord,
  parseConversationSseSnapshot,
  pauseConversation,
  renewConversationStreamToken,
  resolveConversationApproval,
  resumeConversation,
  sendConversationMessage,
  snapshotConversation,
  stopConversation,
} from "../conversation-api.js";
import {
  isConversationPublicTraceRecordWireV1,
  isConversationSnapshotWireV1,
} from "../conversation-public-wire.js";
import type { ConversationSnapshot, ConversationTraceRecord } from "../conversation-types.js";

const snapshot = (): ConversationSnapshot => ({
  conversation_id: "conversation-a",
  lifecycle: "ACTIVE",
  health: "healthy",
  policy: "direct",
  topic: "Validate public boundaries",
  participants: [
    {
      participant_id: "participant-a",
      role_ref: "direct",
      engine: "codex",
      model: "gpt-5.4",
      public_session_ref: null,
    },
  ],
  rounds: [],
  consensus_score: null,
  last_seq: 1,
});

const trace = (): ConversationTraceRecord => ({
  workflow_id: "workflow-a",
  conversation_id: "conversation-a",
  revision_id: "revision-a",
  run_id: "run-a",
  turn_id: "turn-a",
  operation_id: "operation-a",
  attempt_id: "attempt-a",
  event_id: "event-a",
  seq: 2,
  ts: "2026-08-26T00:00:00.000Z",
  public_session_ref: null,
  event: {
    type: "user_message",
    payload: { content: "Continue", target_participants: "all" },
  },
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const stubFetch = (handler: (path: string, init: RequestInit) => Promise<Response>) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (path, init) =>
    handler(String(path), (init ?? {}) as RequestInit)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
};

describe("conversation-api HTTP and parsing coverage", () => {
  test("jsonRequest GET success and POST with body, headers, and signal", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const restore = stubFetch(async (path, init) => {
      calls.push({ path, init });
      return jsonResponse({ ok: true });
    });
    const signal = new AbortController().signal;
    try {
      await createConversation({ topic: "t" } as never, signal);
      expect(calls).toHaveLength(1);
      const recorded = calls.at(0) as { init: RequestInit };
      expect(recorded.init.method).toBe("POST");
      expect(recorded.init.signal).toBe(signal);
      expect(recorded.init.headers).toMatchObject({ "content-type": "application/json" });
      expect(recorded.init.body).toBe(JSON.stringify({ topic: "t" }));
    } finally {
      restore();
    }
  });

  test("jsonRequest rejects non-JSON success bodies with ConversationApiError", async () => {
    const restore = stubFetch(
      async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    try {
      await expect(createConversation({ topic: "t" } as never)).rejects.toMatchObject({
        name: "ConversationApiError",
        status: 200,
        code: null,
        message: "conversation response was invalid",
      });
    } finally {
      restore();
    }
  });

  test("readError prefers trimmed body message and falls back to code", async () => {
    let mode = 0;
    const restore = stubFetch(async () => {
      mode += 1;
      if (mode === 1)
        return jsonResponse({ code: "bad-topic", message: "  topic too long  " }, 400);
      if (mode === 2) return jsonResponse({ code: "bad-topic" }, 400);
      return new Response("not json", { status: 500, headers: { "content-type": "text/plain" } });
    });
    try {
      const first = await expect(createConversation({ topic: "" } as never)).rejects;
      await first.toMatchObject({ status: 400, code: "bad-topic", message: "topic too long" });
      const second = await expect(createConversation({ topic: "" } as never)).rejects;
      await second.toMatchObject({ status: 400, code: "bad-topic", message: "bad-topic" });
      const third = await expect(createConversation({ topic: "" } as never)).rejects;
      await third.toMatchObject({
        status: 500,
        code: null,
        message: "conversation request failed (500)",
      });
    } finally {
      restore();
    }
  });

  test("snapshotConversation validates identity and shape", async () => {
    const restore = stubFetch(async () => jsonResponse(snapshot()));
    try {
      await expect(snapshotConversation("conversation-a")).resolves.toEqual(snapshot());
    } finally {
      restore();
    }
    const wrongId = stubFetch(async () => jsonResponse(snapshot()));
    try {
      await expect(snapshotConversation("conversation-b")).rejects.toMatchObject({
        status: 200,
        code: null,
        message: "conversation response was invalid",
      });
    } finally {
      wrongId();
    }
    const invalidShape = stubFetch(async () => jsonResponse({ conversation_id: "conversation-a" }));
    try {
      await expect(snapshotConversation("conversation-a")).rejects.toMatchObject({
        status: 200,
        code: null,
        message: "conversation response was invalid",
      });
    } finally {
      invalidShape();
    }
  });

  test("write endpoints POST to their exact routes", async () => {
    const calls: Array<string> = [];
    const restore = stubFetch(async (path, init) => {
      calls.push(`${init.method} ${path}`);
      return jsonResponse({ ok: true });
    });
    try {
      await renewConversationStreamToken("conversation-a");
      await sendConversationMessage("conversation-a", { content: "hi" } as never);
      await pauseConversation("conversation-a");
      await resumeConversation("conversation-a");
      await stopConversation("conversation-a");
      await resolveConversationApproval("conversation-a", "approval-1", { approve: true } as never);
      await cancelConversationOperation("conversation-a", { operation_id: "op-1" } as never);
      expect(calls).toEqual([
        "POST /api/conversations/conversation-a/stream-token",
        "POST /api/conversations/conversation-a/messages",
        "POST /api/conversations/conversation-a/pause",
        "POST /api/conversations/conversation-a/resume",
        "POST /api/conversations/conversation-a/stop",
        "POST /api/conversations/conversation-a/approvals/approval-1/resolve",
        "POST /api/conversations/conversation-a/operations/op-1/cancel",
      ]);
    } finally {
      restore();
    }
  });

  test("conversationApi facade forwards every operation", async () => {
    const restored: Array<() => void> = [];
    try {
      let calls = 0;
      restored.push(
        stubFetch(async () => {
          calls += 1;
          return jsonResponse({ ok: true });
        }),
      );
      await conversationApi.create({ topic: "t" } as never);
      await conversationApi.renewStreamToken("conversation-a");
      await conversationApi.message("conversation-a", { content: "hi" } as never);
      await conversationApi.pause("conversation-a");
      await conversationApi.resume("conversation-a");
      await conversationApi.stop("conversation-a");
      await conversationApi.resolveApproval("conversation-a", "approval-1", {
        approve: true,
      } as never);
      await conversationApi.cancelOperation("conversation-a", { operation_id: "op-1" } as never);
      expect(calls).toBe(8);
    } finally {
      for (const restore of restored) restore();
    }
  });

  test("conversationEventsUrl omits and includes the since cursor", () => {
    expect(conversationEventsUrl("conversation-a", "token-1")).toBe(
      "/api/conversations/conversation-a/events?stream_token=token-1",
    );
    expect(conversationEventsUrl("conversation-a", "token-1", 5)).toBe(
      "/api/conversations/conversation-a/events?stream_token=token-1&since=5",
    );
  });

  test("conversationArtifactUrl encodes conversation and artifact ids", () => {
    expect(conversationArtifactUrl("conversation a", "artifact/b")).toBe(
      "/api/conversations/conversation%20a/artifacts/artifact%2Fb",
    );
  });

  test("parseConversationSseRecord accepts valid traces and rejects invalid ones", () => {
    expect(parseConversationSseRecord(JSON.stringify(trace()))).toEqual(trace());
    expect(() => parseConversationSseRecord(JSON.stringify({ nope: true }))).toThrow(
      /conversation.*trace/i,
    );
    expect(() => parseConversationSseRecord("not json")).toThrow();
  });

  test("parseConversationSseSnapshot validates and checks the conversation id", () => {
    expect(parseConversationSseSnapshot(JSON.stringify(snapshot()))).toEqual(snapshot());
    expect(parseConversationSseSnapshot(JSON.stringify(snapshot()), "conversation-a")).toEqual(
      snapshot(),
    );
    expect(() =>
      parseConversationSseSnapshot(JSON.stringify(snapshot()), "conversation-b"),
    ).toThrow(/conversation response was invalid/);
    expect(() =>
      parseConversationSseSnapshot(JSON.stringify({ conversation_id: "conversation-a" })),
    ).toThrow(/conversation response was invalid/);
  });

  test("public wire validators agree with the API on fixtures", () => {
    expect(isConversationPublicTraceRecordWireV1(trace())).toBe(true);
    expect(isConversationSnapshotWireV1(snapshot())).toBe(true);
  });
});
