<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { HomeParticipant } from "../conversation-home-types.js";
import { findComposerMentions, parseComposerHighlight } from "../home-composer-highlight.js";
import { AGENT_SUGGESTIONS } from "../home-composer-suggestions.js";

const props = defineProps<{
  draft: string;
  participants: readonly HomeParticipant[];
  caretOffset?: number | null;
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
  let draftOffset = 0;
  return segments.value.map((segment) => {
    if (segment.kind === "text") {
      const rawStart = draftOffset;
      draftOffset += segment.text.length;
      return { ...segment, rawStart };
    }
    const rawToken = mentionTokens.value[mentionIndex++] ?? segment.text;
    const rawStart = props.draft.indexOf(rawToken, draftOffset);
    draftOffset = rawStart + rawToken.length;
    return { ...segment, rawToken, rawStart };
  });
});
const caretMention = computed(() => {
  const caret = props.caretOffset;
  if (caret === null || caret === undefined) return null;
  return (
    renderSegments.value.find((segment) => {
      if (segment.kind === "text") return false;
      const end = segment.rawStart + segment.rawToken.length;
      return caret === end || caret === end + 1;
    }) ?? null
  );
});
const highlight = ref<HTMLElement | null>(null);
const caretLeft = ref<number | null>(null);
function syncChipFlow() {
  for (const chip of highlight.value?.querySelectorAll<HTMLElement>(".home-composer-chip") ?? []) {
    const label = chip.querySelector<HTMLElement>(".home-composer-chip__label");
    if (!label) continue;
    const overflow = label.offsetWidth - chip.offsetWidth;
    chip.style.marginRight = `${overflow}px`;
  }
}
function syncCaret() {
  const mention = caretMention.value;
  const chip = [
    ...(highlight.value?.querySelectorAll<HTMLElement>(".home-composer-chip") ?? []),
  ].find(
    (node) =>
      node.dataset.rawToken === (mention && "rawToken" in mention ? mention.rawToken : undefined),
  );
  caretLeft.value =
    chip?.querySelector<HTMLElement>(".home-composer-chip__label")?.getBoundingClientRect().right ??
    null;
}
async function syncLayout() {
  await nextTick();
  syncChipFlow();
  syncCaret();
}
const chipColorClass = (kind: string) => kind.replace("chip-", "");
const caretVisible = computed(() => caretMention.value !== null && caretLeft.value !== null);
watch([renderSegments, caretMention], syncLayout, { flush: "post" });
onMounted(syncLayout);
</script>

<template>
  <div ref="highlight" class="home-composer__highlight" aria-hidden="true">
    <template v-for="(segment, index) in renderSegments" :key="index">
      <span v-if="segment.kind === 'text'" class="home-composer-highlight__text">{{ segment.text }}</span>
      <span
        v-else
        :class="`home-composer-chip home-composer-chip--${chipColorClass(segment.kind)}`"
        :data-label="segment.text"
        :data-raw-token="segment.rawToken"
        :data-raw-width="segment.rawToken.length"
      ><span class="home-composer-chip__label">{{ segment.text }}</span></span>
    </template>
    <span
      v-if="caretVisible"
      class="home-composer-caret"
      :style="caretLeft === null ? undefined : { left: `${caretLeft - (highlight?.getBoundingClientRect().left ?? 0)}px` }"
    />
  </div>
</template>
