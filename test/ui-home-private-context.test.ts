import { describe, expect, test } from "bun:test";
import { ref } from "vue";
import { conversationHomeApi } from "../src/ui/src/conversation-home-api.js";
import { createHomePrivateContextRuntime } from "../src/ui/src/conversation-home-private-context-runtime.js";
import type {
  HomeDiscardDraftPrivateContextRequest,
  HomeDiscardMessagePrivateContextRequest,
  HomePrivateContextPresence,
  HomeStageDraftPrivateContextRequest,
  HomeStageMessagePrivateContextRequest,
} from "../src/ui/src/conversation-home-private-context-types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const presence = (value: boolean): HomePrivateContextPresence => ({
  schema_version: "1.0",
  private_context_present: value,
});

function harness(root: string | null = "root-a") {
  const activeRootId = ref<string | null>(root);
  const online = ref(true);
  const present = ref(false);
  const discardBusy = ref(false);
  const composerError = ref("");
  const announcement = ref("");
  const composerFocusEpoch = ref(0);
  const runtime = createHomePrivateContextRuntime({
    activeRootId,
    online,
    present,
    discardBusy,
    composerError,
    announcement,
    composerFocusEpoch,
  });
  return {
    activeRootId,
    online,
    present,
    discardBusy,
    composerError,
    announcement,
    composerFocusEpoch,
    runtime,
  };
}

const range = (path = "src/private.ts") => ({
  repo_relative_path: path,
  start_line: 2,
  end_line: 8,
});

