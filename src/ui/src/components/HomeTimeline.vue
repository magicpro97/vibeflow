<template>
  <main id="conversation-main" ref="scroller" class="home-timeline" aria-label="Conversation" tabindex="0" @scroll="trackScroll">
    <HomePromptRail :entries="promptRail" @jump="jumpToAnchor" />
    <div v-if="store.activationError" class="home-inline-state home-inline-state--error" role="alert">
      <span><strong>Couldn’t refresh this conversation.</strong>{{ store.activationError }}</span>
      <button v-if="store.activeRootId" type="button" @click="store.selectSession(store.activeRootId)">Try again</button>
    </div>
    <section v-if="!store.activeSession" class="home-welcome" aria-labelledby="welcome-title">
      <span class="home-welcome__mark" aria-hidden="true">
        <svg viewBox="0 0 48 48"><path d="M24 5c0 10.5 8.5 19 19 19-10.5 0-19 8.5-19 19 0-10.5-8.5-19-19-19 10.5 0 19-8.5 19-19Z" /></svg>
      </span>
      <p>VibeFlow</p>
      <h1 id="welcome-title">What are we building?</h1>
      <p class="home-welcome__copy">
        Start naturally. VibeFlow will connect the right AI CLIs, preserve the conversation, and bring every reviewable action back here.
      </p>
      <HomeLoadingPanel
        v-if="store.submitting"
        variant="welcome"
        :eyebrow="welcomeLoading.eyebrow"
        :title="welcomeLoading.title"
        :detail="welcomeLoading.detail"
        :checkpoints="welcomeLoading.checkpoints"
        list-label="Conversation creation progress"
      />
      <div class="home-starters" aria-label="Conversation starters">
        <button v-for="starter in starters" :key="starter.title" type="button" @click="useStarter(starter.prompt)">
          <span aria-hidden="true">{{ starter.glyph }}</span>
          <strong>{{ starter.title }}</strong>
          <small>{{ starter.description }}</small>
        </button>
      </div>
      <p class="home-welcome__hint">No setup form. Describe the outcome; refine the team and tools in the conversation.</p>
    </section>
    <section v-else class="home-thread" aria-label="Conversation timeline" aria-live="polite" aria-relevant="additions text">
      <HomeLoadingPanel
        v-if="store.activationLoading && !store.timeline"
        variant="thread"
        :eyebrow="activationLoading.eyebrow"
        :title="activationLoading.title"
        :detail="activationLoading.detail"
        :checkpoints="activationLoading.checkpoints"
        list-label="Conversation restore progress"
      />
      <div v-else-if="!items.length && !store.pendingActions.length" class="home-empty-thread">
        <span aria-hidden="true">✦</span>
        <strong>The room is ready.</strong>
        <p>Send the first message, mention an agent, or add one with <kbd>+</kbd>.</p>
      </div>
      <template v-for="(item, index) in items" :key="item.id">
        <div v-if="item.kind === 'boundary'" class="home-revision-boundary" role="separator">
          <span />
          <strong>{{ item.title }}</strong>
          <small>{{ item.body }}</small>
          <span />
        </div>
        <article v-else-if="item.kind === 'user'" class="home-message home-message--user">
          <div class="home-message__avatar" aria-hidden="true">Y</div>
          <div
            :id="item.anchorKey ? homeTimelineMessageDomId(item.anchorKey) : undefined"
            class="home-message__content"
            :tabindex="item.anchorKey ? -1 : undefined"
          >
            <header><strong>{{ item.title }}</strong><time v-if="item.at" :datetime="item.at">{{ clock(item.at) }}</time></header>
            <p>{{ item.body }}</p>
            <HomeMessageQuotes
              v-if="item.quoteRefs.length"
              :quote-refs="item.quoteRefs"
              :author="quoteAuthor"
              @jump="jumpToQuoteTarget"
            />
            <p v-else-if="showInteractionPending(item)" class="home-interaction-hint">{{ interactionHint(item) }}</p>
            <HomeMessageInteractions
              v-if="item.messageRef"
              :item="item"
              :busy="reactionBusy(item)"
              :online="store.online"
              :quote-selected="quoteSelected(item)"
              @toggle-quote="toggleQuote(item)"
              @toggle-reaction="toggleReaction(item, $event)"
            />
          </div>
        </article>
        <article v-else-if="item.kind === 'assistant'" class="home-message home-message--assistant">
          <div class="home-message__avatar" aria-hidden="true">{{ initials(item.title) }}</div>
          <div
            :id="item.anchorKey ? homeTimelineMessageDomId(item.anchorKey) : undefined"
            class="home-message__content"
            :tabindex="item.anchorKey ? -1 : undefined"
          >
            <header>
              <strong>{{ item.title }}</strong>
              <HomeTurnStatus :started-at="turnStarts[index] ?? null" :finished-at="item.at" :complete="item.complete" />
              <time v-if="item.at" :datetime="item.at">{{ clock(item.at) }}</time>
            </header>
            <HomeCollapsibleAnswer
              v-if="shouldCollapseAnswer({ kind: item.kind, complete: item.complete, body: item.body, isLast: index === lastAnswerIndex })"
              :body="item.body"
            />
            <p v-else>{{ item.body }}</p>
            <HomeMessageQuotes
              v-if="item.quoteRefs.length"
              :quote-refs="item.quoteRefs"
              :author="quoteAuthor"
              @jump="jumpToQuoteTarget"
            />
            <p v-else-if="showInteractionPending(item)" class="home-interaction-hint">{{ interactionHint(item) }}</p>
            <details v-if="item.evidence.length" class="home-evidence">
              <summary>{{ item.evidence.length }} evidence reference{{ item.evidence.length === 1 ? '' : 's' }}</summary>
              <ul><li v-for="evidence in item.evidence" :key="evidence">{{ evidence }}</li></ul>
            </details>
            <HomeMessageInteractions
              v-if="item.messageRef"
              :item="item"
              :busy="reactionBusy(item)"
              :online="store.online"
              :quote-selected="quoteSelected(item)"
              @toggle-quote="toggleQuote(item)"
              @toggle-reaction="toggleReaction(item, $event)"
            />
          </div>
        </article>
        <HomeToolGroup v-else-if="item.kind === 'tool-group'" :item="item" />
        <div v-else class="home-system-event" :class="{ 'home-system-event--error': item.kind === 'error' }">
          <span aria-hidden="true">{{ item.kind === 'error' ? '!' : '·' }}</span>
          <div
            :id="item.anchorKey ? homeTimelineMessageDomId(item.anchorKey) : undefined"
            :tabindex="item.anchorKey ? -1 : undefined"
          >
            <p><strong>{{ item.title }}</strong>{{ item.body }}</p>
            <HomeMessageInteractions
              v-if="item.messageRef"
              :item="item"
              :busy="reactionBusy(item)"
              :online="store.online"
              :quote-selected="quoteSelected(item)"
              @toggle-quote="toggleQuote(item)"
              @toggle-reaction="toggleReaction(item, $event)"
            />
          </div>
          <time v-if="item.at" :datetime="item.at">{{ clock(item.at) }}</time>
        </div>
        <HomeAnchoredOperations v-if="item.kind !== 'boundary' && item.operations.length" :operations="item.operations" />
      </template>
      <div v-if="store.paging.timeline.nextCursor" class="home-action-stack">
        <button
          type="button"
          class="home-button"
          :disabled="store.paging.timeline.loadingMore"
          @click="store.loadMoreTimeline()"
        >{{ store.paging.timeline.loadingMore ? "Loading…" : "Load older timeline" }}</button>
      </div>
      <section v-if="store.pendingActions.length" class="home-action-stack" aria-label="Actions requiring attention">
        <header><span>Review queue</span><small>{{ store.pendingActions.length }} durable action{{ store.pendingActions.length === 1 ? '' : 's' }}</small></header>
        <HomeActionCard v-for="view in store.pendingActions" :key="view.proposal.proposal_id" :view="view" />
        <button
          v-if="store.paging.pending.nextCursor"
          type="button"
          class="home-button"
          :disabled="store.paging.pending.loadingMore"
          @click="store.loadMorePendingActions()"
        >{{ store.paging.pending.loadingMore ? "Loading…" : "Load older actions" }}</button>
      </section>
      <div ref="endMarker" class="home-thread-end" aria-hidden="true" />
    </section>
    <button v-if="showJump" class="home-jump-latest" type="button" @click="scrollLatest">Jump to latest <span aria-hidden="true">↓</span></button>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { homeTimelineMessageDomId, sameHomeQuoteRef } from "../conversation-home-authoring.js";
