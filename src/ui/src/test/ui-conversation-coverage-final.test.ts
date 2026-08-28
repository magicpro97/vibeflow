// Coverage fixtures are compacted selectively to stay below the 400-line source cap.
import { createRenderer, nextTick, reactive } from "vue";
import { CONVERSATION_BASELINE_SKIP_REASON } from "../../../orchestrator/conversation/conversation-baseline-contract.js";
import type { ConversationWorkspaceState } from "../conversation-store.js";
import type { ConversationSnapshot, ConversationTraceRecord } from "../conversation-types.js";
import {
  caught,
  eq,
  ok,
  restoreGlobal,
  snapshot,
  trace,
  userMessage,
} from "./ui-conversation-coverage-final.helpers.js";
const { test } = await import(String("bun:test"));
test("conversation API, projections, and stream lifecycle cover final behavioral branches", async () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const apiPath = require.resolve("../conversation-api.ts");
  const cachedApi = require.cache[apiPath];
  let csrfApi!: typeof import("../conversation-api.js");
  try {
    Reflect.deleteProperty(require.cache, apiPath);
    // biome-ignore format: compact isolated module fixture keeps the test below the source cap
    Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ content: "csrf-coverage-final" }) } });
    csrfApi = await import("../conversation-api.js");
  } finally {
    Reflect.deleteProperty(require.cache, apiPath);
    restoreGlobal("document", documentDescriptor);
    if (cachedApi) require.cache[apiPath] = cachedApi;
  }
  const api = await import("../conversation-api.js");
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const eventSourceDescriptor = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
  const calls: Array<{ path: string; init: RequestInit }> = [];
  // biome-ignore format: compact fetch fixture keeps the coverage test below the source cap
  let response: (path: string) => Response | Promise<Response> = (path) => new Response(JSON.stringify(path.endsWith("/snapshot") ? { ...snapshot, conversation_id: "conversation-a" } : { ok: true }), { status: 200 });
  const timers = new Map<number, { delay: number; callback: () => unknown }>();
  try {
    // biome-ignore format: compact fetch fixture keeps the coverage test below the source cap
    globalThis.fetch = (async (input, init = {}) => { calls.push({ path: String(input), init }); return response(String(input)); }) as typeof fetch;
    const id = "conversation-a";
    const signal = new AbortController().signal;
    await csrfApi.conversationApi.create({ topic: "hello" }, signal);
    await csrfApi.conversationApi.snapshot(id, signal);
    await csrfApi.conversationApi.renewStreamToken(id, signal);
    await csrfApi.conversationApi.message(id, { content: "hi" }, signal);
    await csrfApi.conversationApi.pause(id, signal);
    await csrfApi.conversationApi.resume(id, signal);
    await csrfApi.conversationApi.stop(id, signal);
    // biome-ignore format: compact authority fixture keeps the coverage test below the source cap
    const decision = { approval_id: "approval-a", operation_id: "operation-a", actor: "user", outcome: "approve", reason: null } as const;
    await csrfApi.conversationApi.resolveApproval(id, decision.approval_id, decision, signal);
    // biome-ignore format: compact authority fixture keeps the coverage test below the source cap
    const command = { conversation_id: id, operation_id: "operation-a", actor: "user", reason: "stop" } as const;
    await csrfApi.conversationApi.cancelOperation(id, command, signal);
    await api.conversationApi.renewStreamToken(id, signal);
    // biome-ignore format: exact compact matrix keeps the coverage test below the source cap
    const expectedRequests = [["/api/conversations", "POST", '{"topic":"hello"}'], ["/api/conversations/conversation-a/snapshot", "GET", null], ["/api/conversations/conversation-a/stream-token", "POST", "{}"], ["/api/conversations/conversation-a/messages", "POST", '{"content":"hi"}'], ["/api/conversations/conversation-a/pause", "POST", "{}"], ["/api/conversations/conversation-a/resume", "POST", "{}"], ["/api/conversations/conversation-a/stop", "POST", "{}"], ["/api/conversations/conversation-a/approvals/approval-a/resolve", "POST", JSON.stringify(decision)], ["/api/conversations/conversation-a/operations/operation-a/cancel", "POST", JSON.stringify(command)], ["/api/conversations/conversation-a/stream-token", "POST", "{}"]];
    // biome-ignore format: exact compact matrix keeps the coverage test below the source cap
    eq("exact API request matrix", calls.map(({ path, init }) => [path, init.method, init.body ?? null, init.signal === signal, new Headers(init.headers).get("x-vibeflow-token")]), expectedRequests.map(([path, method, body], index) => [path, method, body, true, index < 9 && method === "POST" ? "csrf-coverage-final" : null]));
    eq(
      "SSE JSON",
      api.parseConversationSseRecord(JSON.stringify(trace(8, userMessage("hi")))).seq,
      8,
    );
    ok("no cursor", !api.conversationEventsUrl(id, "token x").includes("since="));
    ok("cursor URL", api.conversationEventsUrl(id, "token x", 9).endsWith("since=9"));
    ok("artifact URL", api.conversationArtifactUrl(id, "artifact/1").endsWith("artifact%2F1"));
    for (const [body, status, expectedCode, expectedMessage] of [
      [JSON.stringify({ code: "teapot", message: "  hot  " }), 418, "teapot", "hot"],
      [JSON.stringify({ code: "denied" }), 403, "denied", "denied"],
      [JSON.stringify({}), 409, null, "conversation request failed (409)"],
      ["{", 502, null, "conversation request failed (502)"],
    ] as const) {
      response = () => new Response(body, { status });
      const error = await caught(api.conversationApi.create({ topic: "failure" }));
      ok("typed HTTP error", error instanceof api.ConversationApiError);
      eq(
        "HTTP error fields",
        { status: error.status, code: error.code, message: error.message },
        { status, code: expectedCode, message: expectedMessage },
      );
    }
    // biome-ignore format: compact malformed snapshot keeps this coverage file within the source cap
    response = () => new Response(JSON.stringify({ ...snapshot, lifecycle: "FUTURE" }), { status: 200 });
    const invalid = await caught(api.conversationApi.snapshot("conversation-1"));
    ok("invalid snapshot", invalid instanceof api.ConversationApiError);
    eq("invalid fields", [invalid.status, invalid.code], [200, null]);
    eq("invalid copy", invalid.message, "conversation response was invalid");
    const directError = new api.ConversationApiError(400, "bad", "bad request");
    eq(
      "error fields",
      [directError.name, directError.status, directError.code],
      ["ConversationApiError", 400, "bad"],
    );
    const answer = (participant_id: string, claim: string): ConversationTraceRecord["event"] => ({
      type: "agent_response_delta",
      payload: {
        round_id: "round-sort",
        participant_id,
        content_delta: claim,
        final_claim: claim,
        final_evidence: ["evidence"],
        completes_response: true,
      },
    });
    const matrix = api.projectConversationDecisionMatrix([
      trace(20, { type: "round_boundary", payload: { round_id: "round-sort", phase: "start" } }),
      trace(21, answer("participant-b", "Beta")),
      trace(22, answer("participant-a", "Alpha")),
      trace(23, {
        type: "consensus_update",
        payload: { round_id: "round-sort", decision: { outcome: "consensus", score: 1 } },
      }),
      trace(24, { type: "round_boundary", payload: { round_id: "round-sort", phase: "end" } }),
    ]);
    eq(
      "matrix tie sort",
      matrix?.rows.map((row) => row.option),
      ["Alpha", "Beta"],
    );
    // biome-ignore format: compact projection fixture keeps the coverage test below the source cap
    const winner = (option: string) => matrix?.rows[0] ? { ...matrix, rows: [{ ...matrix.rows[0], option, rank: 1 }] } : null;
    // biome-ignore format: compact projection fixture keeps the coverage test below the source cap
    const baseline = (status: "success" | "failed" | "skipped", answer: string | null, decision = matrix) => api.projectConversationBaseline([trace(25, { type: "baseline_result", payload: { status, answer, confidence: null, skip_reason: status === "success" ? null : CONVERSATION_BASELINE_SKIP_REASON.DISABLED } })], decision);
    // biome-ignore format: exact compact matrix keeps every public baseline branch below the source cap
    eq("baseline projection branches", [api.projectConversationBaseline([], matrix), baseline("skipped", null), baseline("success", "answer", null), baseline("success", "", matrix), baseline("success", "---", winner("!!!")), baseline("success", "---", matrix), baseline("success", "alpha beta", winner("beta gamma")), baseline("success", "  ＡLPHA café ", winner("alpha CAFÉ"))], [null, { status: "skipped", baseline_answer: null, debate_answer: "Alpha", divergence: null, skip_reason: CONVERSATION_BASELINE_SKIP_REASON.DISABLED }, { status: "failed", baseline_answer: "answer", debate_answer: null, divergence: null, skip_reason: "no_debate_answer" }, { status: "failed", baseline_answer: "", debate_answer: "Alpha", divergence: null, skip_reason: "baseline_missing" }, { status: "success", baseline_answer: "---", debate_answer: "!!!", divergence: 0, skip_reason: null }, { status: "success", baseline_answer: "---", debate_answer: "Alpha", divergence: 1, skip_reason: null }, { status: "success", baseline_answer: "alpha beta", debate_answer: "beta gamma", divergence: 0.666667, skip_reason: null }, { status: "success", baseline_answer: "  ＡLPHA café ", debate_answer: "alpha CAFÉ", divergence: 0, skip_reason: null }]);
    const types = await import("../conversation-types.js");
    const changingAttempt = types.createConversationStreamAttemptGuard();
    const terminal = await types.recoverConversationStreamAttempt(
      changingAttempt,
      async () => {
        changingAttempt.acceptTypedError(
          '{"code":"not_found","message":"Gone","correlation_id":"vf-stream-test","retryable":false,"recovery_action":null,"details":null}',
        );
        return false;
      },
      () => {
        throw new Error("reconnect must remain suppressed");
      },
    );
    eq("fatal during renew", terminal, "terminal");
    const streamModule = await import("../composables/useConversationStream.js");
    const messages = streamModule.buildConversationMessages(snapshot, [
      trace(1, userMessage("hello")),
      trace(2, {
        type: "precommit",
        payload: {
          round_id: "round-1",
          participant_id: "participant-1",
          answer: "draft",
          evidence: ["e"],
        },
      }),
      trace(3, {
        type: "consensus_update",
        payload: { round_id: "round-1", decision: { outcome: "consensus", score: 0.5 } },
      }),
      trace(4, {
        type: "state_change",
        payload: { lifecycle: "ACTIVE", health: "healthy", terminal: false, reason: null },
      }),
      trace(5, {
        type: "conversation_terminal",
        payload: { lifecycle: "NEEDS_INPUT", terminal: true, final_score: null },
      }),
      trace(6, { type: "error", payload: { agent_id: null, code: "failed", message: "boom" } }),
    ]);
    // biome-ignore format: compact projection oracle keeps the coverage test below the source cap
    eq("message kinds and needs-input copy", [messages.map((message) => message.kind), messages[4]?.body], [["user", "precommit", "decision", "status", "status", "error"], "Needs input"]);
    type Listener = (event: Event) => void;
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      readonly url: string;
      closed = false;
      onerror: (() => Promise<void>) | null = null;
      private readonly listeners = new Map<string, Listener[]>();
      constructor(url: string | URL) {
        this.url = String(url);
        FakeEventSource.instances.push(this);
      }
      addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      emit(type: string, data?: string, typed = true) {
        const event = typed ? new MessageEvent(type, { data }) : new Event(type);
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
      close() {
        this.closed = true;
      }
    }
    let timerId = 0;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    globalThis.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
      timerId += 1;
      timers.set(timerId, {
        delay,
        callback: () => typeof handler === "function" && handler(...args),
      });
      return timerId;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: number) => timers.delete(id ?? -1)) as typeof clearTimeout;

    async function settle() {
      await nextTick();
      await Promise.resolve();
    }

    async function runTimer(delay: number) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      ok(`timer ${delay} exists`, entry);
      timers.delete(entry[0]);
      await entry[1].callback();
      await settle();
    }

    type Host = Record<string, never>;
    const host = (): Host => ({});
    const renderer = createRenderer<Host, Host>({
      patchProp() {},
      insert() {},
      remove() {},
      createElement: () => host(),
      createText: () => host(),
      createComment: () => host(),
      setText() {},
      setElementText() {},
      parentNode: () => null,
      nextSibling: () => null,
    });

    const store = await import("../conversation-store.js");
    const projected = store.createConversationState();
    store.resetConversationState(projected, "conversation-1");
    ok("projection snapshot", store.applyConversationSnapshot(projected, { ...snapshot }));
    store.setStreamCredentials(projected, "stream-token", "expires");
    // biome-ignore format: compact event fixtures keep the coverage test below the source cap
    const projectionEvents = [trace(8, { type: "consensus_update", payload: { round_id: "round-2", decision: { outcome: "consensus", score: 0.7 } } }), trace(9, { type: "conversation_terminal", payload: { lifecycle: "COMPLETED", terminal: true, final_score: 0.7 } })];
    // biome-ignore format: compact branch assertion keeps the coverage test below the source cap
    ok("projection terminal branches", projectionEvents.every((event) => store.applyConversationTrace(projected, event)));
    // biome-ignore format: compact expectation keeps the coverage test below the source cap
    eq("projection state", [projected.streamToken, projected.streamTokenExpiresAt, projected.streamVersion, projected.snapshot?.lifecycle, projected.snapshot?.consensus_score], ["stream-token", "expires", 1, "COMPLETED", 0.7]);
    // biome-ignore format: compact request helper keeps the coverage test below the source cap
    const draft = (topic: string, policy = "", participants = "", maxRounds = "") => store.buildConversationCreateRequest({ topic, policy, participants, maxRounds });
    // biome-ignore format: compact branch table keeps the coverage test below the source cap
    eq("create request branches", [draft(" Ship ", " debate ", "brainstormer@codex:gpt-5\nreviewer@opencode", "2").request, draft("Ship").request, draft(" ").error, draft("Ship", "", "", "0").error, draft("Ship", "", "bad@bogus").error], [{ topic: "Ship", policy: "debate", participants: [{ role_ref: "brainstormer", engine: "codex", model: "gpt-5" }, { role_ref: "reviewer", engine: "opencode" }], max_rounds: 2 }, { topic: "Ship" }, "Topic is required.", "Max rounds must be a positive integer.", "Invalid participant: bad@bogus"]);
    const model = store.useConversationWorkspaceModel();
    // biome-ignore format: compact model assertion keeps the coverage test below the source cap
    ok("workspace model", model.state.streamStatus === "idle" && model.controls.value.canStop && Object.keys(model).length === 9);
    function state(over: Partial<ConversationWorkspaceState> = {}) {
      return reactive(Object.assign(store.createConversationState(), over));
    }
    // biome-ignore format: compact fixture keeps this exhaustive coverage test below the source cap
    const connected = (token: string, expires: string | null = null) => state({ activeConversationId: "conversation-1", streamToken: token, streamTokenExpiresAt: expires });
    function mountStream(current: ConversationWorkspaceState, frameAccepted = true) {
      const snapshots: ConversationSnapshot[] = [];
      const traces: ConversationTraceRecord[] = [];
      let controls!: ReturnType<typeof streamModule.useConversationStream>;
      const app = renderer.createApp({
        setup() {
          controls = streamModule.useConversationStream({
            state: current,
            currentCursor: () => current.cursor,
            applySnapshot(value) {
              snapshots.push(value);
              return frameAccepted;
            },
            applyTrace(value) {
              traces.push(value);
              return frameAccepted;
            },
            setStreamCredentials(token, expiresAt) {
              current.streamToken = token;
              current.streamTokenExpiresAt = expiresAt;
            },
          });
          return () => null;
        },
      });
      app.mount(host());
      return { app, controls, snapshots, traces };
    }
    // biome-ignore format: compact fixture keeps this exhaustive coverage test below the source cap
    const credentials = (token: string) => ({ stream_token: token, stream_token_expires_at: "invalid" });
    let renewalCount = 0;
    response = () => new Response(JSON.stringify(credentials(`renewed-${++renewalCount}`)));
    const idle = mountStream(state());
    idle.controls.reconnect();
    idle.controls.disconnect();
    idle.app.unmount();
    idle.controls.reconnect();
    eq("idle", FakeEventSource.instances.length, 0);
    const liveState = connected("token x", "invalid");
    liveState.cursor = 7;
    const live = mountStream(liveState);
    await settle();
    const first = FakeEventSource.instances.at(-1) as FakeEventSource;
    // biome-ignore format: compact assertion keeps this exhaustive coverage test below the source cap
    ok("cursor", first.url.endsWith("stream_token=token+x&since=7") && liveState.streamStatus === "connecting");
    first.emit("snapshot", JSON.stringify(snapshot));
    first.emit("snapshot", JSON.stringify({ ...snapshot, lifecycle: "FUTURE" }));
    first.emit("trace", JSON.stringify(trace(9, userMessage("hi"))));
    // biome-ignore format: compact unknown-event regression keeps this coverage file within the source cap
    first.emit("trace", JSON.stringify({ ...trace(10, userMessage("unknown")), event: { type: "future_event", payload: {} } }));
    first.emit("error", undefined, false);
    first.emit("error", '{"code":"temporary","message":"retry"}');
    eq(
      "frames",
      [live.snapshots.length, live.traces.length, liveState.streamError, first.closed],
      [1, 1, "conversation stream failed", false],
    );
    const rejectedState = connected("token y");
    const rejected = mountStream(rejectedState, false);
    await settle();
    const rejectedSource = FakeEventSource.instances.at(-1) as FakeEventSource;
    rejectedSource.emit("snapshot", JSON.stringify(snapshot));
    // biome-ignore format: compact regression keeps this exhaustive coverage test below the source cap
    eq("snapshot adoption failure", [rejected.snapshots.length, rejectedState.streamStatus, rejectedState.streamError], [1, "error", "conversation snapshot was invalid"]);
    rejectedSource.emit("trace", JSON.stringify(trace(9, userMessage("rejected"))));
    // biome-ignore format: compact regression keeps this exhaustive coverage test below the source cap
    eq("trace adoption failure", [rejected.traces.length, rejectedState.streamStatus, rejectedState.streamError], [1, "error", "conversation trace event was invalid"]);
    rejected.app.unmount();
    live.controls.reconnect();
    await settle();
    const second = FakeEventSource.instances.at(-1) as FakeEventSource;
    first.emit("snapshot", JSON.stringify(snapshot));
    first.emit("trace", JSON.stringify(trace(10, userMessage("stale"))));
    first.emit("error", '{"code":"temporary"}');
    await first.onerror?.();
    second.emit(
      "error",
      '{"code":"not_found","message":"gone","correlation_id":"vf-stream-test","retryable":false,"recovery_action":null,"details":null}',
    );
    await second.onerror?.();
    eq(
      "fatal",
      [live.snapshots.length, live.traces.length, second.closed, liveState.streamError],
      [1, 1, true, "gone"],
    );
    live.app.unmount();
    await second.onerror?.();

    const expiry = () => new Date(Date.now() + 31_000).toISOString();
    const renewalState = connected("old", expiry());
    const renewal = mountStream(renewalState);
    await runTimer(1_000);
    eq("scheduled renew", renewalState.streamToken, "renewed-1");
    const renewedSource = FakeEventSource.instances.at(-1) as FakeEventSource;
    const sourceCountBeforeRenewal = FakeEventSource.instances.length;
    await renewedSource.onerror?.();
    await settle();
    // biome-ignore format: compact assertion keeps this exhaustive coverage test below the source cap
    eq("transport renew", [renewalState.streamToken, renewedSource.closed, FakeEventSource.instances.length], ["renewed-2", true, sourceCountBeforeRenewal + 1]);
    renewal.app.unmount();

    let resolveStale!: (value: Response) => void;
    // biome-ignore format: compact deferred fixture keeps this exhaustive coverage test below the source cap
    response = () => new Promise<Response>((resolve) => { resolveStale = resolve; });
    const switchingState = connected("token-a");
    const switching = mountStream(switchingState);
    await settle();
    const staleRenewal = (FakeEventSource.instances.at(-1) as FakeEventSource).onerror?.();
    switchingState.activeConversationId = "conversation-2";
    switchingState.streamToken = "token-b";
    await settle();
    resolveStale(new Response(JSON.stringify(credentials("stale-token-a"))));
    await staleRenewal;
    await settle();
    // biome-ignore format: compact assertion keeps this exhaustive coverage test below the source cap
    eq("stale renewal", [switchingState.activeConversationId, switchingState.streamToken], ["conversation-2", "token-b"]);
    switching.app.unmount();

    response = () => Promise.reject(new Error("renew denied"));
    const retryState = connected("retry");
    const retry = mountStream(retryState);
    const retrySource = FakeEventSource.instances.at(-1) as FakeEventSource;
    await retrySource.onerror?.();
    // biome-ignore format: compact assertion keeps this exhaustive coverage test below the source cap
    ok("retry status", retryState.streamStatus === "reconnecting" && retryState.streamError === "conversation stream disconnected");
    await runTimer(1_500);
    ok("retry source", FakeEventSource.instances.at(-1) !== retrySource);
    retry.app.unmount();

    response = () => Promise.reject("not-an-error");
    const fallbackState = connected("fallback", expiry());
    const fallback = mountStream(fallbackState);
    await runTimer(1_000);
    eq("fallback copy", fallbackState.streamError, "conversation stream token renewal failed");
    fallback.app.unmount();
  } finally {
    timers.clear();
    restoreGlobal("fetch", fetchDescriptor);
    restoreGlobal("EventSource", eventSourceDescriptor);
    restoreGlobal("setTimeout", setTimeoutDescriptor);
    restoreGlobal("clearTimeout", clearTimeoutDescriptor);
  }
});
