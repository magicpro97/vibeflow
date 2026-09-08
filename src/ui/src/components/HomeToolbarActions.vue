<script setup lang="ts">
import { computed, ref } from "vue";
import type { HomeParticipant } from "../conversation-home-types.js";
import { matchHomeComposerSuggestions } from "../home-composer-suggestions.js";

const props = defineProps<{
  participants: readonly HomeParticipant[];
  disabled: boolean;
}>();

const emit = defineEmits<{ select: [value: string] }>();

const openMenu = ref<"agent" | "mention" | "remove" | null>(null);
const activeOption = ref(0);

const options = computed(() => {
  if (!openMenu.value) return [];
  const prefix = openMenu.value === "agent" ? "+" : openMenu.value === "remove" ? "-@" : "@";
  return matchHomeComposerSuggestions(prefix, props.participants);
});

const menuLabel = computed(() => {
  const labels = {
    agent: "Toolbar agent suggestions",
    mention: "Toolbar mention suggestions",
    remove: "Toolbar remove suggestions",
  };
  return labels[openMenu.value ?? "agent"];
});

function toggle(kind: "agent" | "mention" | "remove") {
  openMenu.value = openMenu.value === kind ? null : kind;
  activeOption.value = 0;
}

function choose(value: string) {
  emit("select", value);
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
    <button
      type="button"
      :disabled="props.disabled"
      :aria-expanded="openMenu === 'mention' ? 'true' : 'false'"
      aria-controls="toolbar-mention-options"
      title="Message one participant"
      @click="toggle('mention')"
    >
      <span aria-hidden="true">@</span> Mention
    </button>
    <div
      v-if="openMenu"
      :id="`toolbar-${openMenu}-options`"
      class="home-toolbar-menu"
      role="listbox"
      :aria-label="menuLabel"
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
  </div>
</template>