import {
  describeHomeActivationLoading,
  describeHomeWelcomeLoading,
} from "../conversation-home-loading.js";
import { homeParticipantDisplayLabel } from "../conversation-home-participant-label.js";
import type { RenderedHomeTimelineItem } from "../conversation-home-projection.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import type {
  HomeQuoteProjection,
  HomeQuoteReference,
  HomeReactionSummary,
} from "../conversation-home-types.js";
import { finalAnswerIndex, shouldCollapseAnswer } from "../lib/message-collapse.js";
import { buildPromptRail } from "../lib/prompt-rail.js";
import { turnStartAt } from "../lib/turn-timing.js";
import HomeActionCard from "./HomeActionCard.vue";
import HomeAnchoredOperations from "./HomeAnchoredOperations.vue";
import HomeCollapsibleAnswer from "./HomeCollapsibleAnswer.vue";
import HomeLoadingPanel from "./HomeLoadingPanel.vue";
import HomeMessageInteractions from "./HomeMessageInteractions.vue";
import HomeMessageQuotes from "./HomeMessageQuotes.vue";
import HomePromptRail from "./HomePromptRail.vue";
import HomeToolGroup from "./HomeToolGroup.vue";
import HomeTurnStatus from "./HomeTurnStatus.vue";
const store = useConversationHomeStore();
// Timeline rows are pre-projected by the parent (projectHomeTimeline in ConversationHome.vue,
// the single projection authority) and arrive here as the `items` prop.
const props = withDefaults(defineProps<{ items: RenderedHomeTimelineItem[] }>(), {
  items: () => [],
});
const scroller = ref<HTMLElement | null>(null);
const endMarker = ref<HTMLElement | null>(null);
const followLatest = ref(true);
const showJump = ref(false);
const turnStarts = computed(() =>
  props.items.map((_, index) => turnStartAt(props.items, index)),
);
/** Finality for answer collapse: the last assistant/user row, even with trailing tool/boundary rows. */
const lastAnswerIndex = computed(() => finalAnswerIndex(props.items));
const promptRail = computed(() => buildPromptRail(props.items));
const activationLoading = computed(() =>
  describeHomeActivationLoading({
    topic: store.activeSession?.active?.topic ?? store.activeSession?.root.topic ?? null,
    streamStatus: store.streamStatus,
  }),
);
const welcomeLoading = computed(() => describeHomeWelcomeLoading());
const starters = [
  {
    glyph: "↗",
    title: "Build a feature",
    description: "Plan, implement, review, and verify",
    prompt: "Build a complete feature from this goal: ",
  },
  {
    glyph: "⌁",
    title: "Investigate",
    description: "Trace a problem across the repo",
    prompt: "Investigate this problem and propose the most robust fix: ",
  },
  {
    glyph: "✓",
    title: "Ship with confidence",
    description: "Audit, test, and prepare a clean PR",
    prompt: "Review the current work, close every real gap, and prepare it to ship.",
  },
] as const;
const clock = (value: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(value),
  );
