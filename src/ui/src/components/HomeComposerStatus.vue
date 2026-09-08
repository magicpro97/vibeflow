<script setup lang="ts">
import { computed } from "vue";
import { describeHomeComposerBusy } from "../conversation-home-loading.js";
import { HOME_QUEUED_MESSAGE_PROJECTION_KIND } from "../conversation-home-message-queue-types.js";
import { useConversationHomeStore } from "../conversation-home-store.js";

const store = useConversationHomeStore();
const composerBusy = computed(() =>
  describeHomeComposerBusy({
    hasActiveSession: Boolean(store.activeSession),
    submitting: store.submitting,
    savingQueuedEdit: store.queuedMessageEditSaving,
    queueAdmissionPending: store.queuedMessages.some(
      (message) => message.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.OPTIMISTIC,
    ),
    lifecycle: store.activeRevision?.lifecycle ?? null,
  }),
);
</script>

<template>
  <div class="home-composer__below">
    <span id="composer-help">Enter to send · Shift+Enter for a new line · ArrowUp edits your latest queued message</span>
    <span
      v-if="composerBusy.active"
      id="composer-status"
      class="home-composer__status"
      role="status"
      aria-live="polite"
      >{{ composerBusy.detail }}</span
    >
    <span id="composer-error" class="home-composer__error" role="alert">{{ store.composerError }}</span>
  </div>
  <div id="home-queue-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true">
    {{ store.queueAnnouncement }}
  </div>
</template>