<template>
  <div class="home-message-tools" :aria-busy="busy">
    <button
      type="button"
      class="home-button"
      :aria-pressed="quoteSelected"
      :disabled="Boolean(store.queuedMessageEdit)"
      @click="$emit('toggle-quote')"
    >{{ quoteSelected ? "Remove quote" : "Quote" }}</button>
    <ul v-if="item.reactions.length" class="home-reaction-counts" aria-label="Reactions">
      <li v-for="reaction in item.reactions" :key="`${item.id}-${reaction.emoji}`">
        <button
          type="button"
          class="home-button home-reaction-pill"
          :aria-pressed="reaction.reacted_by_recipient"
          :disabled="busy || !online"
          :aria-label="reactionAriaLabel(reaction)"
          :title="homeReactionSummaryTitle(reaction)"
          @click="$emit('toggle-reaction', reaction.emoji)"
        >
          <span class="home-reaction-pill__emoji" aria-hidden="true">{{ reaction.emoji }}</span>
          <span class="home-reaction-pill__count">{{ reaction.count }}</span>
        </button>
      </li>
    </ul>
    <details class="home-reaction-picker">
      <summary aria-label="Add reaction">{{ busy ? "…" : "😊+" }}</summary>
      <div
        class="home-reaction-picker__grid"
        role="group"
        :aria-label="`Reactions for ${item.title}`"
      >
        <button
          v-for="option in reactionOptions"
          :key="option.emoji"
          type="button"
          class="home-button"
          :aria-pressed="reactionSelected(option.emoji)"
          :disabled="busy || !online"
          :title="`Add or remove your ${option.label.toLowerCase()} reaction`"
          :aria-label="`${option.label} reaction`"
          @click="$emit('toggle-reaction', option.emoji)"
        >{{ option.emoji }}</button>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { HOME_REACTION_OPTIONS, homeReactionSummaryTitle } from "../conversation-home-authoring.js";
import type { RenderedHomeTimelineItem } from "../conversation-home-projection.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import type { HomeReactionSummary } from "../conversation-home-types.js";

const props = defineProps<{
  item: RenderedHomeTimelineItem;
  busy: boolean;
  online: boolean;
  quoteSelected: boolean;
}>();
const store = useConversationHomeStore();
defineEmits<{
  "toggle-quote": [];
  "toggle-reaction": [emoji: HomeReactionSummary["emoji"]];
}>();

const reactionOptions = HOME_REACTION_OPTIONS;
const reactionSelected = (emoji: HomeReactionSummary["emoji"]) =>
  props.item.reactions.some(
    (reaction) => reaction.emoji === emoji && reaction.reacted_by_recipient,
  );
const reactionAriaLabel = (reaction: HomeReactionSummary): string =>
  `${reaction.label}, ${reaction.count} reaction${reaction.count === 1 ? "" : "s"}${reaction.actor_public_ids.length ? `, from ${reaction.actor_public_ids.join(", ")}` : ""}${reaction.reacted_by_recipient ? ", including you" : ""}`;
</script>
