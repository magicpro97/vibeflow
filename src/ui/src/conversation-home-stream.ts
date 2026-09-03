import { CONVERSATION_TIMELINE_ITEM_KIND } from "../../orchestrator/conversation/conversation-catalog-contract.js";
import { CONVERSATION_INTERACTION_STATE } from "../../orchestrator/conversation/conversation-interaction-contract.js";
import { CONVERSATION_TRACE_EVENT_KIND } from "../../orchestrator/conversation/conversation-public-wire-contract.js";
import {
  CONVERSATION_CLIENT_STREAM_STATE,
  CONVERSATION_SSE_EVENT,
  CONVERSATION_STREAM_RECOVERY_OUTCOME,
} from "../../orchestrator/conversation/conversation-sse-contract.js";
import {
  conversationApi,
  conversationEventsUrl,
  parseConversationSseRecord,
  parseConversationSseSnapshot,
} from "./conversation-api.js";
import { assertHomeQueueInvalidation } from "./conversation-home-message-queue-authority.js";
import type { HomeMessageQueueInvalidation } from "./conversation-home-message-queue-types.js";
import { homeTimelineItemKey } from "./conversation-home-pagination.js";
import type {
  HomeCanonicalMessageReference,
  HomeConversationStreamStatus,
  HomeReactionSummary,
  HomeRevisionSummary,
  HomeTimelineInteraction,
  HomeTimelineItem,
  HomeTimelineResponse,
} from "./conversation-home-types.js";
import { CONVERSATION_STREAM_ERROR_MESSAGE } from "./conversation-stream-error-contract.js";
import type { ConversationSnapshot, ConversationTraceRecord } from "./conversation-types.js";
import {
  createConversationStreamAttemptGuard,
  isTerminalLifecycle,
  recoverConversationStreamAttempt,
} from "./conversation-types.js";

export function degradedHomeTimelineInteraction(): HomeTimelineInteraction {
  return {
    state: CONVERSATION_INTERACTION_STATE.DEGRADED,
    message_locator: null,
    quote_refs: [],
    reactions: [],
    diagnostic_code: null,
  };
}

export function shouldStreamHomeRevision(
  revision: HomeRevisionSummary | null,
  hasLiveQueueItems = false,
): boolean {
  return Boolean(revision && (hasLiveQueueItems || !isTerminalLifecycle(revision.lifecycle)));
}

export function homeTimelineCursorForRevision(
  timeline: HomeTimelineResponse | null,
  conversationId: string,
  revisionId: string,
): number {
  if (!timeline) return 0;
  let cursor = 0;
  for (const item of timeline.items) {
    if (item.kind !== CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_EVENT) continue;
    if (item.event.conversation_id !== conversationId || item.event.revision_id !== revisionId)
      continue;
    cursor = Math.max(cursor, item.event.seq);
  }
  return cursor;
}

export function appendHomeTimelineTrace(
  timeline: HomeTimelineResponse | null,
  revision: HomeRevisionSummary | null,
  record: ConversationTraceRecord,
): HomeTimelineResponse | null {
  if (!timeline || !revision) return timeline;
  if (
    record.conversation_id !== revision.conversation_id ||
    record.revision_id !== revision.revision_id
  )
    return timeline;
  const nextItem: HomeTimelineItem = {
    kind: CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_EVENT,
    revision_ordinal: revision.revision_ordinal,
    event: {
      ...record,
      public_session_ref: record.public_session_ref ?? null,
    },
    interaction: degradedHomeTimelineInteraction(),
    action_operations: { items: [] },
  };
  const merged = new Map<string, HomeTimelineItem>();
  for (const item of timeline.items) merged.set(homeTimelineItemKey(item), item);
  merged.set(homeTimelineItemKey(nextItem), nextItem);
  return {
    ...timeline,
    items: [...merged.values()],
  };
}

export function applyHomeReactionFold(
  timeline: HomeTimelineResponse | null,
  messageRef: HomeCanonicalMessageReference,
  reactions: HomeReactionSummary[],
): HomeTimelineResponse | null {
  if (!timeline) return timeline;
  let changed = false;
  const items = timeline.items.map((item): HomeTimelineItem => {
    if (item.kind !== CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_EVENT) return item;
    const locator = item.interaction.message_locator;
    if (!locator || locator.target_event_id !== messageRef.target_event_id) return item;
    changed = true;
    return {
      ...item,
      interaction: {
        ...item.interaction,
        state: CONVERSATION_INTERACTION_STATE.READY,
        message_locator: structuredClone(messageRef),
        reactions: reactions.map((reaction) => structuredClone(reaction)),
      },
    };
  });
  return changed ? { ...timeline, items } : timeline;
}