const initials = (value: string) =>
  value
    .split(/[\s/_-]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "AI";

function useStarter(prompt: string) {
  store.draft = prompt;
  nextTick(() => document.querySelector<HTMLTextAreaElement>("#home-composer")?.focus());
}

function timelineReference(item: RenderedHomeTimelineItem): HomeQuoteReference | null {
  if (
    !store.activeRootId ||
    !item.anchorKey ||
    !item.conversationId ||
    !item.revisionId ||
    !item.messageRef ||
    !item.publicAuthorId
  )
    return null;
  return {
    root_session_id: store.activeRootId,
    source_key: item.anchorKey,
    conversation_id: item.conversationId,
    revision_id: item.revisionId,
    revision_ordinal: item.revisionOrdinal,
    source_event_ids: item.sourceEventIds,
    target_event_id: item.messageRef.target_event_id,
    target_kind: item.messageRef.target_kind,
    content_digest: item.messageRef.content_digest,
    author_public_id: item.publicAuthorId,
    author: item.title,
    excerpt: item.body,
    at: item.at,
  };
}

function quoteSelected(item: RenderedHomeTimelineItem): boolean {
  const reference = timelineReference(item);
  return reference
    ? store.quoteRefs.some((selected) => sameHomeQuoteRef(selected, reference))
    : false;
}

function toggleQuote(item: RenderedHomeTimelineItem): void {
  const reference = timelineReference(item);
  if (reference) store.toggleQuoteReference(reference);
  else store.reportUnavailableInteraction("quote", item.diagnosticCode);
}

function toggleReaction(item: RenderedHomeTimelineItem, emoji: HomeReactionSummary["emoji"]): void {
  const reference = timelineReference(item);
  if (reference) void store.toggleReaction(reference, emoji);
  else store.reportUnavailableInteraction("reaction", item.diagnosticCode);
}

function reactionBusy(item: RenderedHomeTimelineItem): boolean {
  return item.messageRef ? Boolean(store.reactionBusy[item.messageRef.target_event_id]) : false;
}
function showInteractionPending(item: RenderedHomeTimelineItem): boolean {
  return !item.messageRef && (item.kind === "user" || (item.kind === "assistant" && item.complete));
}
const interactionHint = (item: RenderedHomeTimelineItem) =>
  item.diagnosticCode
    ? `Public quote and reaction authority is unavailable: ${item.diagnosticCode}.`
    : "Public quote and reaction authority appears after the immutable locator is folded.";

function jumpToQuoteTarget(targetEventId: string): void {
  const element = document.getElementById(homeTimelineMessageDomId(targetEventId));
  if (!(element instanceof HTMLElement)) return;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.focus({ preventScroll: true });
}

function jumpToAnchor(anchorKey: string): void {
  const element = document.getElementById(homeTimelineMessageDomId(anchorKey));
  if (!(element instanceof HTMLElement)) return;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.focus({ preventScroll: true });
  followLatest.value = false; // let the user stay where they jumped
  showJump.value = true;
}

const quoteAuthor = (target: HomeQuoteProjection) => {
  if (target.author_public_id === "human") return "You";
  const visibleSource = props.items.find((item) =>
    item.sourceEventIds.includes(target.target_event_id),
  );
  if (visibleSource) return visibleSource.title;
  const participant = store.activeRevision?.participants.find(
    (candidate) => candidate.participant_id === target.author_public_id,
  );
  return homeParticipantDisplayLabel({
    participantId: target.author_public_id,
    roleRef: participant?.role_ref,
    engine: participant?.engine,
  });
};

function trackScroll() {
  const element = scroller.value;
  if (!element) return;
  followLatest.value = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  showJump.value = !followLatest.value;
}

function scrollLatest() {
  endMarker.value?.scrollIntoView({ block: "end", behavior: "smooth" });
  followLatest.value = true;
  showJump.value = false;
}

watch(
  () => [store.activeRootId, props.items.length, store.pendingActions.length],
  async ([root], previous) => {
    await nextTick();
    if (root !== previous?.[0] || followLatest.value)
      endMarker.value?.scrollIntoView({ block: "end" });
  },
);
</script>
