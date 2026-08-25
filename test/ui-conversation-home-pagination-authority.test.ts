import { computed, reactive, ref, shallowRef } from "vue";
import { expect, test } from "bun:test";
import { createHomeActivePaginationRuntime } from "../src/ui/src/conversation-home-active-pagination.js";
import { conversationHomeApi } from "../src/ui/src/conversation-home-api.js";
import { ActivationEpoch } from "../src/ui/src/conversation-home-state.js";
import type { HomeTimelineResponse } from "../src/ui/src/conversation-home-types.js";

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;

function timeline(overrides: Partial<HomeTimelineResponse> = {}): HomeTimelineResponse {
  return {
    schema_version: "1.0",
    root_session_id: "root-a",
    head: {
      conversation_id: "conversation-a",
      revision_id: "revision-a",
      revision_ordinal: 0,
    },
    head_epoch: 4,
    head_digest: digest("a"),
    items: [],
    next_cursor: "next-a",
    ...overrides,
  };
}

test("timeline pagination restarts instead of merging a page from another authoritative head", async () => {
  const originalTimeline = conversationHomeApi.timeline;
  const epoch = new ActivationEpoch();
  const token = epoch.begin("root-a");
  const activeRootId = ref<string | null>("root-a");
  const selectedConversationId = computed(() => "conversation-a" as string | null);
  const current = timeline();
  const activeTimeline = shallowRef<HomeTimelineResponse | null>(current);
  const paging = reactive({
    timeline: { nextCursor: "next-a" as string | null, loadingMore: false },
    pending: { nextCursor: null as string | null, loadingMore: false },
  });
  const restarted: string[] = [];
  conversationHomeApi.timeline = (async () =>
    timeline({
      head: {
        conversation_id: "conversation-b",
        revision_id: "revision-b",
        revision_ordinal: 1,
      },
      head_epoch: 5,
      head_digest: digest("b"),
      items: [],
      next_cursor: null,
    })) as typeof conversationHomeApi.timeline;
  try {
    const runtime = createHomeActivePaginationRuntime({
      token: () => token,
      generation: () => 7,
      activeRootId,
      selectedConversationId,
      timeline: activeTimeline,
      pendingActions: ref([]),
      paging,
      activationError: ref(""),
      restart: async (rootSessionId) => {
        restarted.push(rootSessionId);
      },
    });

    await runtime.loadMoreTimeline();

    expect(restarted).toEqual(["root-a"]);
    expect(activeTimeline.value).toBe(current);
    expect(activeTimeline.value?.head_digest).toBe(digest("a"));
  } finally {
    conversationHomeApi.timeline = originalTimeline;
    epoch.close();
  }
});
