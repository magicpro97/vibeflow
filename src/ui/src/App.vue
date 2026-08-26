<template>
  <div class="home-app">
    <a class="home-skip-link" href="#conversation-main">Skip to conversation</a>
    <TopBar @open-capabilities="openCapabilities" @open-settings="openSettings" />
    <ConversationHome
      :transient-ui-open="capabilitiesOpen || settingsOpen || traceOpen"
      @open-capabilities="openCapabilities"
      @open-trace="openTrace"
    />
    <HomeCapabilityDrawer :open="capabilitiesOpen" @close="closeCapabilities" />
    <HomePreferencesDrawer :open="settingsOpen" @close="closeSettings" />
    <HomeTraceDrawer :open="traceOpen" @close="closeTrace" />
    <div class="sr-only" role="status" aria-live="polite">{{ announcement }}</div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ConversationHome from "./components/ConversationHome.vue";
import HomeCapabilityDrawer from "./components/HomeCapabilityDrawer.vue";
import HomePreferencesDrawer from "./components/HomePreferencesDrawer.vue";
import HomeTraceDrawer from "./components/HomeTraceDrawer.vue";
import TopBar from "./components/TopBar.vue";
import { useConversationHomeStore } from "./conversation-home-store.js";
import "./home.css";

const store = useConversationHomeStore();
const capabilitiesOpen = ref(false);
const settingsOpen = ref(false);
const traceOpen = ref(false);
const announcement = ref("");

watch(
  () => store.activeRevision?.topic,
  (topic) => {
    document.title = topic ? `${topic.slice(0, 52)} · VibeFlow` : "VibeFlow · AI workspace";
    if (topic) announcement.value = `Opened conversation: ${topic}`;
  },
  { immediate: true },
);

function closeCapabilities() {
  capabilitiesOpen.value = false;
  nextTick(() =>
    document.querySelector<HTMLElement>('[aria-label="Open CLI capabilities"]')?.focus(),
  );
}

function openCapabilities() {
  settingsOpen.value = false;
  traceOpen.value = false;
  capabilitiesOpen.value = true;
}

function closeSettings() {
  settingsOpen.value = false;
  nextTick(() => document.querySelector<HTMLElement>('[aria-label="Open settings"]')?.focus());
}

function openSettings() {
  capabilitiesOpen.value = false;
  traceOpen.value = false;
  settingsOpen.value = true;
}

function openTrace() {
  capabilitiesOpen.value = false;
  settingsOpen.value = false;
  traceOpen.value = true;
}

function closeTrace() {
  traceOpen.value = false;
  nextTick(() =>
    document
      .querySelector<HTMLElement>(
        '[aria-label="Open trace and evidence"], .home-header-actions > button',
      )
      ?.focus(),
  );
}

function closeActiveDrawer(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (capabilitiesOpen.value) closeCapabilities();
  else if (settingsOpen.value) closeSettings();
  else if (traceOpen.value) closeTrace();
}

onMounted(() => window.addEventListener("keydown", closeActiveDrawer));
onBeforeUnmount(() => window.removeEventListener("keydown", closeActiveDrawer));
</script>
