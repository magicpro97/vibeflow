import { describe, expect, test } from "bun:test";
import { digestV1 } from "../src/durability/index.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODES,
  CONVERSATION_MESSAGE_QUEUE_INTERNAL_ERROR_CODES,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_PUBLIC_ERROR_CODES,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  isConversationMessageQueueInternalErrorCode,
  isConversationMessageQueuePublicErrorCode,
} from "../src/orchestrator/conversation/conversation-message-queue-contract.js";
import { CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE } from "../src/orchestrator/conversation/conversation-message-queue-error-contract.js";
import type {
  ConversationMessageQueueSnapshotV1,
  PublicQueuedUserMessageV1,
} from "../src/orchestrator/conversation/conversation-message-queue-records.js";
import { ConversationMessageQueueConflictError } from "../src/orchestrator/conversation/conversation-message-queue-validation.js";
import { ConversationMessageQueueCorruptError } from "../src/orchestrator/conversation/conversation-message-queue-validation.js";
import { ConversationPrivateContextBrokerConflictError } from "../src/orchestrator/conversation/conversation-private-context-broker-validation.js";
import { ConversationMessageTargetConflictError } from "../src/orchestrator/conversation/conversation-user-message-authority.js";
import {
  handleConversationAskCompatibilityRoute,
  handleConversationAskCompatibilityStream,
} from "../src/server/conversation-ask-compatibility-route.js";
import {
  type ConversationBrowserHttpAuthorityV1,
  handleConversationBrowserRoute,
} from "../src/server/conversation-browser-route.js";
import {
  type ConversationCompatibilityMessageAuthorityV1,
  handleConversationCompatibilityMessageRoute,
} from "../src/server/conversation-compatibility-message-route.js";
import {
  type ConversationHomeCreateHttpAuthorityV1,
  handleConversationHomeCreateRoute,
} from "../src/server/conversation-home-create-route.js";
import {
  messageQueueRouteError,
  queueErrorBody,
} from "../src/server/conversation-message-queue-http.js";
import type { ConversationMessageQueueHttpAuthorityV1 } from "../src/server/conversation-message-queue-route.js";
import {
  handleConversationDraftPrivateContextRoute,
  handleConversationMessageQueueRoute,
} from "../src/server/conversation-message-queue-route.js";
import {
  type ConversationHttpAuthority,
  handleConversationRoute,
} from "../src/server/conversation-route.js";

const rootSessionId = "conversation-root";
const queueItemId = `vf-queued-message-${"a".repeat(64)}`;
const digest = (label: string) => digestV1("VF-QUEUE-HTTP-TEST\0v1\0", { label });

const item = (state: PublicQueuedUserMessageV1["state"] = "queued") =>
  ({
    schema_version: "1.0",
    queue_item_id: queueItemId,
    queue_sequence: 1,
    root_session_id: rootSessionId,
    author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
    content: "queued content",
    content_digest: digest("content"),
    target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
    quote_refs: [],
    private_context_present: false,
    predecessor_queue_item_id: null,
    admitted_authority_digest: digest("authority"),
    effective_authority_digest: digest("authority"),
    state,
    stale_reason: null,
    admitted_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    item_digest: digest(`item-${state}`),
  }) as PublicQueuedUserMessageV1;

const snapshot = (): ConversationMessageQueueSnapshotV1 => ({
  schema_version: "1.0",
  root_session_id: rootSessionId,
  current_authority_digest: digest("authority"),
  max_nonterminal_items: 32,
  items: [item()],
});

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

function queueAuthority(
  overrides: Partial<ConversationMessageQueueHttpAuthorityV1["queue"]> = {},
  options: { authenticated?: boolean; csrf?: boolean } = {},
): ConversationMessageQueueHttpAuthorityV1 {
  return {
    sessions: { authorize: () => options.authenticated ?? true },
    csrf: () => options.csrf ?? true,
    principal: () => principal(),
    queue: {
      assertRoot: () => undefined,
      snapshot,
      enqueue: () => ({ item: item(), replayed: false }),
      edit: () => ({ item: item(), replayed: false }),
      item: () => item(),
      stageMessagePrivateContext: () => ({
        presence: { schema_version: "1.0", private_context_present: true },
        replayed: false,
      }),
      discardMessagePrivateContext: () => ({
        presence: { schema_version: "1.0", private_context_present: false },
        replayed: false,
      }),
      stageDraftPrivateContext: () => ({
        presence: { schema_version: "1.0", private_context_present: true },
        replayed: false,
      }),
      discardDraftPrivateContext: () => ({
        presence: { schema_version: "1.0", private_context_present: false },
        replayed: false,
      }),
      ...overrides,
    },
  };
}

