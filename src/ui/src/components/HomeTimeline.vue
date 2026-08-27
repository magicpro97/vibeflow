<template>
  <main id="conversation-main" ref="scroller" class="home-timeline" aria-label="Conversation" tabindex="-1" @scroll="trackScroll">
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
      <div
        v-if="store.submitting"
        class="home-loading-panel home-loading-panel--welcome"
        role="status"
        aria-live="polite"
      >
        <header class="home-loading-panel__header">
          <span>{{ welcomeLoading.eyebrow }}</span>
          <strong>{{ welcomeLoading.title }}</strong>
        </header>
        <p class="home-loading-panel__copy">{{ welcomeLoading.detail }}</p>
        <ul class="home-loading-panel__checkpoints" aria-label="Conversation creation progress">
          <li v-for="checkpoint in welcomeLoading.checkpoints" :key="checkpoint">{{ checkpoint }}</li>
        </ul>
      </div>
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
      <div
        v-if="store.activationLoading && !store.timeline"
        class="home-loading-panel home-loading-panel--thread"
        aria-label="Loading conversation"
        role="status"
        aria-live="polite"
      >
        <header class="home-loading-panel__header">
          <span>{{ activationLoading.eyebrow }}</span>
          <strong>{{ activationLoading.title }}</strong>
        </header>
        <p class="home-loading-panel__copy">{{ activationLoading.detail }}</p>
        <ul class="home-loading-panel__checkpoints" aria-label="Conversation restore progress">
          <li v-for="checkpoint in activationLoading.checkpoints" :key="checkpoint">{{ checkpoint }}</li>
        </ul>
        <div class="home-loading-thread" aria-hidden="true">
          <article data-tone="human">
            <span class="home-loading-thread__avatar">Y</span>
            <div class="home-loading-thread__copy">
              <strong />
              <small />
              <span class="home-loading-thread__line" />
              <span class="home-loading-thread__line home-loading-thread__line--short" />
            </div>
          </article>
          <article data-tone="assistant">
            <span class="home-loading-thread__avatar">AI</span>
            <div class="home-loading-thread__copy">
              <strong />
              <small />
              <span class="home-loading-thread__line" />
              <span class="home-loading-thread__line home-loading-thread__line--medium" />
            </div>
          </article>
          <article data-tone="system">
            <span class="home-loading-thread__avatar">+</span>
            <div class="home-loading-thread__copy">
              <strong />
              <small />
              <span class="home-loading-thread__line home-loading-thread__line--medium" />
            </div>
          </article>
        </div>
      </div>
      <div v-else-if="!rendered.length && !store.pendingActions.length" class="home-empty-thread">
        <span aria-hidden="true">✦</span>
        <strong>The room is ready.</strong>
        <p>Send the first message, mention an agent, or add one with <kbd>+</kbd>.</p>
      </div>
      <template v-for="item in rendered" :key="item.id">
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
            <div v-if="item.quoteRefs.length" class="home-message-quotes" aria-label="Persisted quoted sources">
              <article v-for="quote in item.quoteRefs" :key="`${item.id}-${quote.quoteOrder}-${quote.target.target_event_id}`" class="home-message-quote">
                <header>
                  <strong>Quote {{ quote.quoteOrder }}</strong>
                  <small>{{ quoteAuthor(quote.target) }}</small>
                </header>
                <p>{{ quote.target.preview_text }}</p>
                <button type="button" class="home-button" @click="jumpToQuoteTarget(quote.target.target_event_id)">
                  Jump to source
                </button>
              </article>
            </div>
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
              <span v-if="!item.complete" class="home-thinking"><i /><i /><i /><span class="sr-only">Thinking</span></span>
              <time v-if="item.at" :datetime="item.at">{{ clock(item.at) }}</time>
            </header>
            <p>{{ item.body }}</p>
            <div v-if="item.quoteRefs.length" class="home-message-quotes" aria-label="Persisted quoted sources">
              <article v-for="quote in item.quoteRefs" :key="`${item.id}-${quote.quoteOrder}-${quote.target.target_event_id}`" class="home-message-quote">
                <header>
                  <strong>Quote {{ quote.quoteOrder }}</strong>
                  <small>{{ quoteAuthor(quote.target) }}</small>
                </header>
                <p>{{ quote.target.preview_text }}</p>
                <button type="button" class="home-button" @click="jumpToQuoteTarget(quote.target.target_event_id)">
                  Jump to source
                </button>
              </article>
            </div>
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
import { projectHomeTimeline } from "../conversation-home-projection.js";
import type { RenderedHomeTimelineItem } from "../conversation-home-projection.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import type {
  HomeQuoteProjection,
  HomeQuoteReference,
  HomeReactionSummary,
} from "../conversation-home-types.js";
import HomeActionCard from "./HomeActionCard.vue";
import HomeAnchoredOperations from "./HomeAnchoredOperations.vue";
import HomeMessageInteractions from "./HomeMessageInteractions.vue";
const store = useConversationHomeStore();
const scroller = ref<HTMLElement | null>(null);
const endMarker = ref<HTMLElement | null>(null);
const followLatest = ref(true);
const showJump = ref(false);
const rendered = computed(() =>
  projectHomeTimeline(store.timeline?.items ?? [], store.activeRevision?.participants ?? []),
);
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

const quoteAuthor = (target: HomeQuoteProjection) => {
  if (target.author_public_id === "human") return "You";
  const visibleSource = rendered.value.find((item) =>
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
  () => [store.activeRootId, rendered.value.length, store.pendingActions.length],
  async ([root], previous) => {
    await nextTick();
    if (root !== previous?.[0] || followLatest.value)
      endMarker.value?.scrollIntoView({ block: "end" });
  },
);
</script>
