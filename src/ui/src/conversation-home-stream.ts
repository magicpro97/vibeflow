import {
  conversationApi,
  conversationEventsUrl,
  parseConversationSseRecord,
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
import type { ConversationSnapshot, ConversationTraceRecord } from "./conversation-types.js";
import {
  createConversationStreamAttemptGuard,
  isTerminalLifecycle,
  recoverConversationStreamAttempt,
} from "./conversation-types.js";

export function degradedHomeTimelineInteraction(): HomeTimelineInteraction {
  return {
    state: "degraded",
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
    if (item.kind !== "conversation-event") continue;
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
    kind: "conversation-event",
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
    if (item.kind !== "conversation-event") return item;
    const locator = item.interaction.message_locator;
    if (!locator || locator.target_event_id !== messageRef.target_event_id) return item;
    changed = true;
    return {
      ...item,
      interaction: {
        ...item.interaction,
        state: "ready" as const,
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

export const HOME_MESSAGE_QUEUE_INVALIDATION_EVENT = "message-queue-invalidated";

export function watchHomeConversationStream(input: HomeConversationStreamInput): { close(): void } {
  const EventSourceCtor = globalThis.EventSource as { new (url: string): EventSource } | undefined;
  if (!EventSourceCtor) {
    input.setStatus("idle", null);
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
    if (renewTimer !== null) clearTimeout(renewTimer);
    renewTimer = null;
  };
  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const clearRefresh = () => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
  };
  const queueRefresh = () => {
    clearRefresh();
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!closed && input.isCurrent()) input.onRefreshNeeded();
    }, 120);
  };
  const scheduleRenewal = (
    attemptGuard: ReturnType<typeof createConversationStreamAttemptGuard>,
  ) => {
    clearRenew();
    if (!streamTokenExpiresAt) return;
    const expires = Date.parse(streamTokenExpiresAt);
    if (!Number.isFinite(expires)) return;
    renewTimer = setTimeout(
      () => {
        renewTimer = null;
        if (attemptGuard.canRecover()) void renewToken(attemptGuard);
      },
      Math.max(1_000, expires - Date.now() - 30_000),
    );
  };
  const renewToken = async (
    attemptGuard?: ReturnType<typeof createConversationStreamAttemptGuard>,
  ) => {
    if (closed || !input.isCurrent()) return false;
    if (attemptGuard && !attemptGuard.canRecover()) return false;
    try {
      const renewed = await conversationApi.renewStreamToken(input.conversationId, input.signal);
      if (closed || !input.isCurrent()) return false;
      if (attemptGuard && !attemptGuard.canRecover()) return false;
      streamToken = renewed.stream_token;
      streamTokenExpiresAt = renewed.stream_token_expires_at;
      if (attemptGuard) scheduleRenewal(attemptGuard);
      return true;
    } catch (error) {
      if (closed || !input.isCurrent()) return false;
      if (attemptGuard && !attemptGuard.canRecover()) return false;
      input.setStatus(
        "error",
        error instanceof Error ? error.message : "conversation stream token renewal failed",
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
    input.setStatus("reconnecting", "conversation stream disconnected");
    retryTimer = setTimeout(() => {
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
    input.setStatus("connecting", null);
    scheduleRenewal(attemptGuard);
    const current = new EventSourceCtor(
      conversationEventsUrl(input.conversationId, streamToken, input.cursor()),
    );
    source = current;
    input.onQueueRefreshNeeded?.();

    current.addEventListener("snapshot", (event) => {
      if (closed || attemptId !== generation || !input.isCurrent()) return;
      try {
        input.onSnapshot(JSON.parse((event as MessageEvent<string>).data) as ConversationSnapshot);
        input.onQueueRefreshNeeded?.();
        input.setStatus("live", null);
      } catch {
        input.setStatus("error", "conversation snapshot was invalid");
      }
    });

    current.addEventListener(HOME_MESSAGE_QUEUE_INVALIDATION_EVENT, (event) => {
      if (closed || attemptId !== generation || !input.isCurrent()) return;
      try {
        if (!input.rootSessionId || !input.onQueueInvalidation)
          throw new Error("message queue stream binding is unavailable");
        const invalidation: unknown = JSON.parse((event as MessageEvent<string>).data);
        assertHomeQueueInvalidation(invalidation, input.rootSessionId);
        input.onQueueInvalidation(invalidation);
        input.setStatus("live", null);
      } catch {
        input.setStatus("error", "message queue update was invalid");
        input.onQueueRefreshNeeded?.();
      }
    });

    current.addEventListener("trace", (event) => {
      if (closed || attemptId !== generation || !input.isCurrent()) return;
      try {
        const record = parseConversationSseRecord((event as MessageEvent<string>).data);
        input.onTrace(record);
        input.setStatus("live", null);
        if (
          record.event.type === "user_message" ||
          record.event.type === "state_change" ||
          record.event.type === "conversation_terminal" ||
          (record.event.type === "agent_response_delta" && record.event.payload.completes_response)
        )
          queueRefresh();
      } catch {
        input.setStatus("error", "conversation trace event was invalid");
        queueRefresh();
      }
    });

    current.addEventListener("error", (event) => {
      if (
        closed ||
        attemptId !== generation ||
        !input.isCurrent() ||
        !(event instanceof MessageEvent)
      )
        return;
      const failure = attemptGuard.acceptTypedError(event.data);
      if (failure.fatal) closeSource();
      input.setStatus("error", failure.message);
    });

    current.onerror = async () => {
      if (closed || attemptId !== generation || !input.isCurrent()) return;
      await recoverConversationStreamAttempt(
        attemptGuard,
        async () => {
          current.close();
          source = null;
          return renewToken(attemptGuard);
        },
        () => attemptId === generation && scheduleReconnect(),
      );
    };
  };

  void connect();
  return {
    close() {
      closed = true;
      generation += 1;
      closeSource();
      input.setStatus("idle", null);
    },
  };
}
