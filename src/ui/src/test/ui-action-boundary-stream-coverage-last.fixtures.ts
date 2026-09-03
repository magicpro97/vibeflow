import { computed, reactive, ref, shallowRef } from "vue";
import { parseConversationSseSnapshot } from "../conversation-api.js";
import type { HomeMessageQueueSnapshot } from "../conversation-home-message-queue-types.js";
import type { HomeQueryApiAuthority } from "../conversation-home-query-authority.js";
import { defineHomeQueryRuntimeAuthority } from "../conversation-home-query-authority.js";
import { createHomeQueryRuntime } from "../conversation-home-query-runtime.js";
import { isHomeActionOperationState } from "../conversation-home-runtime.js";
import { ActivationEpoch } from "../conversation-home-state.js";
import {
  type HomeConversationStreamAuthority,
  shouldStreamHomeRevision,
} from "../conversation-home-stream.js";
import type {
  HomeActionView,
  HomeAuthoritativeHeadResponse,
  HomeCapabilityItem,
  HomePagingState,
  HomeRevisionSummary,
  HomeSessionSummary,
  HomeTimelineResponse,
} from "../conversation-home-types.js";
import { at, digest, id } from "./ui-action-boundary-coverage-last.fixtures.js";

export interface CapturedHomeStreamAuthorityResult {
  instanceCount: number;
  headCalls: number;
  parsedLastSeq: number;
  operationStateAccepted: boolean;
  terminalQueueStreams: boolean;
}

