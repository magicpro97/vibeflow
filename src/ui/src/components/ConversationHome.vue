<template>
  <div class="conversation-home">
    <button
      v-if="!store.railCollapsed"
      class="home-mobile-backdrop"
      type="button"
      aria-hidden="true"
      tabindex="-1"
      @click="closeRail"
    />
    <HomeSessionRail />

    <section class="home-conversation-pane">
      <header v-if="store.activeSession" class="home-conversation-header">
        <div>
          <div class="home-header-badges">
            <span
              class="home-header-state"
              :data-health="store.activeRevision?.health"
              :data-lifecycle="store.activeRevision?.lifecycle"
            >
              {{ lifecycleLabel }}
            </span>
            <span
              v-if="streamLabel"
              class="home-header-stream"
              :data-stream="store.streamStatus"
              :title="store.streamError || streamLabel"
            >
              {{ streamLabel }}
            </span>
          </div>
          <h1>{{ store.activeRevision?.topic }}</h1>
        </div>
        <div class="home-header-actions">
          <div class="home-avatar-stack" :aria-label="`${store.activeRevision?.participants.length ?? 0} AI participants`">
            <span v-for="participant in store.activeRevision?.participants.slice(0, 4)" :key="participant.participant_id" :title="`${participant.role_ref} · ${participant.engine}`">
              {{ initials(participant.role_ref) }}
            </span>
          </div>
          <button
            ref="detailsTrigger"
            type="button"
            aria-controls="home-conversation-details"
            :aria-expanded="detailsOpen"
            :disabled="Boolean(store.queuedMessageEdit)"
            @click="toggleDetails"
          >
            Details
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
          </button>
        </div>
      </header>

      <HomeTimeline />
      <HomeComposer
        :transient-ui-open="transientUiOpen || detailsOpen"
        @open-capabilities="$emit('open-capabilities')"
      />
    </section>

    <Transition name="home-inspector">
      <aside
        v-if="detailsOpen && store.activeRevision"
        id="home-conversation-details"
        ref="detailsPanel"
        class="home-inspector"
        aria-label="Conversation details"
        tabindex="-1"
        @keydown.esc.prevent="closeDetails()"
      >
        <header><strong>Conversation details</strong><button ref="detailsCloseButton" type="button" aria-label="Close details" @click="closeDetails()">×</button></header>
        <section>
          <small>Participants</small>
          <ul class="home-participant-list">
            <li v-for="participant in store.activeRevision.participants" :key="participant.participant_id">
              <span>{{ initials(participant.role_ref) }}</span>
              <p><strong>{{ participant.role_ref }}</strong><small>{{ participant.engine }}{{ participant.model ? ` · ${participant.model}` : '' }}</small></p>
              <div class="home-participant-actions">
                <button
                  type="button"
                  :aria-label="`Mention ${participant.role_ref}`"
                  title="Mention in composer"
                  :disabled="Boolean(store.queuedMessageEdit)"
                  @click="mention(participant.participant_id)"
                >@</button>
                <button
                  type="button"
                  :aria-label="`Remove ${participant.role_ref} from conversation`"
                  title="Prepare removal in composer"
                  :disabled="Boolean(store.queuedMessageEdit)"
                  @click="removeAgent(participant.participant_id)"
                >−</button>
              </div>
            </li>
          </ul>
          <button class="home-inspector-add" type="button" :disabled="Boolean(store.queuedMessageEdit)" @click="addAgent">+ Add an AI participant</button>
        </section>
        <section>
          <small>Continuity</small>
          <dl>
            <div><dt>Revision</dt><dd>{{ store.activeRevision.revision_ordinal + 1 }} of {{ store.activeSession?.revision_count }}</dd></div>
            <div><dt>Policy</dt><dd>{{ store.activeRevision.policy }}</dd></div>
            <div><dt>Lineage</dt><dd>{{ store.activeRevision.lineage_status }}</dd></div>
            <div><dt>Health</dt><dd>{{ store.activeRevision.health }}</dd></div>
          </dl>
        </section>
        <section>
          <small>More context</small>
          <button class="home-inspector-link" type="button" aria-label="Open trace and evidence" @click="openSecondary('open-trace')">Trace & evidence <span>→</span></button>
          <button class="home-inspector-link" type="button" :disabled="Boolean(store.queuedMessageEdit)" @click="openSecondary('open-capabilities')">CLI capabilities <span>→</span></button>
        </section>
      </aside>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CONVERSATION_LIFECYCLE } from "../../../orchestrator/conversation/conversation-public-wire-contract.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import { homeConversationLifecycleLabel } from "../conversation-lifecycle-presentation.js";
import HomeComposer from "./HomeComposer.vue";
import HomeSessionRail from "./HomeSessionRail.vue";
import HomeTimeline from "./HomeTimeline.vue";

