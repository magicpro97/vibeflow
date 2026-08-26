import { describe, expect, test } from "bun:test";
import { ref, shallowRef } from "vue";
import { conversationApi } from "../src/ui/src/conversation-api.js";
import {
  ConversationHomeApiError,
  conversationHomeApi,
} from "../src/ui/src/conversation-home-api.js";
import { createHomeMessageQueueRuntime } from "../src/ui/src/conversation-home-message-queue-runtime.js";
import type {
  HomeEditQueuedMessageRequest,
  HomeEnqueueMessageRequest,
  HomeMessageQueueSnapshot,
  HomeOptimisticQueuedMessage,
  HomeQueuedMessage,
  HomeQueuedMessageEditBinding,
} from "../src/ui/src/conversation-home-message-queue-types.js";
import { ActivationEpoch } from "../src/ui/src/conversation-home-state.js";
import { watchHomeConversationStream } from "../src/ui/src/conversation-home-stream.js";

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const queueId = (value: string) => `vf-queued-message-${value.repeat(64).slice(0, 64)}`;
const NOW = "2026-08-26T00:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function item(
  sequence: number,
  content: string,
  overrides: Partial<HomeQueuedMessage> = {},
): HomeQueuedMessage {
  const seed = sequence.toString(16);
  return {
    schema_version: "1.0",
    queue_item_id: queueId(seed),
    queue_sequence: sequence,
    root_session_id: "root-a",
    author_public_id: "human",
    content,
    content_digest: digest(seed),
    target_participants: "all",
    quote_refs: [],
    private_context_present: false,
    predecessor_queue_item_id: sequence === 1 ? null : queueId((sequence - 1).toString(16)),
    admitted_authority_digest: digest("a"),
    effective_authority_digest: digest("a"),
    state: "queued",
    stale_reason: null,
    admitted_at: NOW,
    updated_at: NOW,
    item_digest: digest(`f${seed}`),
    ...overrides,
  };
}

function snapshot(
  rootSessionId = "root-a",
  items: HomeQueuedMessage[] = [],
): HomeMessageQueueSnapshot {
  return {
    schema_version: "1.0",
    root_session_id: rootSessionId,
    current_authority_digest: digest("a"),
    max_nonterminal_items: 32,
    items,
  };
}

function harness() {
  const activation = new ActivationEpoch();
  activation.begin("root-a");
  const activeRootId = ref<string | null>("root-a");
  const draft = ref("");
  const composerError = ref("");
  const queue = shallowRef<HomeMessageQueueSnapshot | null>(null);
  const optimistic = ref<HomeOptimisticQueuedMessage[]>([]);
  const edit = shallowRef<HomeQueuedMessageEditBinding | null>(null);
  const editSaving = ref(false);
  const sendAsNew = ref(false);
  const announcement = ref("");
  const focusEpoch = ref(0);
  let refreshes = 0;
  const runtime = createHomeMessageQueueRuntime({
    activation,
    activeRootId,
    online: ref(true),
    draft,
    composerError,
    snapshot: queue,
    optimistic,
    edit,
    editSaving,
    sendAsNew,
    announcement,
    composerFocusEpoch: focusEpoch,
    refreshQueue: async () => {
      refreshes += 1;
      return true;
    },
  });
  runtime.adoptSnapshot(snapshot(), "root-a");
  const admission = (content: string, privateContext = false) => ({
    content,
    target_participants: "all" as const,
    quote_refs: [],
    private_context_present: privateContext,
    clearIfCurrent() {
      if (draft.value === content) draft.value = "";
    },
    restoreIfVacant() {
      if (draft.value !== "") return false;
      draft.value = content;
      return true;
    },
  });
  return {
    activation,
    activeRootId,
    announcement,
    composerError,
    draft,
    edit,
    editSaving,
    sendAsNew,
    focusEpoch,
    optimistic,
    queue,
    runtime,
    admission,
    refreshes: () => refreshes,
  };
}

