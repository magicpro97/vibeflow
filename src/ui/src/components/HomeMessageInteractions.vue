<template>
  <div class="home-message-tools" :aria-busy="busy">
    <button
      type="button"
      class="home-button"
      :aria-pressed="quoteSelected"
      @click="$emit('toggle-quote')"
    >{{ quoteSelected ? "Remove quote" : "Quote" }}</button>
    <ul v-if="item.reactions.length" class="home-reaction-counts" aria-label="Reactions">
      <li v-for="reaction in item.reactions" :key="`${item.id}-${reaction.emoji}`">
        <button
          type="button"
          class="home-button"
          :aria-pressed="reaction.reacted_by_recipient"
          :disabled="busy || !online"
          :aria-label="reactionAriaLabel(reaction)"
          :title="homeReactionSummaryTitle(reaction)"
          @click="$emit('toggle-reaction', reaction.emoji)"
        >{{ reaction.emoji }} {{ reaction.label }} · {{ reaction.count }}</button>
      </li>
    </ul>
    <details class="home-reaction-picker">
      <summary>{{ busy ? "Updating reaction…" : "React" }}</summary>
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
          @click="$emit('toggle-reaction', option.emoji)"
        >{{ option.emoji }} {{ option.label }}</button>
      </div>
      <p class="home-reaction-picker__note">Counts update only after the public fold returns.</p>
    </details>
  </div>
</template>

<script setup lang="ts">
import { HOME_REACTION_OPTIONS, homeReactionSummaryTitle } from "../conversation-home-authoring.js";
import type { RenderedHomeTimelineItem } from "../conversation-home-projection.js";
import type { HomeReactionSummary } from "../conversation-home-types.js";

const props = defineProps<{
  item: RenderedHomeTimelineItem;
  busy: boolean;
  online: boolean;
  quoteSelected: boolean;
}>();
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
