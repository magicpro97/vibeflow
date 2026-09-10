<template>
  <div class="home-engine-picker">
    <button
      ref="toggleRef"
      type="button"
      class="home-engine-picker__toggle"
      :class="{ 'home-engine-picker__toggle--open': open }"
      :aria-expanded="open ? 'true' : 'false'"
      aria-haspopup="listbox"
      :aria-label="toggleLabel"
      :title="toggleLabel"
      @click="toggleMenu"
    >
      <span class="home-engine-picker__glyph" aria-hidden="true">
        <svg v-if="selection === HOME_ENGINE_AUTO" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2 12 7l5 1-3.5 3.5L15 17l-5-2.6L5 17l1.5-5.5L3 8l5-1Z" /></svg>
        <svg v-else viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 12-6-4 12-2-5-6-1Z" /></svg>
      </span>
      <span class="home-engine-picker__label">{{ toggleLabel }}</span>
      <span class="home-engine-picker__caret" aria-hidden="true">▾</span>
    </button>

    <Teleport to="body">
      <Transition name="home-engine-pop">
        <div
          v-if="open && menuPos"
          class="home-engine-menu"
          :style="menuStyle"
          role="listbox"
          aria-label="Engine"
        >
        <button
          type="button"
          role="option"
          class="home-engine-menu__row"
          :class="{ 'home-engine-menu__row--active': selection === HOME_ENGINE_AUTO }"
          :aria-selected="selection === HOME_ENGINE_AUTO ? 'true' : 'false'"
          @click="choose(HOME_ENGINE_AUTO)"
        >
          <span class="home-engine-menu__dot home-engine-menu__dot--auto" aria-hidden="true">✦</span>
          <span class="home-engine-menu__copy">
            <strong>{{ HOME_ENGINE_AUTO_LABEL }}</strong>
            <small>Pick the best CLI that is installed and ready</small>
          </span>
        </button>

        <button
          v-for="engine in engineList"
          :key="engine"
          type="button"
          role="option"
          class="home-engine-menu__row"
          :class="{
            'home-engine-menu__row--active': selection === engine,
            'home-engine-menu__row--unavailable': !statusFor(engine)?.available,
          }"
          :aria-selected="selection === engine ? 'true' : 'false'"
          :disabled="!statusFor(engine)?.available"
          :title="statusFor(engine)?.detail"
          @click="choose(engine)"
        >
          <span
            class="home-engine-menu__dot"
            :data-level="statusFor(engine)?.level ?? 'unknown'"
            aria-hidden="true"
          />
          <span class="home-engine-menu__copy">
            <strong>{{ displayLabel(engine) }}</strong>
            <small>{{ statusFor(engine)?.available ? "Ready" : statusFor(engine)?.detail || "Not checked" }}</small>
          </span>
        </button>

        <div class="home-engine-menu__footer">
          <button
            type="button"
            class="home-engine-menu__recheck"
            :disabled="checking"
            @click="load(true)"
          >
            <span class="home-engine-menu__recheck-icon" :class="{ 'home-engine-menu__recheck-icon--spin': checking }" aria-hidden="true">↻</span>
            {{ checking ? "Checking…" : "Re-check" }}
          </button>
          <span v-if="checkedAt" class="home-engine-menu__checked">Checked {{ checkedAtLabel }}</span>
        </div>

        <div v-if="currentEngineNote" class="home-engine-menu__note">{{ currentEngineNote }}</div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { type AGENT_ENGINE, ENGINES } from "../../../core/agent-contract.js";
import {
  HOME_ENGINE_AUTO,
  HOME_ENGINE_AUTO_LABEL,
  useHomeEngines,
} from "../composables/useHomeEngines.js";
import { useConversationHomeStore } from "../conversation-home-store.js";

const store = useConversationHomeStore();
const { selection, statuses, checking, checkedAt, load, statusFor, pick, displayLabel } =
  useHomeEngines();
const open = ref(false);
const toggleRef = ref<HTMLButtonElement | null>(null);
const menuPos = ref<{ bottom: number; right: number } | null>(null);
const engineList = [...ENGINES];

onMounted(() => {
  if (!statuses.value.length) void load(false);
});

function toggleMenu() {
  open.value = !open.value;
  if (!open.value) return;
  const rect = toggleRef.value?.getBoundingClientRect();
  if (!rect) return;
  menuPos.value = {
    bottom: window.innerHeight - rect.top + 8,
    right: window.innerWidth - rect.right,
  };
}

const menuStyle = computed(() =>
  menuPos.value
    ? `position: fixed; bottom: ${menuPos.value.bottom}px; right: ${menuPos.value.right}px; z-index: 80;`
    : "",
);

const currentEngine = computed(() => {
  if (selection.value !== HOME_ENGINE_AUTO) return null;
  return store.activeRevision?.participants?.[0]?.engine ?? null;
});

const toggleLabel = computed(() => {
  const engine = selection.value === HOME_ENGINE_AUTO ? currentEngine.value : selection.value;
  if (engine) return `Engine: ${displayLabel(engine)}`;
  return `Engine: ${HOME_ENGINE_AUTO_LABEL}`;
});

const currentEngineNote = computed(() => {
  const engine = currentEngine.value;
  if (!engine) return null;
  return `Current conversation runs ${displayLabel(engine)}. Picking a CLI applies to new conversations.`;
});

const checkedAtLabel = computed(() => {
  if (!checkedAt.value) return "";
  const date = new Date(checkedAt.value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
});

function choose(selectionToApply: "auto" | (typeof AGENT_ENGINE)[keyof typeof AGENT_ENGINE]) {
  pick(selectionToApply);
  open.value = false;
}
</script>