describe("Home durable message queue", () => {
  test("rapid A/B/C admissions stay interactive and settle in authoritative FIFO order", async () => {
    const original = conversationHomeApi.enqueueMessage;
    const pending = [
      deferred<HomeQueuedMessage>(),
      deferred<HomeQueuedMessage>(),
      deferred<HomeQueuedMessage>(),
    ];
    const requests: HomeEnqueueMessageRequest[] = [];
    conversationHomeApi.enqueueMessage = ((_root, request) => {
      requests.push(structuredClone(request));
      return pending[requests.length - 1]?.promise ?? Promise.reject(new Error("missing request"));
    }) as typeof conversationHomeApi.enqueueMessage;
    const fx = harness();
    try {
      const sends = ["A", "B", "C"].map((content) => {
        fx.draft.value = content;
        return fx.runtime.enqueue(fx.admission(content, content === "B"));
      });
      expect(fx.draft.value).toBe("");
      expect(fx.runtime.projections.value.map((row) => row.kind)).toEqual([
        "optimistic",
        "optimistic",
        "optimistic",
      ]);
      expect(new Set(requests.map((request) => request.idempotency_key)).size).toBe(3);
      expect(
        requests.every((request) =>
          /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(request.idempotency_key),
        ),
      ).toBeTrue();
      expect(requests[1]).toMatchObject({
        schema_version: "1.0",
        content: "B",
        target_participants: "all",
        quote_refs: [],
        private_context_present: true,
      });

      pending[2]?.resolve(item(3, "C"));
      pending[0]?.resolve(item(1, "A"));
      pending[1]?.resolve(item(2, "B", { private_context_present: true }));
      expect(await Promise.all(sends)).toEqual([true, true, true]);
      expect(fx.queue.value?.items.map((entry) => entry.content)).toEqual(["A", "B", "C"]);
      expect(fx.runtime.projections.value.every((row) => row.kind === "authoritative")).toBeTrue();
    } finally {
      fx.runtime.dispose();
      fx.activation.close();
      conversationHomeApi.enqueueMessage = original;
    }
  });

  test("lost response retries one exact idempotency request and GET authority replaces optimism", async () => {
    const original = conversationHomeApi.enqueueMessage;
    const response = deferred<HomeQueuedMessage>();
    const requests: HomeEnqueueMessageRequest[] = [];
    conversationHomeApi.enqueueMessage = ((_root, request) => {
      requests.push(structuredClone(request));
      return requests.length === 1
        ? Promise.reject(new TypeError("lost response"))
        : response.promise;
    }) as typeof conversationHomeApi.enqueueMessage;
    const fx = harness();
    try {
      fx.draft.value = "recover once";
      const sending = fx.runtime.enqueue(fx.admission("recover once"));
      await Promise.resolve();
      expect(requests).toHaveLength(2);
      expect(requests[0]?.idempotency_key).toBe(requests[1]?.idempotency_key);
      fx.runtime.adoptSnapshot(snapshot("root-a", [item(1, "recover once")]), "root-a");
      expect(fx.runtime.projections.value).toHaveLength(1);
      response.resolve(item(1, "recover once"));
      expect(await sending).toBeTrue();
      expect(fx.runtime.projections.value).toHaveLength(1);
    } finally {
      fx.runtime.dispose();
      fx.activation.close();
      conversationHomeApi.enqueueMessage = original;
    }
  });

  test("queue API uses exact root routes, mutation bodies, and a no-store GET", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const method = init.method ?? "GET";
      return new Response(
        JSON.stringify(
          method === "GET"
            ? snapshot("root/a")
            : item(1, method === "PATCH" ? "edit" : "send", {
                root_session_id: "root/a",
              }),
        ),
        { status: method === "POST" ? 201 : 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      await conversationHomeApi.messageQueue("root/a");
      await conversationHomeApi.enqueueMessage("root/a", {
        schema_version: "1.0",
        idempotency_key: "queue-key",
        expected_authority_digest: digest("a"),
        content: "send",
        target_participants: ["participant-1"],
        quote_refs: [],
        private_context_present: true,
      });
      await conversationHomeApi.editQueuedMessage("root/a", queueId("1"), {
        schema_version: "1.0",
        idempotency_key: "edit-key",
        expected_item_digest: digest("b"),
        content: "edit",
      });
      expect(calls.map((call) => [call.init.method, call.url])).toEqual([
        ["GET", "/api/conversation-sessions/root%2Fa/messages/queue"],
        ["POST", "/api/conversation-sessions/root%2Fa/messages/queue"],
        ["PATCH", `/api/conversation-sessions/root%2Fa/messages/queue/${queueId("1")}`],
      ]);
      expect(new Headers(calls[0]?.init.headers).get("cache-control")).toBe("no-store");
      expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
        schema_version: "1.0",
        idempotency_key: "queue-key",
        expected_authority_digest: digest("a"),
        content: "send",
        target_participants: ["participant-1"],
        quote_refs: [],
        private_context_present: true,
      });
      expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
        schema_version: "1.0",
        idempotency_key: "edit-key",
        expected_item_digest: digest("b"),
        content: "edit",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("late A completion cannot mutate B after activation changes", async () => {
    const original = conversationHomeApi.enqueueMessage;
    const response = deferred<HomeQueuedMessage>();
    conversationHomeApi.enqueueMessage = (() =>
      response.promise) as typeof conversationHomeApi.enqueueMessage;
    const fx = harness();
    try {
      fx.draft.value = "A only";
      const sending = fx.runtime.enqueue(fx.admission("A only"));
      fx.activation.begin("root-b");
      fx.activeRootId.value = "root-b";
      fx.runtime.switchRoot("root-a", "root-b");
      fx.runtime.adoptSnapshot(snapshot("root-b"), "root-b");
      fx.draft.value = "B draft";
      response.resolve(item(1, "A only"));
      expect(await sending).toBeFalse();
      expect(fx.draft.value).toBe("B draft");
      expect(fx.queue.value?.root_session_id).toBe("root-b");
      expect(fx.queue.value?.items).toEqual([]);
      expect(fx.announcement.value).not.toContain("Queued message 1");
    } finally {
      fx.runtime.dispose();
      fx.activation.close();
      conversationHomeApi.enqueueMessage = original;
    }
  });

  test("A reactivation resolves an interrupted admission with the same key when server already won", async () => {
    const original = conversationHomeApi.enqueueMessage;
    const lateA = deferred<HomeQueuedMessage>();
    const requests: HomeEnqueueMessageRequest[] = [];
    conversationHomeApi.enqueueMessage = ((_root, request) => {
      requests.push(structuredClone(request));
      return requests.length === 1 ? lateA.promise : Promise.resolve(item(1, "A survives"));
    }) as typeof conversationHomeApi.enqueueMessage;
    const fx = harness();
    try {
      fx.draft.value = "A survives";
      const firstAttempt = fx.runtime.enqueue(fx.admission("A survives"));
      fx.activation.begin("root-b");
      fx.activeRootId.value = "root-b";
      fx.runtime.switchRoot("root-a", "root-b");
      fx.runtime.adoptSnapshot(snapshot("root-b"), "root-b");
      expect(fx.draft.value).toBe("");
      expect(fx.runtime.projections.value).toEqual([]);

      fx.activation.begin("root-a");
      fx.activeRootId.value = "root-a";
      fx.runtime.switchRoot("root-b", "root-a");
      fx.runtime.adoptSnapshot(snapshot("root-a", [item(1, "A survives")]), "root-a");
      await Promise.resolve();
      expect(requests).toHaveLength(2);
      expect(requests[1]?.idempotency_key).toBe(requests[0]?.idempotency_key);
      expect(fx.runtime.projections.value).toHaveLength(1);
      expect(fx.draft.value).toBe("");

      lateA.resolve(item(1, "A survives"));
      expect(await firstAttempt).toBeFalse();
      expect(fx.queue.value?.items.map((entry) => entry.queue_item_id)).toEqual([queueId("1")]);
    } finally {
      fx.runtime.dispose();
      fx.activation.close();
      conversationHomeApi.enqueueMessage = original;
    }
  });

  test("A reactivation replays an exact interrupted admission when server never saw it", async () => {
    const original = conversationHomeApi.enqueueMessage;
    const abandoned = deferred<HomeQueuedMessage>();
    const requests: HomeEnqueueMessageRequest[] = [];
    conversationHomeApi.enqueueMessage = ((_root, request) => {
      requests.push(structuredClone(request));
      return requests.length === 1 ? abandoned.promise : Promise.resolve(item(1, "retry A"));
    }) as typeof conversationHomeApi.enqueueMessage;
    const fx = harness();
    try {
      fx.draft.value = "retry A";
      const firstAttempt = fx.runtime.enqueue(fx.admission("retry A"));
      fx.activation.begin("root-b");
      fx.activeRootId.value = "root-b";
      fx.runtime.switchRoot("root-a", "root-b");
      fx.runtime.adoptSnapshot(snapshot("root-b"), "root-b");

      fx.activation.begin("root-a");
      fx.activeRootId.value = "root-a";
      fx.runtime.switchRoot("root-b", "root-a");
      fx.runtime.adoptSnapshot(snapshot("root-a"), "root-a");
      await Promise.resolve();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(fx.queue.value?.items.map((entry) => entry.content)).toEqual(["retry A"]);
      expect(fx.draft.value).toBe("");

      abandoned.reject(new DOMException("aborted", "AbortError"));
      expect(await firstAttempt).toBeFalse();
    } finally {
      fx.runtime.dispose();
      fx.activation.close();
      conversationHomeApi.enqueueMessage = original;
    }
  });

  test("authoritative refresh waits for active admissions instead of dropping optimistic rows", async () => {
    const original = conversationHomeApi.enqueueMessage;
    const pending = [deferred<HomeQueuedMessage>(), deferred<HomeQueuedMessage>()];
    let calls = 0;
    conversationHomeApi.enqueueMessage = (() =>
      pending[calls++]?.promise) as typeof conversationHomeApi.enqueueMessage;
    const fx = harness();
    try {
      fx.draft.value = "A";
      const sendA = fx.runtime.enqueue(fx.admission("A"));
      fx.draft.value = "B";
      const sendB = fx.runtime.enqueue(fx.admission("B"));
      fx.runtime.adoptSnapshot(snapshot("root-a"), "root-a");
      expect(fx.runtime.projections.value.map((row) => row.kind)).toEqual([
        "optimistic",
        "optimistic",
      ]);
      pending[0]?.resolve(item(1, "A"));
      pending[1]?.resolve(item(2, "B"));
      expect(await Promise.all([sendA, sendB])).toEqual([true, true]);
      expect(fx.queue.value?.items.map((entry) => entry.content)).toEqual(["A", "B"]);
      expect(fx.refreshes()).toBe(1);
    } finally {
      fx.runtime.dispose();
      fx.activation.close();
      conversationHomeApi.enqueueMessage = original;
    }
  });

  test("ArrowUp authority selects only the latest queued item and Escape restores empty draft", () => {
    const fx = harness();
    try {
      fx.runtime.adoptSnapshot(
        snapshot("root-a", [
          item(1, "older"),
          item(2, "already claimed", { state: "claimed" }),
          item(3, "latest queued"),
        ]),
        "root-a",
      );
      expect(fx.runtime.beginEdit()).toBeTrue();
      expect(fx.edit.value).toMatchObject({ queue_item_id: queueId("3"), queue_sequence: 3 });
      expect(fx.draft.value).toBe("latest queued");
      expect(fx.runtime.cancelEdit()).toBeTrue();
      expect(fx.draft.value).toBe("");
      expect(fx.focusEpoch.value).toBe(1);
    } finally {
      fx.runtime.dispose();
      fx.activation.close();
    }
  });

  test("CAS edit preserves FIFO/context authority and sends no private reference", async () => {
    const original = conversationHomeApi.editQueuedMessage;
    const fx = harness();
    const privateItem = item(4, "before", {
      private_context_present: true,
      target_participants: ["participant-1"],
    });
    let body: HomeEditQueuedMessageRequest | null = null;
    conversationHomeApi.editQueuedMessage = (async (_root, _itemId, request) => {
      body = structuredClone(request);
      return {
        ...privateItem,
        content: "after",
        content_digest: digest("e"),
        item_digest: digest("d"),
        updated_at: "2026-08-26T00:00:01.000Z",
      };
    }) as typeof conversationHomeApi.editQueuedMessage;
    try {
      fx.runtime.adoptSnapshot(snapshot("root-a", [privateItem]), "root-a");
      expect(fx.runtime.beginEdit()).toBeTrue();
      fx.draft.value = "after";
      expect(await fx.runtime.saveEdit()).toBeTrue();
      expect(body).toMatchObject({
        schema_version: "1.0",
        expected_item_digest: privateItem.item_digest,
        content: "after",
      });
      expect(JSON.stringify(body)).not.toMatch(/private|handoff|path|range/i);
      expect(fx.queue.value?.items[0]).toMatchObject({
        queue_sequence: 4,
        predecessor_queue_item_id: privateItem.predecessor_queue_item_id,
        target_participants: ["participant-1"],
        private_context_present: true,
      });
      expect(fx.draft.value).toBe("");
    } finally {
      fx.runtime.dispose();
      fx.activation.close();
      conversationHomeApi.editQueuedMessage = original;
    }
  });

  test("dequeue 409 exits edit, preserves replacement, focuses and refreshes", async () => {
    const original = conversationHomeApi.editQueuedMessage;
    const fx = harness();
    const queued = item(1, "before");
    conversationHomeApi.editQueuedMessage = (async () => {
      throw new ConversationHomeApiError(409, {
        code: "queued_message_not_editable",
        message: "That queued message changed before the edit could commit.",
        retryable: false,
        recovery_action: "send-as-new",
        details: {
          root_session_id: "root-a",
          queue_item_id: queued.queue_item_id,
          state: "claimed",
          item_digest: digest("9"),
        },
      });
    }) as typeof conversationHomeApi.editQueuedMessage;
    try {
      fx.runtime.adoptSnapshot(snapshot("root-a", [queued]), "root-a");
      fx.runtime.beginEdit();
      fx.draft.value = "replacement survives";
      expect(await fx.runtime.saveEdit()).toBeFalse();
      expect(fx.edit.value).toBeNull();
      expect(fx.sendAsNew.value).toBeTrue();
      expect(fx.draft.value).toBe("replacement survives");
      expect(fx.composerError.value).toContain("send it as new");
      expect(fx.announcement.value).toContain("Replacement kept");
      expect(fx.focusEpoch.value).toBe(1);
      expect(fx.refreshes()).toBe(1);
    } finally {
      fx.runtime.dispose();
      fx.activation.close();
      conversationHomeApi.editQueuedMessage = original;
    }
  });

  test("a malformed 409 cannot clear the CAS edit binding or publish send-as-new state", async () => {
    const original = conversationHomeApi.editQueuedMessage;
    const fx = harness();
    const queued = item(1, "before");
    conversationHomeApi.editQueuedMessage = (async () => {
      throw new ConversationHomeApiError(409, {
        code: "queued_message_not_editable",
        message: "untrusted conflict",
        retryable: false,
        details: {
          root_session_id: "root-a",
          queue_item_id: queued.queue_item_id,
          state: "claimed",
          item_digest: digest("9"),
          private_context_binding_digest: digest("8"),
        },
      });
    }) as typeof conversationHomeApi.editQueuedMessage;
    try {
      fx.runtime.adoptSnapshot(snapshot("root-a", [queued]), "root-a");
      fx.runtime.beginEdit();
      fx.draft.value = "replacement";
      expect(await fx.runtime.saveEdit()).toBeFalse();
      expect(fx.edit.value?.queue_item_id).toBe(queued.queue_item_id);
      expect(fx.sendAsNew.value).toBeFalse();
      expect(fx.refreshes()).toBe(0);
      expect(fx.composerError.value).toBe("untrusted conflict");
    } finally {
      fx.runtime.dispose();
      fx.activation.close();
      conversationHomeApi.editQueuedMessage = original;
    }
  });

  test("queue-full admission restores the exact composer snapshot and does not retry", async () => {
    const original = conversationHomeApi.enqueueMessage;
    let calls = 0;
    conversationHomeApi.enqueueMessage = (async () => {
      calls += 1;
      throw new ConversationHomeApiError(429, {
        code: "queue_full",
        message: "This conversation already has 32 messages waiting.",
        retryable: false,
        details: { root_session_id: "root-a", max_nonterminal_items: 32 },
      });
    }) as typeof conversationHomeApi.enqueueMessage;
    const fx = harness();
    try {
      fx.draft.value = "keep this exact draft";
      expect(await fx.runtime.enqueue(fx.admission("keep this exact draft"))).toBeFalse();
      expect(calls).toBe(1);
      expect(fx.draft.value).toBe("keep this exact draft");
      expect(fx.optimistic.value).toEqual([]);
      expect(fx.composerError.value).toContain("32 messages");
    } finally {
      fx.runtime.dispose();
      fx.activation.close();
      conversationHomeApi.enqueueMessage = original;
    }
  });

  test("offline abort removes optimism and keeps unacknowledged content inert", async () => {
    const original = conversationHomeApi.enqueueMessage;
    const pending = deferred<HomeQueuedMessage>();
    conversationHomeApi.enqueueMessage = (() =>
      pending.promise) as typeof conversationHomeApi.enqueueMessage;
    const fx = harness();
    try {
      fx.draft.value = "do not replay";
      const sending = fx.runtime.enqueue(fx.admission("do not replay"));
      fx.runtime.goOffline();
      expect(fx.draft.value).toBe("do not replay");
      expect(fx.optimistic.value).toEqual([]);
      expect(fx.announcement.value).toContain("inert draft");
      pending.resolve(item(1, "do not replay"));
      expect(await sending).toBeFalse();
      expect(fx.queue.value?.items).toEqual([]);
    } finally {
      fx.runtime.dispose();
      fx.activation.close();
      conversationHomeApi.enqueueMessage = original;
    }
  });

  test("SSE connect and queue invalidations trigger authoritative refresh without trusting content", async () => {
    type Listener = (event: { data: string }) => void;
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      readonly listeners = new Map<string, Listener[]>();
      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }
      addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      emit(type: string, value: unknown) {
        for (const listener of this.listeners.get(type) ?? [])
          listener({ data: JSON.stringify(value) });
      }
      close() {}
    }
    const originalEventSource = globalThis.EventSource;
    const originalRenew = conversationApi.renewStreamToken;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    conversationApi.renewStreamToken = (async () => ({
      stream_token: "queue-token",
      stream_token_expires_at: "invalid-expiry",
    })) as typeof conversationApi.renewStreamToken;
    const invalidations: unknown[] = [];
    let refreshes = 0;
    const controller = new AbortController();
    try {
      const stream = watchHomeConversationStream({
        conversationId: "conversation-a",
        rootSessionId: "root-a",
        cursor: () => 0,
        signal: controller.signal,
        isCurrent: () => true,
        setStatus: () => {},
        onSnapshot: () => {},
        onTrace: () => {},
        onRefreshNeeded: () => {},
        onQueueInvalidation: (value) => invalidations.push(value),
        onQueueRefreshNeeded: () => {
          refreshes += 1;
        },
      });
      for (let turn = 0; turn < 4 && !FakeEventSource.instances.length; turn += 1)
        await Promise.resolve();
      expect(refreshes).toBe(1);
      const source = FakeEventSource.instances[0];
      source?.emit("message-queue-invalidated", {
        schema_version: "1.0",
        root_session_id: "root-a",
        queue_item_id: queueId("1"),
        state: "claimed",
        item_digest: digest("1"),
      });
      expect(invalidations).toHaveLength(1);
      source?.emit("message-queue-invalidated", {
        schema_version: "1.0",
        root_session_id: "root-b",
        queue_item_id: queueId("1"),
        state: "claimed",
        item_digest: digest("1"),
      });
      expect(invalidations).toHaveLength(1);
      expect(refreshes).toBe(2);
      stream.close();
    } finally {
      controller.abort();
      globalThis.EventSource = originalEventSource;
      conversationApi.renewStreamToken = originalRenew;
    }
  });
});