const jsonRequest = (url: string, method: string, body: unknown, headers = {}) =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const enqueueBody = {
  schema_version: "1.0",
  idempotency_key: "enqueue-http",
  expected_authority_digest: digest("authority"),
  client_instance_id: "enqueue-http-client",
  client_order: 1,
  content: "queued content",
  target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
  quote_refs: [],
  private_context_present: false,
};

describe("conversation message queue HTTP contract", () => {
  test("authenticates and validates CSRF before parsing or touching queue authority", async () => {
    let roots = 0;
    const denied = queueAuthority(
      {
        assertRoot: () => {
          roots += 1;
        },
      },
      { authenticated: false },
    );
    const unauthenticated = await handleConversationMessageQueueRoute(
      denied,
      jsonRequest("http://local/queue", "POST", "{"),
      rootSessionId,
      ["queue"],
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toBe("no-store");
    expect(roots).toBe(0);

    const forbidden = await handleConversationMessageQueueRoute(
      queueAuthority(
        {
          assertRoot: () => {
            roots += 1;
          },
        },
        { csrf: false },
      ),
      jsonRequest("http://local/queue", "POST", enqueueBody),
      rootSessionId,
      ["queue"],
    );
    expect(forbidden.status).toBe(403);
    expect(roots).toBe(0);
  });

  test("refuses impossible queue error producer semantics and details", () => {
    expect(Object.isFrozen(CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE)).toBeTrue();
    expect(CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE).toEqual({
      [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL]:
        "This conversation already has 32 messages waiting.",
      [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE]:
        "That queued message changed before the edit could commit.",
      [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE]:
        "That queued message no longer matches the conversation authority it followed.",
      [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT]:
        "Private context changed before this request could commit.",
      [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.REQUEST_TOO_LARGE]:
        "The request body exceeds the 524288-byte limit.",
      [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED]:
        "Too many private context selections are waiting.",
    });
    expect(Object.isFrozen(CONVERSATION_MESSAGE_QUEUE_PUBLIC_ERROR_CODES)).toBeTrue();
    expect(Object.isFrozen(CONVERSATION_MESSAGE_QUEUE_INTERNAL_ERROR_CODES)).toBeTrue();
    expect([...CONVERSATION_MESSAGE_QUEUE_PUBLIC_ERROR_CODES]).toEqual(
      CONVERSATION_MESSAGE_QUEUE_ERROR_CODES.filter(
        (code) => !isConversationMessageQueueInternalErrorCode(code),
      ),
    );
    expect(
      CONVERSATION_MESSAGE_QUEUE_PUBLIC_ERROR_CODES.every(
        isConversationMessageQueuePublicErrorCode,
      ),
    ).toBeTrue();
    expect(CONVERSATION_MESSAGE_QUEUE_PUBLIC_ERROR_CODES).not.toContain(
      CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY,
    );
    expect(CONVERSATION_MESSAGE_QUEUE_PUBLIC_ERROR_CODES).not.toContain(
      CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT,
    );
    const canonical = {
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
      message:
        CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
          CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL
        ],
      retryable: true,
      recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY,
      details: {
        root_session_id: rootSessionId,
        max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
      },
    } as const;

    expect(queueErrorBody(canonical).status).toBe(429);
    expect(() => queueErrorBody({ ...canonical, retryable: false })).toThrow(
      "invalid conversation message queue error semantics",
    );
    expect(() =>
      queueErrorBody({
        ...canonical,
        details: {
          root_session_id: rootSessionId,
          max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems - 1,
        },
      }),
    ).toThrow("invalid conversation message queue error details");
    expect(() => queueErrorBody({ ...canonical, message: "" })).toThrow(
      "invalid conversation message queue error message",
    );
    expect(() => queueErrorBody({ ...canonical, message: "Almost canonical." })).toThrow(
      "conversation message queue error message semantics mismatch",
    );
    expect(() =>
      queueErrorBody({
        ...canonical,
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY as never,
        details: null,
      }),
    ).toThrow("invalid public conversation message queue error code");
    expect(() =>
      queueErrorBody({
        ...canonical,
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT as never,
        details: null,
      }),
    ).toThrow("invalid public conversation message queue error code");
  });

  test("constructs only the exact bounded public error fields from widened producer input", async () => {
    const widened = {
      code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
      message:
        CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
          CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL
        ],
      retryable: true,
      recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY,
      details: {
        root_session_id: rootSessionId,
        max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
      },
      secret: "must-not-cross",
      oversized: "x".repeat(8_192),
    } as const;
    const response = queueErrorBody(widened);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4_096);
    expect(Object.keys(body)).toEqual(["schema_version", "error"]);
    expect(Object.keys(body.error).sort()).toEqual(
      ["code", "message", "correlation_id", "retryable", "recovery_action", "details"].sort(),
    );
    expect(text).not.toContain("must-not-cross");
    expect(text).not.toContain("xxxxxxxxxxxxxxxx");
    expect(() =>
      queueErrorBody({ ...widened, details: { ...widened.details, secret: "leak" } }),
    ).toThrow("invalid conversation message queue error details");
  });

  test("snapshots accessor-backed details once before validation and byte serialization", async () => {
    for (const lateRoot of ["secret-root", "x".repeat(8_192)]) {
      let detailsReads = 0;
      let rootReads = 0;
      const details = Object.create(null) as Record<string, unknown>;
      Object.defineProperties(details, {
        root_session_id: {
          enumerable: true,
          get: () => {
            rootReads += 1;
            return rootReads <= 3 ? rootSessionId : lateRoot;
          },
        },
        max_nonterminal_items: {
          enumerable: true,
          value: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
        },
      });
      const producer = {
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
        message:
          CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
            CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL
          ],
        retryable: true,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY,
        get details() {
          detailsReads += 1;
          return details;
        },
      } as const;
      const response = queueErrorBody(producer);
      const text = await response.text();
      expect(response.status).toBe(429);
      expect(detailsReads).toBe(1);
      expect(rootReads).toBe(1);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4_096);
      expect(text).not.toContain("secret-root");
      expect(JSON.parse(text)).toMatchObject({
        error: { details: { root_session_id: rootSessionId } },
      });
    }
  });

  test("rejects duplicate keys and enforces the incremental 524288-byte cap", async () => {
    const duplicate = await handleConversationMessageQueueRoute(
      queueAuthority(),
      jsonRequest(
        "http://local/queue",
        "POST",
        `{"schema_version":"1.0","schema_version":"1.0","idempotency_key":"x"}`,
      ),
      rootSessionId,
      ["queue"],
    );
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: { code: "invalid_request" } });

    const oversized = await handleConversationMessageQueueRoute(
      queueAuthority(),
      jsonRequest("http://local/queue", "POST", "x".repeat(524_289)),
      rootSessionId,
      ["queue"],
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: { code: "request_too_large", details: { max_body_bytes: 524_288 } },
    });
  });

  test("uses 201 for first admission, 200 for replay, and no-store for every result", async () => {
    let calls = 0;
    const authority = queueAuthority({
      enqueue: (input) => {
        calls += 1;
        expect(input.principal_digest).toBe(principal().principal_digest);
        return { item: item(), replayed: calls > 1 };
      },
    });
    for (const status of [201, 200]) {
      const response = await handleConversationMessageQueueRoute(
        authority,
        jsonRequest("http://local/queue", "POST", enqueueBody),
        rootSessionId,
        ["queue"],
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(item());
    }
  });

  test("returns exact authoritative item details for a losing queued edit", async () => {
    const claimed = item("claimed");
    const authority = queueAuthority({
      edit: () => {
        throw new ConversationMessageQueueConflictError("queued_message_not_editable", "claimed");
      },
      item: () => claimed,
    });
    const response = await handleConversationMessageQueueRoute(
      authority,
      jsonRequest("http://local/queue", "PATCH", {
        schema_version: "1.0",
        idempotency_key: "edit-http",
        expected_item_digest: digest("item-queued"),
        content: "edited content",
      }),
      rootSessionId,
      ["queue", queueItemId],
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "queued_message_not_editable",
        recovery_action: "send-as-new",
        details: {
          root_session_id: rootSessionId,
          queue_item_id: queueItemId,
          state: "claimed",
          item_digest: claimed.item_digest,
        },
      },
    });
  });

  test("projects only boolean private-context presence for root and pre-root lifecycle", async () => {
    const authority = queueAuthority();
    const rootStage = await handleConversationMessageQueueRoute(
      authority,
      jsonRequest("http://local/private", "POST", {
        schema_version: "1.0",
        enqueue_idempotency_key: "message-private",
        source_kind: "private-file-range",
        repo_relative_path: "src/index.ts",
        start_line: 1,
        end_line: 2,
      }),
      rootSessionId,
      ["private-context"],
    );
    expect(rootStage.status).toBe(201);
    expect(await rootStage.json()).toEqual({
      schema_version: "1.0",
      private_context_present: true,
    });
    const draftDiscard = await handleConversationDraftPrivateContextRoute(
      authority,
      jsonRequest("http://local/draft", "POST", {
        schema_version: "1.0",
        idempotency_key: "discard-private",
        create_idempotency_key: "create-private",
        expected_private_context_present: true,
      }),
      true,
    );
    expect(draftDiscard.status).toBe(200);
    expect(await draftDiscard.json()).toEqual({
      schema_version: "1.0",
      private_context_present: false,
    });
  });

  test("covers every queue mutation facade and rejects unknown resources without side effects", async () => {
    const calls: string[] = [];
    const authority = queueAuthority({
      discardMessagePrivateContext: () => {
        calls.push("discard-message");
        return {
          presence: { schema_version: "1.0", private_context_present: false },
          replayed: false,
        };
      },
      edit: () => {
        calls.push("edit");
        return { item: item(), replayed: false };
      },
      stageDraftPrivateContext: () => {
        calls.push("stage-draft");
        return {
          presence: { schema_version: "1.0", private_context_present: true },
          replayed: false,
        };
      },
    });
    const discarded = await handleConversationMessageQueueRoute(
      authority,
      jsonRequest("http://local/private/discard", "POST", {
        schema_version: "1.0",
        idempotency_key: "discard-request",
        enqueue_idempotency_key: "message-private",
        expected_private_context_present: true,
      }),
      rootSessionId,
      ["private-context", "discard"],
    );
    expect(discarded.status).toBe(200);

    const edited = await handleConversationMessageQueueRoute(
      authority,
      jsonRequest("http://local/queue/edit", "PATCH", {
        schema_version: "1.0",
        idempotency_key: "edit-success",
        expected_item_digest: item().item_digest,
        content: "edited content",
      }),
      rootSessionId,
      ["queue", queueItemId],
    );
    expect(edited.status).toBe(200);

    const draftStage = await handleConversationDraftPrivateContextRoute(
      authority,
      jsonRequest("http://local/draft", "POST", {
        schema_version: "1.0",
        create_idempotency_key: "draft-private",
        source_kind: "private-file-range",
        repo_relative_path: "src/index.ts",
        start_line: 1,
        end_line: 2,
      }),
      false,
    );
    expect(draftStage.status).toBe(201);

    const draftMethod = await handleConversationDraftPrivateContextRoute(
      authority,
      new Request("http://local/draft", { method: "GET" }),
      false,
    );
    expect(draftMethod.status).toBe(404);
    const missing = await handleConversationMessageQueueRoute(
      authority,
      new Request("http://local/missing"),
      rootSessionId,
      ["missing"],
    );
    expect(missing.status).toBe(404);
    expect(calls).toEqual(["discard-message", "edit", "stage-draft"]);
  });

  test("maps every typed queue conflict to its closed HTTP recovery contract", async () => {
    const errors: Array<[Error, number, string]> = [
      [
        new ConversationPrivateContextBrokerConflictError("rate_limited", "full"),
        429,
        "rate_limited",
      ],
      [
        new ConversationPrivateContextBrokerConflictError("idempotency_conflict", "bound"),
        409,
        "idempotency_conflict",
      ],
      [
        new ConversationPrivateContextBrokerConflictError(
          "private_context_conflict",
          "changed",
          true,
          true,
        ),
        409,
        "private_context_conflict",
      ],
      [
        new ConversationMessageQueueConflictError(
          CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
          "full",
          { root_session_id: rootSessionId },
        ),
        429,
        CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
      ],
      [
        new ConversationMessageQueueConflictError("idempotency_conflict", "bound"),
        409,
        "idempotency_conflict",
      ],
      [new ConversationMessageQueueCorruptError("corrupt"), 423, "authority_corrupt"],
      [new ConversationMessageTargetConflictError("not head"), 409, "not_lineage_head"],
    ];
    for (const [error, status, code] of errors) {
      const response = messageQueueRouteError(error, queueAuthority(), rootSessionId, queueItemId);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }

    const stale = item("stale");
    const staleResponse = messageQueueRouteError(
      new ConversationMessageQueueConflictError("stale_queued_message", "stale"),
      queueAuthority({ item: () => stale }),
      rootSessionId,
      queueItemId,
    );
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      error: {
        code: "stale_queued_message",
        recovery_action: "send-as-new",
        details: { stale_reason: "causal_successor_mismatch" },
      },
    });

    const unavailableItem = messageQueueRouteError(
      new ConversationMessageQueueConflictError("queued_message_not_editable", "missing"),
      queueAuthority({ item: () => null }),
      rootSessionId,
      queueItemId,
    );
    expect(unavailableItem.status).toBe(423);
    expect(await unavailableItem.json()).toMatchObject({ error: { code: "authority_corrupt" } });
  });

  test("uses exact typed root context and rejects conflicting route authority", async () => {
    const conflict = new ConversationMessageQueueConflictError("queue_full", "full", {
      root_session_id: rootSessionId,
    });
    expect(Object.isFrozen(conflict.context)).toBeTrue();
    const projected = messageQueueRouteError(conflict);
    expect(projected.status).toBe(429);
    expect(await projected.json()).toMatchObject({
      error: {
        code: "queue_full",
        message:
          CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
            CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL
          ],
        details: {
          root_session_id: rootSessionId,
          max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
        },
      },
    });
    const mismatched = messageQueueRouteError(
      conflict,
      queueAuthority(),
      "different-root",
      queueItemId,
    );
    expect(mismatched.status).toBe(423);
    expect(await mismatched.json()).toMatchObject({ error: { code: "authority_corrupt" } });
    expect(
      () =>
        new ConversationMessageQueueConflictError("queue_full", "full", {
          root_session_id: "root",
          secret: true,
        } as never),
    ).toThrow("invalid conversation message queue conflict context");
    expect(() =>
      Reflect.construct(ConversationMessageQueueConflictError, [
        CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
        "full",
      ]),
    ).toThrow("invalid conversation message queue conflict context");
  });

  test("contains queue authority failures at both root and draft route boundaries", async () => {
    const rootFailure = await handleConversationMessageQueueRoute(
      queueAuthority({
        assertRoot: () => {
          throw new ConversationMessageQueueCorruptError("root corrupt");
        },
      }),
      new Request("http://local/queue"),
      rootSessionId,
      ["queue"],
    );
    expect(rootFailure.status).toBe(423);

    const draftFailure = await handleConversationDraftPrivateContextRoute(
      queueAuthority({
        stageDraftPrivateContext: () => {
          throw new ConversationPrivateContextBrokerConflictError(
            "private_context_conflict",
            "changed",
          );
        },
      }),
      jsonRequest("http://local/draft", "POST", {
        schema_version: "1.0",
        create_idempotency_key: "draft-private-failure",
        source_kind: "private-file-range",
        repo_relative_path: "src/index.ts",
        start_line: 1,
        end_line: 2,
      }),
      false,
    );
    expect(draftFailure.status).toBe(409);
  });

  test("wires queue endpoints into the existing browser namespace", async () => {
    const response = await handleConversationBrowserRoute(
      {
        sessions: { authorize: () => true },
        csrf: () => true,
        principal: () => principal(),
        messageQueue: queueAuthority().queue,
      } as unknown as ConversationBrowserHttpAuthorityV1,
      new Request(`http://local/api/conversation-sessions/${rootSessionId}/messages/queue`),
      new URL(`http://local/api/conversation-sessions/${rootSessionId}/messages/queue`),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(snapshot());
  });

  test("wires both pre-root private-context endpoints into the browser namespace", async () => {
    const authority = {
      sessions: { authorize: () => true },
      csrf: () => true,
      principal: () => principal(),
      messageQueue: queueAuthority().queue,
    } as unknown as ConversationBrowserHttpAuthorityV1;
    const stageUrl = new URL("http://local/api/conversation-drafts/private-context");
    const stage = await handleConversationBrowserRoute(
      authority,
      jsonRequest(stageUrl.href, "POST", {
        schema_version: "1.0",
        create_idempotency_key: "browser-draft-stage",
        source_kind: "private-file-range",
        repo_relative_path: "src/index.ts",
        start_line: 1,
        end_line: 2,
      }),
      stageUrl,
    );
    expect(stage?.status).toBe(201);

    const discardUrl = new URL("http://local/api/conversation-drafts/private-context/discard");
    const discard = await handleConversationBrowserRoute(
      authority,
      jsonRequest(discardUrl.href, "POST", {
        schema_version: "1.0",
        idempotency_key: "browser-draft-discard",
        create_idempotency_key: "browser-draft-stage",
        expected_private_context_present: true,
      }),
      discardUrl,
    );
    expect(discard?.status).toBe(200);

    const unavailable = await handleConversationBrowserRoute(
      { ...authority, messageQueue: undefined },
      new Request(stageUrl.href),
      stageUrl,
    );
    expect(unavailable).toBeNull();

    const unknownUrl = new URL("http://local/api/conversation-drafts/unknown");
    const unknown = await handleConversationBrowserRoute(
      authority,
      new Request(unknownUrl.href),
      unknownUrl,
    );
    expect(unknown).toBeNull();
  });
});