interface HomeConversationStreamInput {
  conversationId: string;
  rootSessionId?: string;
  cursor(): number;
  signal: AbortSignal;
  isCurrent(): boolean;
  setStatus(status: HomeConversationStreamStatus, error: string | null): void;
  onSnapshot(snapshot: ConversationSnapshot): void;
  onTrace(record: ConversationTraceRecord): void;
  onRefreshNeeded(): void;
  onQueueInvalidation?(invalidation: HomeMessageQueueInvalidation): void;
  onQueueRefreshNeeded?(): void;
}

export interface HomeConversationStreamAuthority {
  readonly eventSourceConstructor: (new (url: string) => EventSource) | undefined;
  readonly renewStreamToken: typeof conversationApi.renewStreamToken;
  readonly startTimer: (
    callback: () => void,
    delayMilliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  readonly now: () => number;
}

export function captureHomeConversationStreamAuthority(): HomeConversationStreamAuthority {
  const startTimer = globalThis.setTimeout.bind(globalThis);
  const clearTimer = globalThis.clearTimeout.bind(globalThis);
  const now = Date.now.bind(Date);
  return Object.freeze({
    eventSourceConstructor: globalThis.EventSource as
      | (new (
          url: string,
        ) => EventSource)
      | undefined,
    renewStreamToken: conversationApi.renewStreamToken,
    startTimer: (callback: () => void, delayMilliseconds: number) =>
      startTimer(callback, delayMilliseconds),
    clearTimer: (timer: ReturnType<typeof setTimeout>) => clearTimer(timer),
    now: () => now(),
  });
}

export const HOME_MESSAGE_QUEUE_INVALIDATION_EVENT =
  CONVERSATION_SSE_EVENT.MESSAGE_QUEUE_INVALIDATED;

export function watchHomeConversationStream(
  input: HomeConversationStreamInput,
  authority = captureHomeConversationStreamAuthority(),
): { close(): void } {
  const EventSourceCtor = authority.eventSourceConstructor;
  if (!EventSourceCtor) {
    input.setStatus(CONVERSATION_CLIENT_STREAM_STATE.IDLE, null);
    return { close() {} };
  }

  let source: EventSource | null = null;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let generation = 0;
  let streamToken: string | null = null;
  let streamTokenExpiresAt: string | null = null;

  const clearRenew = () => {
    if (renewTimer !== null) authority.clearTimer(renewTimer);
    renewTimer = null;
  };
  const clearRetry = () => {
    if (retryTimer !== null) authority.clearTimer(retryTimer);
    retryTimer = null;
  };
  const clearRefresh = () => {
    if (refreshTimer !== null) authority.clearTimer(refreshTimer);
    refreshTimer = null;
  };
  const queueRefresh = () => {
    clearRefresh();
    refreshTimer = authority.startTimer(() => {
      refreshTimer = null;
      if (!closed && input.isCurrent()) input.onRefreshNeeded();
    }, 120);
  };
  const scheduleRenewal = (
    attemptGuard: ReturnType<typeof createConversationStreamAttemptGuard>,
    expectedGeneration: number,
  ) => {
    clearRenew();
    if (!streamTokenExpiresAt) return;
    const expires = Date.parse(streamTokenExpiresAt);
    if (!Number.isFinite(expires)) return;
    renewTimer = authority.startTimer(
      () => {
        renewTimer = null;
        if (attemptGuard.canRecover()) void renewToken(attemptGuard, expectedGeneration);
      },
      Math.max(1_000, expires - authority.now() - 30_000),
    );
  };
  const renewToken = async (
    attemptGuard?: ReturnType<typeof createConversationStreamAttemptGuard>,
    expectedGeneration = generation,
  ) => {
    if (closed || !input.isCurrent() || generation !== expectedGeneration) return false;
    if (attemptGuard && !attemptGuard.canRecover()) return false;
    try {
      const renewed = await authority.renewStreamToken(input.conversationId, input.signal);
      if (closed || !input.isCurrent() || generation !== expectedGeneration) return false;
      if (attemptGuard && !attemptGuard.canRecover()) return false;
      streamToken = renewed.stream_token;
      streamTokenExpiresAt = renewed.stream_token_expires_at;
      if (attemptGuard) scheduleRenewal(attemptGuard, expectedGeneration);
      return true;
    } catch (error) {
      if (closed || !input.isCurrent() || generation !== expectedGeneration) return false;
      if (attemptGuard && !attemptGuard.canRecover()) return false;
      input.setStatus(
        CONVERSATION_CLIENT_STREAM_STATE.ERROR,
        error instanceof Error
          ? error.message
          : CONVERSATION_STREAM_ERROR_MESSAGE.TOKEN_RENEWAL_FAILED,
      );
      return false;
    }
  };
  const closeSource = () => {
    source?.close();
    source = null;
    clearRenew();
    clearRetry();
    clearRefresh();
  };
  const scheduleReconnect = (delay = 1_500) => {
    clearRetry();
    if (closed || !input.isCurrent() || !streamToken) return;
    input.setStatus(
      CONVERSATION_CLIENT_STREAM_STATE.RECONNECTING,
      CONVERSATION_STREAM_ERROR_MESSAGE.DISCONNECTED,
    );
    retryTimer = authority.startTimer(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  const connect = async () => {
    if (closed || !input.isCurrent()) return;
    if (!streamToken && !(await renewToken())) return;
    if (!streamToken) return;
    generation += 1;
    const attemptId = generation;
    const attemptGuard = createConversationStreamAttemptGuard();
    closeSource();
    input.setStatus(CONVERSATION_CLIENT_STREAM_STATE.CONNECTING, null);
    scheduleRenewal(attemptGuard, attemptId);
    const current = new EventSourceCtor(
      conversationEventsUrl(input.conversationId, streamToken, input.cursor()),
    );
    source = current;
    input.onQueueRefreshNeeded?.();

    current.addEventListener(CONVERSATION_SSE_EVENT.SNAPSHOT, (event) => {
      if (closed || attemptId !== generation || !input.isCurrent()) return;
      try {
        input.onSnapshot(
          parseConversationSseSnapshot((event as MessageEvent<string>).data, input.conversationId),
        );
        input.onQueueRefreshNeeded?.();
        input.setStatus(CONVERSATION_CLIENT_STREAM_STATE.LIVE, null);
      } catch {
        input.setStatus(
          CONVERSATION_CLIENT_STREAM_STATE.ERROR,
          CONVERSATION_STREAM_ERROR_MESSAGE.SNAPSHOT_INVALID,
        );
      }
    });

    current.addEventListener(HOME_MESSAGE_QUEUE_INVALIDATION_EVENT, (event) => {
      if (closed || attemptId !== generation || !input.isCurrent()) return;
      try {
        if (!input.rootSessionId || !input.onQueueInvalidation)
          throw new Error(CONVERSATION_STREAM_ERROR_MESSAGE.MESSAGE_QUEUE_BINDING_UNAVAILABLE);
        const invalidation: unknown = JSON.parse((event as MessageEvent<string>).data);
        assertHomeQueueInvalidation(invalidation, input.rootSessionId);
        input.onQueueInvalidation(invalidation);
        input.setStatus(CONVERSATION_CLIENT_STREAM_STATE.LIVE, null);
      } catch {
        input.setStatus(
          CONVERSATION_CLIENT_STREAM_STATE.ERROR,
          CONVERSATION_STREAM_ERROR_MESSAGE.MESSAGE_QUEUE_UPDATE_INVALID,
        );
        input.onQueueRefreshNeeded?.();
      }
    });

    current.addEventListener(CONVERSATION_SSE_EVENT.TRACE, (event) => {
      if (closed || attemptId !== generation || !input.isCurrent()) return;
      try {
        const record = parseConversationSseRecord((event as MessageEvent<string>).data);
        if (record.conversation_id !== input.conversationId)
          throw new Error(CONVERSATION_STREAM_ERROR_MESSAGE.TRACE_IDENTITY_MISMATCH);
        input.onTrace(record);
        input.setStatus(CONVERSATION_CLIENT_STREAM_STATE.LIVE, null);
        if (
          record.event.type === CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE ||
          record.event.type === CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE ||
          record.event.type === CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL ||
          (record.event.type === CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA &&
            record.event.payload.completes_response)
        )
          queueRefresh();
      } catch {
        input.setStatus(
          CONVERSATION_CLIENT_STREAM_STATE.ERROR,
          CONVERSATION_STREAM_ERROR_MESSAGE.TRACE_INVALID,
        );
        queueRefresh();
      }
    });

    current.addEventListener(CONVERSATION_SSE_EVENT.ERROR, (event) => {
      if (
        closed ||
        attemptId !== generation ||
        !input.isCurrent() ||
        !(event instanceof MessageEvent)
      )
        return;
      const failure = attemptGuard.acceptTypedError(event.data);
      if (failure.fatal) closeSource();
      input.setStatus(CONVERSATION_CLIENT_STREAM_STATE.ERROR, failure.message);
    });

    current.onerror = async () => {
      if (closed || attemptId !== generation || !input.isCurrent()) return;
      const recovery = await recoverConversationStreamAttempt(
        attemptGuard,
        async () => {
          current.close();
          source = null;
          return renewToken(attemptGuard, attemptId);
        },
        () => attemptId === generation && scheduleReconnect(),
      );
      if (
        recovery === CONVERSATION_STREAM_RECOVERY_OUTCOME.RENEWED &&
        !closed &&
        attemptId === generation &&
        input.isCurrent()
      )
        void connect();
    };
  };

  void connect();
  return {
    close() {
      closed = true;
      generation += 1;
      closeSource();
      input.setStatus(CONVERSATION_CLIENT_STREAM_STATE.IDLE, null);
    },
  };
}
