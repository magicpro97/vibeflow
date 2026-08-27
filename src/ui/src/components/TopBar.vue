<template>
  <header class="home-topbar">
    <div class="home-topbar__left">
      <button
        class="home-icon-button"
        type="button"
        :aria-label="store.railCollapsed ? 'Open conversation list' : 'Close conversation list'"
        :aria-expanded="!store.railCollapsed"
        @click="store.railCollapsed = !store.railCollapsed"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14M3 10h14M3 15.5h14" /></svg>
      </button>
      <a class="home-brand" href="#conversation-main" aria-label="VibeFlow Home">
        <span aria-hidden="true"><i /><i /></span>
        <strong>VibeFlow</strong>
      </a>
      <span class="home-topbar__divider" aria-hidden="true" />
      <span class="home-topbar__context">
        <small>{{ store.activeSession ? "Conversation" : "AI workspace" }}</small>
        <strong>{{ store.activeRevision?.topic ?? "Home" }}</strong>
      </span>
    </div>

    <div class="home-topbar__right">
      <span v-if="!store.online" class="home-network-pill" role="status"><i />Offline</span>
      <button class="home-topbar-button" type="button" aria-label="Open CLI capabilities" :disabled="Boolean(store.queuedMessageEdit)" @click="$emit('open-capabilities')">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3h8v4h3v7h-3v3H6v-3H3V7h3V3Z" /></svg>
        <span>Capabilities</span>
      </button>
      <button class="home-icon-button" type="button" aria-label="New conversation" title="New conversation" @click="newConversation">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
      </button>
      <button class="home-icon-button" type="button" aria-label="Open settings" title="Settings" @click="$emit('open-settings')">
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" /><path d="M10 2v2m0 12v2M2 10h2m12 0h2M4.35 4.35l1.4 1.4m8.5 8.5 1.4 1.4m0-11.3-1.4 1.4m-8.5 8.5-1.4 1.4" /></svg>
      </button>
      <span class="home-user-mark" title="Local user" aria-label="Local user">L</span>
    </div>
  </header>
</template>

<script setup lang="ts">
import { nextTick } from "vue";
import { useConversationHomeStore } from "../conversation-home-store.js";

defineEmits<{ "open-capabilities": []; "open-settings": [] }>();
const store = useConversationHomeStore();

function newConversation() {
  store.newConversation();
  nextTick(() => document.querySelector<HTMLTextAreaElement>("#home-composer")?.focus());
}
</script>
