import { describe, expect, test } from "bun:test";
import { isPlainWireRecord } from "../src/actions/public-wire-primitives.js";
import { digestV1 } from "../src/durability/index.js";
import {
  CONVERSATION_ASK_COMPATIBILITY_REQUEST_KIND,
  CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND,
  type ConversationAskCompatibilityRequestV1,
  type ConversationAskCompatibilityResultV1,
} from "../src/orchestrator/conversation/conversation-ask-compatibility.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
} from "../src/orchestrator/conversation/conversation-message-queue-contract.js";
import { CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE } from "../src/orchestrator/conversation/conversation-message-queue-error-contract.js";
import { assertQueueJournalAppendCapacity } from "../src/orchestrator/conversation/conversation-message-queue-journal.js";
import { ConversationPrivateContextBrokerConflictError } from "../src/orchestrator/conversation/conversation-private-context-broker-validation.js";
import {
  ASK_COMPATIBILITY_SSE_EVENT,
  ASK_SSE_EVENT,
} from "../src/orchestrator/conversation/conversation-sse-contract.js";
import {
  type ConversationAskCompatibilityHttpAuthorityV1,
  handleConversationAskCompatibilityRoute,
  handleConversationAskCompatibilityStream,
} from "../src/server/conversation-ask-compatibility-route.js";
import { handleMutationRoute } from "../src/server/routes.js";

const digest = (label: string) => digestV1("VF-ASK-COMPATIBILITY-TEST\0v1\0", { label });

function principal() {
  return {
    schema_version: "1.0" as const,
    principal_digest: digest("principal"),
    authority_scope_digest: digest("scope"),
    control_session_digest: digest("session"),
    csrf_epoch_digest: digest("csrf"),
    actor: {
      kind: "human-browser" as const,
      public_actor_id: "browser-test",
      credential_class: "loopback-session" as const,
    },
  };
}

function authority(
  submit: ConversationAskCompatibilityHttpAuthorityV1["submit"],
  options: { authenticated?: boolean; csrf?: boolean } = {},
): ConversationAskCompatibilityHttpAuthorityV1 {
  return {
    sessions: { authorize: () => options.authenticated ?? true },
    csrf: () => options.csrf ?? true,
    principal: () => principal(),
    submit,
  };
}

const request = (
  body: unknown,
  headers: Record<string, string> = { "idempotency-key": "ask-test-default" },
) =>
  new Request("http://local/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const fresh = {
  path: "src/example.ts",
  start: 4,
  end: 7,
  question: "Explain this range",
  engine: "codex",
};