describe("conversation create and legacy compatibility facades", () => {
  test("creates with the closed V1 body, stable idempotency status, and a fresh stream token", async () => {
    let calls = 0;
    const authority: ConversationHomeCreateHttpAuthorityV1 = {
      sessions: { authorize: () => true },
      csrf: () => true,
      principal: () => principal(),
      streamTokens: {
        issue: () => ({
          stream_token: "token",
          stream_token_expires_at: "2026-08-26T00:15:00.000Z",
        }),
      },
      create: (input) => {
        calls += 1;
        expect(input.request.private_context_present).toBe(false);
        return { conversation_id: "conversation-created", replayed: calls > 1 };
      },
    };
    const body = {
      schema_version: "1.0",
      idempotency_key: "create-http",
      topic: "create through durable broker",
      private_context_present: false,
    };
    for (const status of [202, 200]) {
      const response = await handleConversationHomeCreateRoute(
        authority,
        jsonRequest("http://local/api/conversations", "POST", body),
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("location")).toBe("/api/conversations/conversation-created");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        conversation_id: "conversation-created",
        stream_token: "token",
        stream_token_expires_at: "2026-08-26T00:15:00.000Z",
      });
    }
  });

  test("requires Idempotency-Key and admits the legacy message through the shared queue", async () => {
    const captured: unknown[] = [];
    const authority: ConversationCompatibilityMessageAuthorityV1 = {
      principal: () => principal(),
      queue: {
        resolveCommittedConversation: () => ({ root_session_id: rootSessionId }),
        enqueueCompatibility: (_conversation, principalDigest, key, request) => {
          captured.push({ principalDigest, key, request });
          return { item: item(), replayed: false };
        },
        item: () => item(),
      },
    };
    const missing = await handleConversationCompatibilityMessageRoute(
      authority,
      jsonRequest("http://local/messages", "POST", { content: "hello" }),
      "conversation-a",
    );
    expect(missing.status).toBe(400);
    const accepted = await handleConversationCompatibilityMessageRoute(
      authority,
      jsonRequest(
        "http://local/messages",
        "POST",
        { content: "hello" },
        { "idempotency-key": "legacy-message" },
      ),
      "conversation-a",
    );
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(await accepted.json()).toEqual({ message_id: queueItemId, accepted: true });
    expect(captured).toEqual([
      {
        principalDigest: principal().principal_digest,
        key: "legacy-message",
        request: { content: "hello" },
      },
    ]);
  });

  test("rejects a legacy non-head target with the stable 409 code before admission", async () => {
    let admissions = 0;
    const response = await handleConversationCompatibilityMessageRoute(
      {
        principal: () => principal(),
        queue: {
          resolveCommittedConversation: () => {
            throw new ConversationMessageTargetConflictError("not head");
          },
          enqueueCompatibility: () => {
            admissions += 1;
            return { item: item(), replayed: false };
          },
          item: () => null,
        },
      },
      jsonRequest(
        "http://local/messages",
        "POST",
        { content: "must target head" },
        { "idempotency-key": "legacy-non-head" },
      ),
      "conversation-old-revision",
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "not_lineage_head" } });
    expect(admissions).toBe(0);
  });

  test("contains create failures and invalid legacy idempotency headers", async () => {
    const createFailure = await handleConversationHomeCreateRoute(
      {
        sessions: { authorize: () => true },
        csrf: () => true,
        principal: () => principal(),
        streamTokens: {
          issue: () => ({ stream_token: "never", stream_token_expires_at: "never" }),
        },
        create: () => {
          throw new Error("contained");
        },
      },
      jsonRequest("http://local/api/conversations", "POST", {
        schema_version: "1.0",
        idempotency_key: "create-failure",
        topic: "contained",
        private_context_present: false,
      }),
    );
    expect(createFailure.status).toBe(400);

    const invalidKey = await handleConversationCompatibilityMessageRoute(
      {
        queue: {
          resolveCommittedConversation: () => ({ root_session_id: rootSessionId }),
          enqueueCompatibility: () => ({ item: item(), replayed: false }),
          item: () => null,
        },
      },
      jsonRequest(
        "http://local/messages",
        "POST",
        { content: "hello" },
        { "idempotency-key": "contains whitespace" },
      ),
      "conversation-a",
    );
    expect(invalidKey.status).toBe(400);
  });

  test("top-level conversation routing delegates Home create and legacy messages", async () => {
    const base = {
      service: {},
      sessions: { authorize: () => true, loopback: true },
      csrf: () => true,
      streamTokens: {
        issue: () => ({
          stream_token: "route-token",
          stream_token_expires_at: "2026-08-26T00:15:00.000Z",
        }),
      },
    } as unknown as ConversationHttpAuthority;
    const createUrl = new URL("http://local/api/conversations");
    const created = await handleConversationRoute(
      {
        ...base,
        homeCreate: {
          principal: () => principal(),
          create: () => ({ conversation_id: "conversation-route-created", replayed: false }),
        },
      },
      jsonRequest(createUrl.href, "POST", {
        schema_version: "1.0",
        idempotency_key: "route-create",
        topic: "route create",
        private_context_present: false,
      }),
      createUrl,
    );
    expect(created.status).toBe(202);

    const messageUrl = new URL("http://local/api/conversations/conversation-a/messages");
    const messaged = await handleConversationRoute(
      {
        ...base,
        compatibilityMessages: {
          principal: () => principal(),
          queue: {
            resolveCommittedConversation: () => ({ root_session_id: rootSessionId }),
            enqueueCompatibility: () => ({ item: item(), replayed: false }),
            item: () => item(),
          },
        },
      },
      jsonRequest(
        messageUrl.href,
        "POST",
        { content: "queued through compatibility" },
        { "idempotency-key": "route-message" },
      ),
      messageUrl,
    );
    expect(messaged.status).toBe(202);
  });

  test("Ask compatibility has an explicit unavailable response for JSON and stream routes", async () => {
    const body = {
      path: "src/index.ts",
      start: 1,
      end: 1,
      question: "Why?",
    };
    const request = jsonRequest("http://local/api/ask", "POST", body, {
      "idempotency-key": "ask-unavailable",
    });
    const unavailable = await handleConversationAskCompatibilityRoute(
      undefined,
      request,
      process.cwd(),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: { code: "service_unavailable" } });

    const streamed = await handleConversationAskCompatibilityStream(
      undefined,
      new Request("http://local/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      process.cwd(),
      body,
      "ask-stream-unavailable",
    );
    expect(streamed.status).toBe(503);
  });
});
