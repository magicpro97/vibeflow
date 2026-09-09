<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { HomeParticipant } from "../conversation-home-types.js";
import { chipLabelFor, findComposerMentions } from "../home-composer-highlight.js";
import { AGENT_SUGGESTIONS, matchHomeComposerSuggestions } from "../home-composer-suggestions.js";

const props = defineProps<{
  participants: readonly HomeParticipant[];
  disabled: boolean;
  draft: string;
}>();

const emit = defineEmits<{
  select: [value: string];
  remove: [value: string];
}>();

const openMenu = ref<"agent" | "remove" | null>(null);
const activeOption = ref(0);
const menuAnchor = ref<{ top: number; left: number; width: number } | null>(null);
const anchorButton = ref<HTMLButtonElement | null>(null);

function toggle(kind: "agent" | "remove") {
  openMenu.value = openMenu.value === kind ? null : kind;
  activeOption.value = 0;
  menuAnchor.value = null;
}

watch(openMenu, (menu: "agent" | "remove" | null) => {
  if (!menu || !anchorButton.value) return;
  const rect = anchorButton.value.getBoundingClientRect();
  menuAnchor.value = { top: rect.top, left: rect.left, width: rect.width };
});

const agentChipLabels = computed(
  () => new Map(AGENT_SUGGESTIONS.map((suggestion) => [suggestion.value, suggestion.label])),
);
const participantChipLabels = computed(
  () =>
    new Map(
      props.participants.map((participant) => [participant.participant_id, participant.role_ref]),
    ),
);

const options = computed(() => {
  if (!openMenu.value) return [];
  if (openMenu.value === "remove") {
    const inDraft = findComposerMentions(props.draft);
    if (inDraft.length)
      return inDraft.map((token) => ({
        glyph: "−",
        label: `Remove ${chipLabelFor(token, agentChipLabels.value, participantChipLabels.value)}`,
        description: "Remove this mention from the draft",
        value: token,
      }));
  }
  return matchHomeComposerSuggestions("+", props.participants);
});

const menuLabel = computed(() =>
  openMenu.value === "remove" ? "Toolbar remove suggestions" : "Toolbar agent suggestions",
);

function choose(value: string) {
  if (openMenu.value === "remove") emit("remove", value);
  else emit("select", value);
  openMenu.value = null;
}

function onKeydown(event: KeyboardEvent) {
  if (openMenu.value === null) return;
  if (event.key === "Escape") {
    openMenu.value = null;
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeOption.value = (activeOption.value + 1) % options.value.length;
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    activeOption.value = (activeOption.value - 1 + options.value.length) % options.value.length;
    return;
  }
  if (event.key === "Enter") {
    const option = options.value[activeOption.value];
    if (option) {
      event.preventDefault();
      choose(option.value);
    }
  }
}
</script>

<template>
  <div class="home-composer__tool-actions" @keydown="onKeydown">
    <button
      ref="anchorButton"
      type="button"
      :disabled="props.disabled"
      :aria-expanded="openMenu === 'agent' ? 'true' : 'false'"
      aria-controls="toolbar-agent-options"
      title="Add an AI participant"
      @click="toggle('agent')"
    >
      <span aria-hidden="true">+</span> Agent
    </button>
    <button
      type="button"
      :disabled="props.disabled"
      :aria-expanded="openMenu === 'remove' ? 'true' : 'false'"
      aria-controls="toolbar-remove-options"
      title="Remove an AI participant"
      @click="toggle('remove')"
    >
      <span aria-hidden="true">−</span> Remove
    </button>
    <Teleport to="body">
      <div
        v-if="openMenu && menuAnchor"
        :id="`toolbar-${openMenu}-options`"
        class="home-toolbar-menu"
        role="listbox"
        :aria-label="menuLabel"
        :style="{
          top: menuAnchor.top - 4 + 'px',
          left: menuAnchor.left + 'px',
          minWidth: '17rem',
          transform: 'translateY(-100%)',
          bottom: 'auto',
        }"
      >
      <button
        v-for="(option, index) in options"
        :key="option.value"
        type="button"
        role="option"
        :aria-selected="index === activeOption"
        :class="{ 'home-toolbar-menu__option--active': index === activeOption }"
        @click="choose(option.value)"
        @mouseenter="activeOption = index"
      >
        <span class="home-toolbar-menu__glyph" aria-hidden="true">{{ option.glyph }}</span>
        <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
      </button>
      </div>
    </Teleport>
  </div>
</template>