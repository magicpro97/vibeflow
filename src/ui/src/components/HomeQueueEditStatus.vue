<template>
  <div v-if="queueSequence !== null" class="home-queue-edit" role="status">
    <span>
      <strong>Editing queued message {{ queueSequence }}</strong>
      <small id="queue-edit-help">Enter saves this FIFO slot · Escape cancels · targets and context stay unchanged</small>
    </span>
    <button type="button" :disabled="saving" @click="$emit('cancel')">Cancel edit</button>
  </div>
  <div
    v-else-if="sendAsNew"
    id="queue-send-as-new-help"
    class="home-queue-edit home-queue-edit--conflict"
    role="status"
  >
    <span>
      <strong>Queue changed. This is now an unsent draft</strong>
      <small>Review it, then use Send as new. It will never enqueue automatically.</small>
    </span>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  queueSequence: number | null;
  saving: boolean;
  sendAsNew: boolean;
}>();
defineEmits<{ cancel: [] }>();
</script>