describe("Ask conversation compatibility facade", () => {
  test("normalizes fresh file/range input into the shared create adapter", async () => {
    const captured: Array<{
      principal_digest: string;
      idempotency_key: string;
      request: ConversationAskCompatibilityRequestV1;
    }> = [];
    const submit = (input: (typeof captured)[number]): ConversationAskCompatibilityResultV1 => {
      captured.push(input);
      return {
        kind: CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.CREATED,
        conversation_id: "conversation-created",
        replayed: false,
      };
    };
    const response = await handleConversationAskCompatibilityRoute(
      authority(submit),
      request(fresh),
      "/repo",
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      schema_version: "1.0",
      accepted: true,
      kind: CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.CREATED,
      conversation_id: "conversation-created",
      replayed: false,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      principal_digest: principal().principal_digest,
      request: {
        kind: CONVERSATION_ASK_COMPATIBILITY_REQUEST_KIND.FRESH,
        question: fresh.question,
        engine: "codex",
        repo_relative_path: "src/example.ts",
        start_line: 4,
        end_line: 7,
      },
    });
    expect(captured[0]?.idempotency_key).toBe("ask-test-default");
    expect(JSON.stringify(body)).not.toContain("src/example.ts");
  });

  test("uses an explicit idempotency header and returns 200 for exact replay", async () => {
    const keys: string[] = [];
    const response = await handleConversationAskCompatibilityRoute(
      authority((input) => {
        keys.push(input.idempotency_key);
        return {
          kind: CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.CREATED,
          conversation_id: "conversation-created",
          replayed: true,
        };
      }),
      request(fresh, { "idempotency-key": "ask-script-retry" }),
      "/repo",
    );
    expect(response.status).toBe(200);
    expect(keys).toEqual(["ask-script-retry"]);
  });

  test("requires caller idempotency and distinguishes replay, unequal reuse, and a new send", async () => {
    const bindings = new Map<string, string>();
    const submit: ConversationAskCompatibilityHttpAuthorityV1["submit"] = (input) => {
      const canonical = JSON.stringify(input.request);
      const prior = bindings.get(input.idempotency_key);
      if (prior !== undefined && prior !== canonical)
        throw new ConversationPrivateContextBrokerConflictError(
          "idempotency_conflict",
          "Ask key conflict",
        );
      bindings.set(input.idempotency_key, canonical);
      return {
        kind: CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.CREATED,
        conversation_id: `conversation-${input.idempotency_key}`,
        replayed: prior !== undefined,
      };
    };
    const missing = await handleConversationAskCompatibilityRoute(
      authority(submit),
      request(fresh, {}),
      "/repo",
    );
    expect(missing.status).toBe(400);
    const first = await handleConversationAskCompatibilityRoute(
      authority(submit),
      request(fresh, { "idempotency-key": "ask-one" }),
      "/repo",
    );
    const replay = await handleConversationAskCompatibilityRoute(
      authority(submit),
      request(fresh, { "idempotency-key": "ask-one" }),
      "/repo",
    );
    const second = await handleConversationAskCompatibilityRoute(
      authority(submit),
      request(fresh, { "idempotency-key": "ask-two" }),
      "/repo",
    );
    const conflict = await handleConversationAskCompatibilityRoute(
      authority(submit),
      request({ ...fresh, question: "different" }, { "idempotency-key": "ask-one" }),
      "/repo",
    );
    expect([first.status, replay.status, second.status, conflict.status]).toEqual([
      202, 200, 202, 409,
    ]);
    expect(bindings).toHaveLength(2);
  });

  test("requires an explicit durable conversation identity for resume and queues it", async () => {
    let calls = 0;
    const submit = (input: {
      principal_digest: string;
      idempotency_key: string;
      request: ConversationAskCompatibilityRequestV1;
    }): ConversationAskCompatibilityResultV1 => {
      calls += 1;
      expect(input.request).toEqual({
        kind: CONVERSATION_ASK_COMPATIBILITY_REQUEST_KIND.RESUME,
        conversation_id: "conversation-head",
        question: "continue",
      });
      return {
        kind: CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.QUEUED,
        conversation_id: "conversation-head",
        root_session_id: "conversation-root",
        queue_item_id: `vf-queued-message-${"a".repeat(64)}`,
        replayed: false,
      };
    };
    const missing = await handleConversationAskCompatibilityRoute(
      authority(submit),
      request({ resume: true, question: "continue", engine: "claude" }),
      "/repo",
    );
    expect(missing.status).toBe(400);
    expect(calls).toBe(0);
    const misleadingEngine = await handleConversationAskCompatibilityRoute(
      authority(submit),
      request({
        resume: true,
        conversation_id: "conversation-head",
        question: "continue",
        engine: "claude",
      }),
      "/repo",
    );
    expect(misleadingEngine.status).toBe(400);
    expect(calls).toBe(0);
    const accepted = await handleConversationAskCompatibilityRoute(
      authority(submit),
      request({
        resume: true,
        conversation_id: "conversation-head",
        question: "continue",
      }),
      "/repo",
    );
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      accepted: true,
      kind: CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.QUEUED,
      conversation_id: "conversation-head",
    });
    expect(calls).toBe(1);
  });

  test("authenticates and validates CSRF before decoding or admission", async () => {
    let calls = 0;
    const submit = (): ConversationAskCompatibilityResultV1 => {
      calls += 1;
      return {
        kind: CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.CREATED,
        conversation_id: "conversation-created",
        replayed: false,
      };
    };
    expect(
      (
        await handleConversationAskCompatibilityRoute(
          authority(submit, { authenticated: false }),
          request("{"),
          "/repo",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleConversationAskCompatibilityRoute(
          authority(submit, { csrf: false }),
          request(fresh),
          "/repo",
        )
      ).status,
    ).toBe(403);
    expect(calls).toBe(0);
  });

  test("rejects duplicate, unknown, escaping, and over-broker-range inputs", async () => {
    const submit = (): ConversationAskCompatibilityResultV1 => {
      throw new Error("must not submit");
    };
    const invalid = [
      `{"path":"src/a.ts","path":"src/b.ts","start":1,"end":1,"question":"q"}`,
      { ...fresh, unknown: true },
      { ...fresh, path: "../outside.ts" },
      { ...fresh, start: 1, end: 201 },
    ];
    for (const body of invalid) {
      const response = await handleConversationAskCompatibilityRoute(
        authority(submit),
        request(body),
        "/repo",
      );
      expect(response.status).toBe(400);
    }
  });

  test("stream compatibility emits accepted metadata and never invokes native token output", async () => {
    const response = await handleConversationAskCompatibilityStream(
      authority(() => ({
        kind: CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.QUEUED,
        conversation_id: "conversation-head",
        root_session_id: "conversation-root",
        queue_item_id: `vf-queued-message-${"b".repeat(64)}`,
        replayed: false,
      })),
      new Request("http://local/api/ask/stream"),
      "/repo",
      { resume: true, conversation_id: "conversation-head", question: "continue" },
      "ask-stream-resume",
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain(`event: ${ASK_COMPATIBILITY_SSE_EVENT.ACCEPTED}`);
    expect(text).toContain(`event: ${ASK_COMPATIBILITY_SSE_EVENT.DONE}`);
    expect(text).not.toContain(`event: ${ASK_SSE_EVENT.TOKEN}`);
    expect(text).not.toContain("answer");
  });

  test("contains queue-full for JSON and stream with the typed durable root", async () => {
    const durableRoot = "durable-root-session";
    const submit = (): ConversationAskCompatibilityResultV1 => {
      assertQueueJournalAppendCapacity(
        CONVERSATION_MESSAGE_QUEUE_LIMITS.maxJournalEvents,
        durableRoot,
      );
      throw new Error("expected journal capacity conflict");
    };
    const body = { resume: true, conversation_id: "conversation-head", question: "continue" };
    const json = await handleConversationAskCompatibilityRoute(
      authority(submit),
      request(body),
      "/repo",
    );
    const stream = await handleConversationAskCompatibilityStream(
      authority(submit),
      new Request("http://local/api/ask/stream"),
      "/repo",
      body,
      "ask-stream-full",
    );
    for (const response of [json, stream]) {
      expect(response.status).toBe(429);
      expect(response.headers.get("content-type")).toContain("application/json");
      const payload: unknown = await response.json();
      if (!isPlainWireRecord(payload) || !isPlainWireRecord(payload.error))
        throw new Error("expected queue error envelope");
      expect(Object.keys(payload)).toEqual(["schema_version", "error"]);
      expect(Object.keys(payload.error).sort()).toEqual(
        ["code", "message", "correlation_id", "retryable", "recovery_action", "details"].sort(),
      );
      expect(payload).toMatchObject({
        error: {
          code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
          message:
            CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
              CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL
            ],
          retryable: true,
          recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY,
          details: {
            root_session_id: durableRoot,
            max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
          },
        },
      });
    }
  });

  test("production mutation router reaches only the conversation Ask authority", async () => {
    let calls = 0;
    const ask = authority(() => {
      calls += 1;
      return {
        kind: CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.CREATED,
        conversation_id: "conversation-created",
        replayed: false,
      };
    });
    const req = request(fresh);
    const response = await handleMutationRoute(
      {
        getActiveRepo: () => "/repo",
        setActiveRepo: () => undefined,
        askCompatibility: ask,
      },
      "POST",
      "/api/ask",
      req,
      new URL(req.url),
    );
    expect(response?.status).toBe(202);
    expect(calls).toBe(1);
  });
});
