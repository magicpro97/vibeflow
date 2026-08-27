import { onUnmounted, watch } from "vue";
import {
  CONVERSATION_CLIENT_STREAM_STATE,
  CONVERSATION_SSE_EVENT,
  CONVERSATION_STREAM_RECOVERY_OUTCOME,
} from "../../../orchestrator/conversation/conversation-sse-contract.js";
import { conversationApi, conversationEventsUrl } from "../conversation-api.js";
import type { ConversationWorkspaceState } from "../conversation-store.js";
import {
  acceptConversationSnapshotFrame,
  acceptConversationTraceFrame,
} from "../conversation-stream-boundary.js";
import {
  type ConversationSnapshot,
  type ConversationTraceRecord,
  createConversationStreamAttemptGuard,
  recoverConversationStreamAttempt,
} from "../conversation-types.js";
export { buildConversationMessages } from "../conversation-message-projection.js";
const INVALID_TRACE_MESSAGE = "conversation trace event was invalid";

interface ConversationStreamBindings {
  state: ConversationWorkspaceState;
  currentCursor(): number;
  applySnapshot(snapshot: ConversationSnapshot): boolean;
  applyTrace(raw: ConversationTraceRecord): boolean;
  setStreamCredentials(token: string | null, expiresAt: string | null): void;
}

export function useConversationStream(bindings: ConversationStreamBindings) {
  const EventSourceConstructor = globalThis.EventSource as { new (url: string): EventSource };
  const renewStreamToken = conversationApi.renewStreamToken;
  const startTimer = globalThis.setTimeout.bind(globalThis);
  const clearTimer = globalThis.clearTimeout.bind(globalThis);
  const now = Date.now.bind(Date);
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let destroyed = false;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  };
  const clearRenewal = () => {
    if (renewTimer !== null) clearTimer(renewTimer);
    renewTimer = null;
  };
  const closeStream = () => {
    es?.close();
    es = null;
    clearRetry();
    clearRenewal();
  };
  const setStatus = (status: ConversationWorkspaceState["streamStatus"], error: string | null) => {
    bindings.state.streamStatus = status;
    bindings.state.streamError = error;
  };
  const scheduleReconnect = (delay = 1_000) => {
    clearRetry();
    if (destroyed || !bindings.state.activeConversationId || !bindings.state.streamToken) return;
    setStatus(CONVERSATION_CLIENT_STREAM_STATE.RECONNECTING, "conversation stream disconnected");
    retryTimer = startTimer(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };
  const renewToken = async (
    attemptGuard?: ReturnType<typeof createConversationStreamAttemptGuard>,
    expectedConversationId = bindings.state.activeConversationId,
    expectedGeneration = generation,
  ) => {
    if (attemptGuard && !attemptGuard.canRecover()) return false;
    const conversationId = expectedConversationId;
    if (!conversationId) return false;
    try {
      const renewed = await renewStreamToken(conversationId);
      if (
        destroyed ||
        bindings.state.activeConversationId !== conversationId ||
        generation !== expectedGeneration
      )
        return false;
      if (attemptGuard && !attemptGuard.canRecover()) return false;
      bindings.setStreamCredentials(renewed.stream_token, renewed.stream_token_expires_at);
      return true;
    } catch (error) {
      if (
        destroyed ||
        bindings.state.activeConversationId !== conversationId ||
        generation !== expectedGeneration
      )
        return false;
      if (attemptGuard && !attemptGuard.canRecover()) return false;
      setStatus(
        CONVERSATION_CLIENT_STREAM_STATE.ERROR,
        error instanceof Error ? error.message : "conversation stream token renewal failed",
      );
      return false;
    }
  };
  const scheduleRenewal = (
    attemptGuard: ReturnType<typeof createConversationStreamAttemptGuard>,
    conversationId: string,
    attempt: number,
  ) => {
    clearRenewal();
    const expiresAt = bindings.state.streamTokenExpiresAt;
    if (!expiresAt) return;
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(expires)) return;
    renewTimer = startTimer(
      () => {
        renewTimer = null;
        if (attemptGuard.canRecover()) void renewToken(attemptGuard, conversationId, attempt);
      },
      Math.max(1_000, expires - now() - 30_000),
    );
  };

  const connect = async () => {
    const conversationId = bindings.state.activeConversationId;
    const streamToken = bindings.state.streamToken;
    if (!conversationId || !streamToken || destroyed) {
      closeStream();
      setStatus(CONVERSATION_CLIENT_STREAM_STATE.IDLE, null);
      return;
    }
    generation += 1;
    const attempt = generation;
    const attemptGuard = createConversationStreamAttemptGuard();
    closeStream();
    setStatus(CONVERSATION_CLIENT_STREAM_STATE.CONNECTING, null);
    scheduleRenewal(attemptGuard, conversationId, attempt);
    es = new EventSourceConstructor(
      conversationEventsUrl(conversationId, streamToken, bindings.currentCursor()),
    );
    const current = es;

    current.addEventListener(CONVERSATION_SSE_EVENT.SNAPSHOT, (event) => {
      if (attempt !== generation) return;
      const accepted = acceptConversationSnapshotFrame(
        (event as MessageEvent).data,
        conversationId,
        bindings.applySnapshot,
      );
      setStatus(
        accepted ? CONVERSATION_CLIENT_STREAM_STATE.LIVE : CONVERSATION_CLIENT_STREAM_STATE.ERROR,
        accepted ? null : "conversation snapshot was invalid",
      );
    });

    current.addEventListener(CONVERSATION_SSE_EVENT.TRACE, (event) => {
      if (attempt !== generation) return;
      const accepted = acceptConversationTraceFrame(
        (event as MessageEvent).data,
        conversationId,
        bindings.applyTrace,
      );
      setStatus(
        accepted ? CONVERSATION_CLIENT_STREAM_STATE.LIVE : CONVERSATION_CLIENT_STREAM_STATE.ERROR,
        accepted ? null : INVALID_TRACE_MESSAGE,
      );
    });

    current.addEventListener(CONVERSATION_SSE_EVENT.ERROR, (event) => {
      if (attempt !== generation || !(event instanceof MessageEvent)) return;
      const failure = attemptGuard.acceptTypedError(event.data);
      if (failure.fatal) closeStream();
      setStatus(CONVERSATION_CLIENT_STREAM_STATE.ERROR, failure.message);
    });

    current.onerror = async () => {
      if (attempt !== generation || destroyed) return;
      const recovery = await recoverConversationStreamAttempt(
        attemptGuard,
        async () => {
          current.close();
          es = null;
          return renewToken(attemptGuard, conversationId, attempt);
        },
        () => attempt === generation && scheduleReconnect(1_500),
      );
      if (
        recovery === CONVERSATION_STREAM_RECOVERY_OUTCOME.RENEWED &&
        attempt === generation &&
        !destroyed
      )
        void connect();
    };
  };

  watch(
    () => [bindings.state.activeConversationId, bindings.state.streamToken] as const,
    () => {
      void connect();
    },
    { immediate: true },
  );

  onUnmounted(() => {
    destroyed = true;
    closeStream();
  });

  return {
    reconnect: () => void connect(),
    disconnect: () => {
      generation += 1;
      closeStream();
      setStatus(CONVERSATION_CLIENT_STREAM_STATE.IDLE, null);
    },
  };
}