const emit = defineEmits<{ "open-capabilities": []; "open-trace": [] }>();
defineProps<{ transientUiOpen: boolean }>();
const store = useConversationHomeStore();
const detailsOpen = ref(false);
const detailsTrigger = ref<HTMLButtonElement | null>(null);
const detailsPanel = ref<HTMLElement | null>(null);
const detailsCloseButton = ref<HTMLButtonElement | null>(null);
const restoreDetailsFocus = ref<HTMLElement | null>(null);
const lifecycleLabel = computed(() =>
  homeConversationLifecycleLabel(store.activeRevision?.lifecycle ?? CONVERSATION_LIFECYCLE.ACTIVE),
);
const streamLabel = computed(
  () =>
    ({
      idle: "",
      connecting: "Connecting",
      live: "Live",
      reconnecting: "Reconnecting",
      error: "Needs refresh",
    })[store.streamStatus],
);
const initials = (value: string) =>
  value
    .split(/[\s/_-]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "AI";

function mention(participantId: string) {
  if (store.queuedMessageEdit) return;
  insertComposerShortcut(`@${participantId}`);
  closeDetails(false);
}

function addAgent() {
  if (store.queuedMessageEdit) return;
  insertComposerShortcut("+");
  closeDetails(false);
}

function removeAgent(participantId: string) {
  if (store.queuedMessageEdit) return;
  insertComposerShortcut(`-@${participantId}`);
  closeDetails(false);
}

function insertComposerShortcut(shortcut: string) {
  const composer = document.querySelector<HTMLTextAreaElement>("#home-composer");
  const start = composer?.selectionStart ?? store.draft.length;
  const end = composer?.selectionEnd ?? start;
  const before = store.draft.slice(0, start);
  const after = store.draft.slice(end);
  const leading = before && !/\s$/u.test(before) ? " " : "";
  const trailing = after && !/^\s/u.test(after) ? " " : "";
  store.draft = `${before}${leading}${shortcut}${trailing}${after}`;
  const caret = before.length + leading.length + shortcut.length + trailing.length;
  nextTick(() => {
    composer?.focus();
    composer?.setSelectionRange(caret, caret);
  });
}

function openSecondary(event: "open-capabilities" | "open-trace") {
  if (event === "open-capabilities" && store.queuedMessageEdit) return;
  closeDetails(false);
  nextTick(() => {
    if (event === "open-capabilities") emit("open-capabilities");
    else emit("open-trace");
  });
}

function toggleDetails() {
  if (store.queuedMessageEdit) return;
  if (detailsOpen.value) closeDetails();
  else {
    restoreDetailsFocus.value =
      document.activeElement instanceof HTMLElement ? document.activeElement : detailsTrigger.value;
    detailsOpen.value = true;
  }
}

function closeDetails(restoreFocus = true) {
  const wasOpen = detailsOpen.value;
  const target = restoreDetailsFocus.value;
  detailsOpen.value = false;
  if (!restoreFocus || !wasOpen) return;
  restoreDetailsFocus.value = null;
  nextTick(() => {
    if (target?.isConnected) target.focus();
    else if (detailsTrigger.value?.isConnected) detailsTrigger.value.focus();
    else document.querySelector<HTMLTextAreaElement>("#home-composer")?.focus();
  });
}

function closeRail() {
  store.railCollapsed = true;
  nextTick(() =>
    document
      .querySelector<HTMLButtonElement>('.home-topbar button[aria-label="Open conversation list"]')
      ?.focus(),
  );
}

function onOnline() {
  store.setOnline(true);
}
function onOffline() {
  store.setOnline(false);
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && detailsOpen.value) {
    closeDetails();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    store.railCollapsed = false;
    nextTick(() => document.querySelector<HTMLInputElement>(".home-search input")?.focus());
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    store.newConversation();
    nextTick(() => document.querySelector<HTMLTextAreaElement>("#home-composer")?.focus());
  }
}

watch(detailsOpen, async (open) => {
  if (!open) return;
  await nextTick();
  if (detailsCloseButton.value) detailsCloseButton.value.focus();
  else detailsPanel.value?.focus();
});
watch(
  () => store.queuedMessageEdit,
  (edit) => {
    if (edit) closeDetails(false);
  },
);
watch(
  [() => store.activeRootId, () => store.activeRevision?.revision_id],
  ([rootSessionId, revisionId], [previousRootSessionId, previousRevisionId]) => {
    if (rootSessionId !== previousRootSessionId || revisionId !== previousRevisionId)
      closeDetails();
  },
  { flush: "sync" },
);

onMounted(() => {
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("online", onOnline);
  window.removeEventListener("offline", onOffline);
  window.removeEventListener("keydown", onKeydown);
});
</script>
