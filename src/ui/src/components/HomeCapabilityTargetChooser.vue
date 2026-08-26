<template>
  <section
    v-if="request"
    class="home-capability-targets"
    aria-labelledby="home-capability-target-title"
    aria-describedby="home-capability-target-help"
    @keydown.esc.stop.prevent="dismiss"
  >
    <header class="home-capability-targets__header">
      <div>
        <span>Capability route</span>
        <strong id="home-capability-target-title">Choose the AI tools to extend</strong>
      </div>
      <button
        type="button"
        class="home-capability-targets__cancel"
        aria-label="Cancel capability target selection"
        :disabled="store.submitting"
        @click="dismiss"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
      </button>
    </header>

    <p id="home-capability-target-help">
      <template v-if="store.submitting">
        {{ capabilityBusy.detail }}
      </template>
      <template v-else-if="request.reselection_required">
        This conversation changed. Re-select every target before review.
      </template>
      <template v-else>
        Select one or more participants. Nothing installs until you review the proposal.
      </template>
    </p>

    <fieldset :disabled="store.submitting || !store.online">
      <legend class="sr-only">AI participants that will receive this capability</legend>
      <div v-if="request.participants.length" class="home-capability-targets__grid">
        <label
          v-for="(participant, index) in request.participants"
          :key="participant.participant_id"
          :data-selected="isSelected(participant.participant_id)"
        >
          <input
            :ref="(element) => captureFirstInput(element, index)"
            type="checkbox"
            :checked="isSelected(participant.participant_id)"
            :value="participant.participant_id"
            @change="store.toggleCapabilityTarget(participant.participant_id)"
          />
          <span class="home-capability-targets__mark" aria-hidden="true">
            {{ participant.engine.slice(0, 1).toUpperCase() }}
          </span>
          <span class="home-capability-targets__identity">
            <strong>{{ participant.role_ref }}</strong>
            <small>
              {{ participant.engine }}<template v-if="participant.model"> · {{ participant.model }}</template>
            </small>
          </span>
        </label>
      </div>
      <p v-else class="home-capability-targets__empty" role="status">
        No eligible AI participant is available on the current conversation head.
      </p>
    </fieldset>

    <footer>
      <button
        type="button"
        class="home-button"
        :aria-pressed="allSelected"
        :disabled="store.submitting || !store.online || !request.participants.length"
        @click="store.toggleAllCapabilityTargets()"
      >
        {{ allSelected ? "Clear all" : "Select all" }}
      </button>
      <span aria-live="polite">
        {{ store.submitting ? capabilityBusy.footerLabel : selectionLabel }}
      </span>
      <button
        type="button"
        class="home-button home-button--primary"
        :disabled="!request.selected_participant_ids.length || store.submitting || !store.online"
        @click="confirm"
      >
        {{ store.submitting ? capabilityBusy.ctaLabel : "Review install" }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { describeHomeCapabilityTargetBusy } from "../conversation-home-loading.js";
import { useConversationHomeStore } from "../conversation-home-store.js";

const emit = defineEmits<{ confirming: [completion: Promise<boolean>]; dismissed: [] }>();
const store = useConversationHomeStore();
const firstInput = ref<HTMLInputElement | null>(null);
const request = computed(() => store.capabilityTargetRequest);
const allSelected = computed(
  () =>
    Boolean(request.value?.participants.length) &&
    request.value?.selected_participant_ids.length === request.value?.participants.length,
);
const capabilityBusy = computed(() => describeHomeCapabilityTargetBusy(store.submitting));
const selectionLabel = computed(() => {
  const count = request.value?.selected_participant_ids.length ?? 0;
  return count === 1 ? "1 participant selected" : `${count} participants selected`;
});
const focusBinding = computed(() => {
  const pending = request.value;
  if (!pending) return "";
  return [
    pending.package_id,
    pending.authority.root_session_id,
    pending.authority.conversation_id,
    pending.authority.revision_id,
    pending.authority.last_seq,
    pending.authority.lock_digest,
  ].join("\0");
});

function isSelected(participantId: string): boolean {
  return request.value?.selected_participant_ids.includes(participantId) ?? false;
}

function captureFirstInput(element: unknown, index: number): void {
  if (index === 0) firstInput.value = element instanceof HTMLInputElement ? element : null;
}

function dismiss(): void {
  if (store.submitting) return;
  store.cancelCapabilityTargetSelection();
  emit("dismissed");
}

function confirm(): void {
  emit("confirming", store.confirmCapabilityTargets());
}

watch(
  focusBinding,
  async (binding) => {
    if (!binding) return;
    await nextTick();
    firstInput.value?.focus();
  },
  { immediate: true },
);
</script>
