<script setup lang="ts">
import { computed } from "vue";
import type { HomeParticipant } from "../conversation-home-types.js";
import { findComposerMentions, parseComposerHighlight } from "../home-composer-highlight.js";
import { AGENT_SUGGESTIONS } from "../home-composer-suggestions.js";

const props = defineProps<{
  draft: string;
  participants: readonly HomeParticipant[];
}>();

const agentChipLabels = computed(
  () => new Map(AGENT_SUGGESTIONS.map((suggestion) => [suggestion.value, suggestion.label])),
);
const participantChipLabels = computed(
  () =>
    new Map(
      props.participants.map((participant) => [participant.participant_id, participant.role_ref]),
    ),
);
const segments = computed(() =>
  parseComposerHighlight(props.draft, agentChipLabels.value, participantChipLabels.value),
);
const mentionTokens = computed(() => findComposerMentions(props.draft));
const renderSegments = computed(() => {
  let mentionIndex = 0;
  return segments.value.map((segment) => {
    if (segment.kind === "text") return segment;
    const rawToken = mentionTokens.value[mentionIndex++] ?? segment.text;
    return { ...segment, rawToken };
  });
});
const chipColorClass = (kind: string) => kind.replace("chip-", "");
</script>

<template>
  <div class="home-composer__highlight" aria-hidden="true">
    <template v-for="(segment, index) in renderSegments" :key="index">
      <span v-if="segment.kind === 'text'">{{ segment.text }}</span>
      <span
        v-else
        :class="`home-composer-chip home-composer-chip--${chipColorClass(segment.kind)}`"
        :data-label="segment.text"
        :data-raw-token="segment.rawToken"
      >{{ segment.text }}</span>
    </template>
  </div>
</template>
