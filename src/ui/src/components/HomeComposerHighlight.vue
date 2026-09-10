<script setup lang="ts">
import { computed } from "vue";
import type { HomeParticipant } from "../conversation-home-types.js";
import { parseComposerHighlight } from "../home-composer-highlight.js";
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
const chipColorClass = (kind: string) => kind.replace("chip-", "");
</script>

<template>
  <div class="home-composer__highlight" aria-hidden="true">
    <template v-for="(segment, index) in segments" :key="index">
      <span v-if="segment.kind === 'text'">{{ segment.text }}</span>
      <span
        v-else
        :class="`home-composer-chip home-composer-chip--${chipColorClass(segment.kind)}`"
        >{{ segment.text }}</span
      >
    </template>
  </div>
</template>