describe("Home private-context broker UI", () => {
  test("root stage mints the enqueue key before transport and capture reuses it exactly", async () => {
    const original = conversationHomeApi.stageMessagePrivateContext;
    const requests: HomeStageMessagePrivateContextRequest[] = [];
    conversationHomeApi.stageMessagePrivateContext = (async (root, request) => {
      expect(root).toBe("root-a");
      requests.push(structuredClone(request));
      if (requests.length === 1) throw new TypeError("response lost");
      return presence(true);
    }) as typeof conversationHomeApi.stageMessagePrivateContext;
    const fx = harness();
    try {
      expect(await fx.runtime.stage(range())).toBeTrue();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual(requests[1]);
      expect(requests[0]).toEqual({
        schema_version: "1.0",
        enqueue_idempotency_key: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/),
        source_kind: "private-file-range",
        ...range(),
      });
      expect(fx.present.value).toBeTrue();
      const capture = fx.runtime.captureForMessage("root-a");
      expect(capture?.idempotency_key).toBe(requests[0]?.enqueue_idempotency_key);
      expect(capture).not.toHaveProperty("repo_relative_path");
      capture?.clearIfCurrent();
      expect(fx.present.value).toBeFalse();
      expect(capture?.restoreIfVacant()).toBeTrue();
      expect(fx.present.value).toBeTrue();
    } finally {
      fx.runtime.dispose();
      conversationHomeApi.stageMessagePrivateContext = original;
    }
  });

  test("replacement stages first, switches, then replays one exact old-key discard", async () => {
    const originalStage = conversationHomeApi.stageMessagePrivateContext;
    const originalDiscard = conversationHomeApi.discardMessagePrivateContext;
    const order: string[] = [];
    const stages: HomeStageMessagePrivateContextRequest[] = [];
    const discards: HomeDiscardMessagePrivateContextRequest[] = [];
    conversationHomeApi.stageMessagePrivateContext = (async (_root, request) => {
      stages.push(structuredClone(request));
      order.push(`stage:${request.repo_relative_path}`);
      return presence(true);
    }) as typeof conversationHomeApi.stageMessagePrivateContext;
    conversationHomeApi.discardMessagePrivateContext = (async (_root, request) => {
      discards.push(structuredClone(request));
      order.push("discard-old");
      if (discards.length === 1) throw new TypeError("response lost");
      return presence(false);
    }) as typeof conversationHomeApi.discardMessagePrivateContext;
    const fx = harness();
    try {
      await fx.runtime.stage(range("src/old.ts"));
      const oldKey = fx.runtime.captureForMessage("root-a")?.idempotency_key;
      if (!oldKey) throw new Error("old private context was not captured");
      await fx.runtime.stage(range("src/new.ts"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const current = fx.runtime.captureForMessage("root-a");
      expect(current?.idempotency_key).toBe(stages[1]?.enqueue_idempotency_key);
      expect(current?.idempotency_key).not.toBe(oldKey);
      expect(order.slice(0, 3)).toEqual(["stage:src/old.ts", "stage:src/new.ts", "discard-old"]);
      expect(discards).toHaveLength(2);
      expect(discards[0]).toEqual(discards[1]);
      expect(discards[0]).toEqual({
        schema_version: "1.0",
        idempotency_key: expect.any(String),
        enqueue_idempotency_key: oldKey,
        expected_private_context_present: true,
      });
    } finally {
      fx.runtime.dispose();
      conversationHomeApi.stageMessagePrivateContext = originalStage;
      conversationHomeApi.discardMessagePrivateContext = originalDiscard;
    }
  });

  test("a retained capture settles through the authoritative discard endpoint", async () => {
    const originalStage = conversationHomeApi.stageMessagePrivateContext;
    const originalDiscard = conversationHomeApi.discardMessagePrivateContext;
    const discardRequests: HomeDiscardMessagePrivateContextRequest[] = [];
    conversationHomeApi.stageMessagePrivateContext = (async () =>
      presence(true)) as typeof conversationHomeApi.stageMessagePrivateContext;
    conversationHomeApi.discardMessagePrivateContext = (async (_root, request) => {
      discardRequests.push(structuredClone(request));
      return presence(false);
    }) as typeof conversationHomeApi.discardMessagePrivateContext;
    const fx = harness();
    try {
      expect(await fx.runtime.stage(range("src/retained.ts"))).toBeTrue();
      const capture = fx.runtime.captureForMessage("root-a");
      if (!capture) throw new Error("expected retained private capture");
      capture.clearIfCurrent();
      expect(fx.present.value).toBeFalse();
      expect(await capture.discardRetained()).toBeTrue();
      expect(discardRequests).toEqual([
        {
          schema_version: "1.0",
          idempotency_key: expect.any(String),
          enqueue_idempotency_key: capture.idempotency_key,
          expected_private_context_present: true,
        },
      ]);
      expect(await capture.discardRetained()).toBeTrue();
      expect(discardRequests).toHaveLength(1);
      expect(fx.runtime.captureForMessage("root-a")).toBeNull();
    } finally {
      fx.runtime.dispose();
      conversationHomeApi.stageMessagePrivateContext = originalStage;
      conversationHomeApi.discardMessagePrivateContext = originalDiscard;
    }
  });

  test("a late root-A stage never projects into root B and is recovered only on A", async () => {
    const original = conversationHomeApi.stageMessagePrivateContext;
    const staged = deferred<HomePrivateContextPresence>();
    conversationHomeApi.stageMessagePrivateContext = (() =>
      staged.promise) as typeof conversationHomeApi.stageMessagePrivateContext;
    const fx = harness();
    try {
      const selectingA = fx.runtime.stage(range());
      fx.activeRootId.value = "root-b";
      fx.runtime.switchRoot();
      staged.resolve(presence(true));
      expect(await selectingA).toBeFalse();
      expect(fx.present.value).toBeFalse();
      expect(fx.runtime.captureForMessage("root-b")).toBeNull();
      fx.activeRootId.value = "root-a";
      fx.runtime.switchRoot();
      expect(fx.present.value).toBeTrue();
    } finally {
      fx.runtime.dispose();
      conversationHomeApi.stageMessagePrivateContext = original;
    }
  });

  test("pre-root stage uses the same create key and explicit discard retains selection on failure", async () => {
    const originalStage = conversationHomeApi.stageDraftPrivateContext;
    const originalDiscard = conversationHomeApi.discardDraftPrivateContext;
    const stageRequests: HomeStageDraftPrivateContextRequest[] = [];
    const discardRequests: HomeDiscardDraftPrivateContextRequest[] = [];
    conversationHomeApi.stageDraftPrivateContext = (async (request) => {
      stageRequests.push(structuredClone(request));
      return presence(true);
    }) as typeof conversationHomeApi.stageDraftPrivateContext;
    conversationHomeApi.discardDraftPrivateContext = (async (request) => {
      discardRequests.push(structuredClone(request));
      if (discardRequests.length < 3) throw new TypeError("offline");
      return presence(false);
    }) as typeof conversationHomeApi.discardDraftPrivateContext;
    const fx = harness(null);
    try {
      await fx.runtime.stage(range());
      expect(fx.runtime.captureForCreate()?.idempotency_key).toBe(
        stageRequests[0]?.create_idempotency_key,
      );
      expect(await fx.runtime.discardCurrent()).toBeFalse();
      expect(fx.present.value).toBeTrue();
      expect(fx.composerError.value).toContain("offline");
      expect(await fx.runtime.discardCurrent()).toBeTrue();
      expect(fx.present.value).toBeFalse();
      expect(discardRequests).toHaveLength(3);
      expect(new Set(discardRequests.map((request) => request.idempotency_key)).size).toBe(1);
    } finally {
      fx.runtime.dispose();
      conversationHomeApi.stageDraftPrivateContext = originalStage;
      conversationHomeApi.discardDraftPrivateContext = originalDiscard;
    }
  });

  test("strict boolean-only responses reject leaked private authority without state mutation", async () => {
    const original = conversationHomeApi.stageMessagePrivateContext;
    conversationHomeApi.stageMessagePrivateContext = (async () => ({
      schema_version: "1.0",
      private_context_present: true,
      repo_relative_path: "src/leak.ts",
    })) as typeof conversationHomeApi.stageMessagePrivateContext;
    const fx = harness();
    try {
      expect(fx.runtime.stage(range())).rejects.toThrow("invalid public projection");
      expect(fx.present.value).toBeFalse();
      expect(fx.runtime.captureForMessage("root-a")).toBeNull();
    } finally {
      fx.runtime.dispose();
      conversationHomeApi.stageMessagePrivateContext = original;
    }
  });

  test("offline stage and discard remain inert while preserving the selected context", async () => {
    const originalStage = conversationHomeApi.stageMessagePrivateContext;
    const originalDiscard = conversationHomeApi.discardMessagePrivateContext;
    let stageCalls = 0;
    let discardCalls = 0;
    conversationHomeApi.stageMessagePrivateContext = (async () => {
      stageCalls += 1;
      return presence(true);
    }) as typeof conversationHomeApi.stageMessagePrivateContext;
    conversationHomeApi.discardMessagePrivateContext = (async () => {
      discardCalls += 1;
      return presence(false);
    }) as typeof conversationHomeApi.discardMessagePrivateContext;
    const fx = harness();
    try {
      fx.online.value = false;
      expect(fx.runtime.stage(range())).rejects.toThrow("Reconnect");
      expect(stageCalls).toBe(0);
      fx.online.value = true;
      await fx.runtime.stage(range());
      fx.online.value = false;
      expect(await fx.runtime.discardCurrent()).toBeFalse();
      expect(discardCalls).toBe(0);
      expect(fx.present.value).toBeTrue();
    } finally {
      fx.runtime.dispose();
      conversationHomeApi.stageMessagePrivateContext = originalStage;
      conversationHomeApi.discardMessagePrivateContext = originalDiscard;
    }
  });

  test("failed cleanup for root A cannot publish an error into root B", async () => {
    const originalStage = conversationHomeApi.stageMessagePrivateContext;
    const originalDiscard = conversationHomeApi.discardMessagePrivateContext;
    const cleanup = deferred<HomePrivateContextPresence>();
    conversationHomeApi.stageMessagePrivateContext = (async () =>
      presence(true)) as typeof conversationHomeApi.stageMessagePrivateContext;
    conversationHomeApi.discardMessagePrivateContext = (() =>
      cleanup.promise) as typeof conversationHomeApi.discardMessagePrivateContext;
    const fx = harness();
    try {
      await fx.runtime.stage(range("src/a.ts"));
      await fx.runtime.stage(range("src/a-replacement.ts"));
      fx.activeRootId.value = "root-b";
      fx.runtime.switchRoot();
      fx.composerError.value = "B stays intact";
      cleanup.reject(new Error("A cleanup failed"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fx.composerError.value).toBe("B stays intact");
      expect(fx.present.value).toBeFalse();
    } finally {
      fx.runtime.dispose();
      conversationHomeApi.stageMessagePrivateContext = originalStage;
      conversationHomeApi.discardMessagePrivateContext = originalDiscard;
    }
  });

  test("API routes and bodies are exact and never call the legacy Home handoff", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url, init = {}) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      const discard = String(url).endsWith("/discard");
      return new Response(JSON.stringify(presence(!discard)), {
        status: discard ? 200 : 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await conversationHomeApi.stageMessagePrivateContext("root/a", {
        schema_version: "1.0",
        enqueue_idempotency_key: "message-key",
        source_kind: "private-file-range",
        ...range(),
      });
      await conversationHomeApi.discardMessagePrivateContext("root/a", {
        schema_version: "1.0",
        idempotency_key: "discard-message",
        enqueue_idempotency_key: "message-key",
        expected_private_context_present: true,
      });
      await conversationHomeApi.stageDraftPrivateContext({
        schema_version: "1.0",
        create_idempotency_key: "create-key",
        source_kind: "private-file-range",
        ...range(),
      });
      await conversationHomeApi.discardDraftPrivateContext({
        schema_version: "1.0",
        idempotency_key: "discard-draft",
        create_idempotency_key: "create-key",
        expected_private_context_present: true,
      });
      expect(calls.map((call) => call.url)).toEqual([
        "/api/conversation-sessions/root%2Fa/messages/private-context",
        "/api/conversation-sessions/root%2Fa/messages/private-context/discard",
        "/api/conversation-drafts/private-context",
        "/api/conversation-drafts/private-context/discard",
      ]);
      expect(JSON.stringify(calls)).not.toContain("private-file-range-handoffs");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
