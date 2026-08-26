import { computed } from "vue";
import { resolveHomeQuoteStatus } from "../conversation-home-authoring.js";
import { projectHomeTimeline } from "../conversation-home-projection.js";
import { useConversationHomeStore } from "../conversation-home-store.js";

export function useHomeComposerQuotes() {
  const store = useConversationHomeStore();
  const visibleQuoteSources = computed(() => {
    const sources = new Map<
      string,
      {
        source_key: string;
        root_session_id: string | null;
        author: string;
        excerpt: string;
        target_event_id: string | null;
        content_digest: string | null;
      }
    >();
    for (const item of projectHomeTimeline(store.timeline?.items ?? [])) {
      if (!item.anchorKey) continue;
      sources.set(item.anchorKey, {
        source_key: item.anchorKey,
        root_session_id: store.activeRootId,
        author: item.title,
        excerpt: item.body,
        target_event_id: item.messageRef?.target_event_id ?? null,
        content_digest: item.messageRef?.content_digest ?? null,
      });
    }
    return sources;
  });
  const quoteChips = computed(() =>
    store.quoteRefs.map((reference) => {
      const visible = visibleQuoteSources.value.get(reference.source_key) ?? null;
      const resolved = resolveHomeQuoteStatus(reference, store.activeRootId, visible);
      return {
        reference,
        status: resolved.status,
        message: resolved.message,
        canJump: Boolean(visible),
      };
    }),
  );
  return { quoteChips };
}