export async function exerciseCapturedHomeStreamAuthority(): Promise<CapturedHomeStreamAuthorityResult> {
  type Listener = (event: Event) => void;
  let publishSource!: (source: FakeEventSource) => void;
  const sourceReady = new Promise<FakeEventSource>((resolve) => {
    publishSource = resolve;
  });
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    private listeners = new Map<string, Listener[]>();
    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
      publishSource(this);
    }
    addEventListener(type: string, listener: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    emit(type: string, value: unknown) {
      const event = new MessageEvent(type, { data: JSON.stringify(value) });
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    close() {}
  }
  const revision: HomeRevisionSummary = {
    schema_version: "1.0",
    conversation_id: "conversation-a",
    revision_id: "revision-a",
    revision_ordinal: 0,
    parent_conversation_id: null,
    parent_revision_id: null,
    lineage_status: "verified",
    topic: "Queued terminal",
    policy: "direct",
    lifecycle: "ACTIVE",
    health: "healthy",
    participants: [],
    created_at: at(0),
    updated_at: at(1),
    last_seq: 1,
    lock_digest: digest("a"),
  };
  const session: HomeSessionSummary = {
    schema_version: "1.0",
    root_session_id: "root-a",
    head_status: "committed",
    root: revision,
    active_conversation_id: revision.conversation_id,
    active_revision_id: revision.revision_id,
    active_revision_ordinal: 0,
    revision_count: 1,
    active: revision,
    matched_revision: null,
    association_ids: [],
    sort_updated_at: at(1),
    lineage_cursor: "lineage-a",
  };
  const queued: HomeMessageQueueSnapshot["items"][number] = {
    schema_version: "1.0",
    queue_item_id: id("queued-message", "1"),
    queue_sequence: 1,
    root_session_id: "root-a",
    author_public_id: "human",
    content: "continue",
    content_digest: digest("1"),
    target_participants: "all",
    quote_refs: [],
    private_context_present: false,
    predecessor_queue_item_id: null,
    admitted_authority_digest: digest("2"),
    effective_authority_digest: digest("2"),
    state: "queued",
    stale_reason: null,
    admitted_at: at(1),
    updated_at: at(1),
    item_digest: digest("3"),
  };
  let headCalls = 0;
  let publishSecondHead!: () => void;
  const secondHeadRead = new Promise<void>((resolve) => {
    publishSecondHead = resolve;
  });
  const streamSource: {
    eventSourceConstructor: HomeConversationStreamAuthority["eventSourceConstructor"];
    renewStreamToken: HomeConversationStreamAuthority["renewStreamToken"];
    startTimer: HomeConversationStreamAuthority["startTimer"];
    clearTimer: HomeConversationStreamAuthority["clearTimer"];
    now: HomeConversationStreamAuthority["now"];
  } = {
    eventSourceConstructor: FakeEventSource as unknown as new (url: string) => EventSource,
    renewStreamToken: async () => ({
      stream_token: "token",
      stream_token_expires_at: "invalid",
    }),
    startTimer: () => 42 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
    now: () => Date.parse(at(1)),
  };
  const authoritativeHead: HomeAuthoritativeHeadResponse = {
    schema_version: "1.0",
    root_session_id: "root-a",
    head_status: "committed",
    head_epoch: 1,
    head_digest: digest("4"),
    active: revision,
  };
  const timelineResponse: HomeTimelineResponse = {
    schema_version: "1.0",
    root_session_id: "root-a",
    head: {
      conversation_id: revision.conversation_id,
      revision_id: revision.revision_id,
      revision_ordinal: 0,
    },
    head_epoch: 1,
    head_digest: digest("4"),
    items: [],
    next_cursor: null,
  };
  const queueSnapshot: HomeMessageQueueSnapshot = {
    schema_version: "1.0",
    root_session_id: "root-a",
    current_authority_digest: digest("2"),
    max_nonterminal_items: 32,
    items: [queued],
  };
  const apiSource: HomeQueryApiAuthority = {
    sessions: async () => ({
      schema_version: "1.0",
      catalog_generation: digest("7"),
      catalog_health: "ready",
      source_watermark: digest("6"),
      items: [session],
      next_cursor: null,
      diagnostics: [],
    }),
    head: async () => {
      headCalls += 1;
      if (headCalls === 1) {
        apiSource.head = async () => {
          throw new Error("activation must retain its captured query authority");
        };
        streamSource.eventSourceConstructor = undefined;
        streamSource.renewStreamToken = async () => {
          throw new Error("activation must retain its captured stream authority");
        };
      }
      if (headCalls === 2) publishSecondHead();
      return authoritativeHead;
    },
    timeline: async () => timelineResponse,
    pending: async () => ({
      schema_version: "1.0",
      items: [],
      next_cursor: null,
      authority_watermark: digest("5"),
    }),
    messageQueue: async () => queueSnapshot,
    capabilities: async () => ({
      schema_version: "1.0",
      items: [],
      next_cursor: null,
      source_watermark: digest("8"),
    }),
  };
  const authority = defineHomeQueryRuntimeAuthority({
    api: apiSource,
    conversationStream: streamSource,
    operationStream: {
      eventSourceConstructor: FakeEventSource as unknown as new (url: string) => EventSource,
      operationEventsUrl: () => "/operation-events",
    },
  });
  const activeRootId = ref<string | null>(null);
  const selectedSession = shallowRef<HomeSessionSummary | null>(session);
  const head = shallowRef<HomeAuthoritativeHeadResponse | null>(null);
  const timeline = shallowRef<HomeTimelineResponse | null>(null);
  const pendingActions = ref<HomeActionView[]>([]);
  const messageQueue = shallowRef<HomeMessageQueueSnapshot | null>(null);
  const capabilities = ref<HomeCapabilityItem[]>([]);
  const paging = reactive<HomePagingState>({
    catalog: { nextCursor: null, loadingMore: false },
    timeline: { nextCursor: null, loadingMore: false },
    pending: { nextCursor: null, loadingMore: false },
    capability: { nextCursor: null, loadingMore: false },
  });
  const readEpoch = new ActivationEpoch();
  const commandAuthority = new ActivationEpoch();
  const runtime = createHomeQueryRuntime(
    {
      sessions: ref([session]),
      sessionQuery: ref(""),
      catalogHealth: ref("ready"),
      catalogLoading: ref(false),
      catalogError: ref(""),
      activeRootId,
      selectedSession,
      authoritativeHead: head,
      timeline,
      pendingActions,
      adoptMessageQueueSnapshot: (snapshot) => {
        messageQueue.value = snapshot;
      },
      clearMessageQueueProjection: () => {
        messageQueue.value = null;
      },
      messageQueueHasLiveItems: () =>
        Boolean(messageQueue.value?.items.some((item) => item.state === "queued")),
      activationLoading: ref(false),
      activationError: ref(""),
      online: ref(true),
      streamStatus: ref("idle"),
      streamError: ref(""),
      capabilities,
      capabilityQuery: ref(""),
      capabilityScope: ref("project"),
      capabilityLoading: ref(false),
      capabilityError: ref(""),
      paging,
      activeRevision: computed(() => head.value?.active ?? null),
      selectedConversationId: computed(() => head.value?.active?.conversation_id ?? null),
      readEpoch,
      commandAuthority,
    },
    authority,
  );
  try {
    await runtime.refreshSessions();
    await runtime.searchCapabilities();
    await runtime.selectSession("root-a");
    const source = await sourceReady;
    source.emit("snapshot", {
      conversation_id: "conversation-a",
      lifecycle: "COMPLETED",
      health: "healthy",
      policy: "direct",
      topic: "Queued terminal",
      participants: [],
      rounds: [],
      consensus_score: null,
      last_seq: 2,
    });
    await secondHeadRead;
    await Promise.allSettled([
      apiSource.head("root-a"),
      streamSource.renewStreamToken("conversation-a"),
    ]);
    return {
      instanceCount: FakeEventSource.instances.length,
      headCalls,
      parsedLastSeq: parseConversationSseSnapshot(
        JSON.stringify({
          conversation_id: "conversation-a",
          lifecycle: "COMPLETED",
          health: "healthy",
          policy: "direct",
          topic: "Queued terminal",
          participants: [],
          rounds: [],
          consensus_score: null,
          last_seq: 2,
        }),
      ).last_seq,
      operationStateAccepted: isHomeActionOperationState("succeeded"),
      terminalQueueStreams: shouldStreamHomeRevision({ ...revision, lifecycle: "COMPLETED" }, true),
    };
  } finally {
    runtime.dispose();
    commandAuthority.close();
  }
}
