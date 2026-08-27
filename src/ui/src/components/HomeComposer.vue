<template>
  <div class="home-composer-wrap">
    <div v-if="!store.online" class="home-offline-note" role="status">
      You’re offline. This draft stays in memory and will not send itself when the connection returns.
    </div>
    <HomeQueuedMessages :editing-available="queueEditAvailable" @edit-requested="focusQueuedEdit" />
    <HomeQuoteSelectionList v-if="!store.queuedMessageEdit" :chips="quoteChips" />
    <HomePrivateRangeSummary @change="openPrivateRangePanel(true)" />
    <form class="home-composer" aria-label="Message VibeFlow" @submit.prevent="submit">
      <HomeQueueEditStatus
        :queue-sequence="store.queuedMessageEdit?.queue_sequence ?? null"
        :saving="store.queuedMessageEditSaving"
        :send-as-new="store.queueSendAsNew"
        @cancel="cancelQueuedEdit"
      />
      <label id="home-composer-label" class="home-composer__label" for="home-composer">Message</label>
      <div
        class="home-composer__field"
        role="combobox"
        aria-label="Message"
        aria-haspopup="listbox"
        :aria-activedescendant="activeSuggestionId"
        :aria-controls="visibleSuggestions.length ? suggestionListId : undefined"
        :aria-expanded="visibleSuggestions.length ? 'true' : 'false'"
        aria-labelledby="home-composer-label"
        :aria-owns="visibleSuggestions.length ? suggestionListId : undefined"
        tabindex="-1"
      >
        <textarea
          id="home-composer"
          ref="textarea"
          v-model="store.draft"
          rows="1"
          :placeholder="placeholder"
          :aria-activedescendant="activeSuggestionId"
          aria-autocomplete="list"
          :aria-controls="visibleSuggestions.length ? suggestionListId : undefined"
          :aria-describedby="composerDescription"
          @compositionstart="composing = true"
          @compositionend="composing = false"
          @beforeinput="onBeforeInput"
          @input="resize"
          @keydown="onKeydown"
          @keyup="onKeyup"
        />
      </div>
      <div v-if="visibleSuggestions.length" :id="suggestionListId" class="home-suggestions" role="listbox" aria-label="Composer suggestions">
        <button
          v-for="(suggestion, index) in visibleSuggestions"
          :id="suggestionOptionId(index)"
          :key="suggestion.value"
          type="button"
          role="option"
          :aria-selected="index === activeSuggestion"
          :class="{ 'home-suggestion--active': index === activeSuggestion }"
          @click="choose(suggestion.value)"
          @mousedown.prevent="choose(suggestion.value)"
        >
          <span class="home-suggestion__glyph" aria-hidden="true">{{ suggestion.glyph }}</span>
          <span><strong>{{ suggestion.label }}</strong><small>{{ suggestion.description }}</small></span>
          <kbd>{{ suggestion.value }}</kbd>
        </button>
      </div>
      <HomeCapabilityTargetChooser
        v-if="store.capabilityTargetRequest?.selection_mode === 'explicit'"
        @confirming="restoreComposerFocusAfterConfirmation"
        @dismissed="restoreComposerFocus"
      />
      <div class="home-composer__toolbar">
        <div class="home-composer__tools" aria-label="Conversation shortcuts">
          <button type="button" title="Add an AI participant" :disabled="Boolean(store.queuedMessageEdit)" @click="insert('+')">
            <span aria-hidden="true">+</span> Agent
          </button>
          <button type="button" title="Remove an AI participant" :disabled="Boolean(store.queuedMessageEdit)" @click="insert('-@')">
            <span aria-hidden="true">−</span> Remove
          </button>
          <button type="button" title="Message one participant" :disabled="Boolean(store.queuedMessageEdit)" @click="insert('@')">
            <span aria-hidden="true">@</span> Mention
          </button>
          <button
            type="button"
            :disabled="Boolean(store.queuedMessageEdit)"
            :aria-expanded="privateRangeOpen"
            aria-controls="home-private-range-panel"
            :title="store.privateContextPresent ? 'Replace the private file range' : 'Attach an exact private file range'"
            @click="openPrivateRangePanel()"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12v12H4zM7 2v4M13 2v4M7 14h6" /></svg>
            {{ store.privateContextPresent ? "Replace range" : "Private range" }}
          </button>
          <button type="button" title="Find a capability" :disabled="Boolean(store.queuedMessageEdit)" @click="$emit('open-capabilities')">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3h8v4h3v7h-3v3H6v-3H3V7h3V3Z" /></svg>
            Capabilities
          </button>
        </div>
        <button
          class="home-send"
          :class="{
            'home-send--labeled': store.queueSendAsNew || composerBusy.blocksSubmit,
            'home-send--busy': composerBusy.blocksSubmit,
          }"
          type="submit"
          :disabled="!store.draft.trim() || composerBusy.blocksSubmit || !store.online"
          :aria-label="sendLabel"
          :aria-busy="composerBusy.blocksSubmit ? 'true' : 'false'"
        >
          <template v-if="composerBusy.blocksSubmit">
            <span class="home-send__label">{{ composerBusy.label }}</span>
            <span class="home-send__busy" aria-hidden="true"><i /><i /><i /></span>
          </template>
          <template v-else>
            <span v-if="store.queueSendAsNew" class="home-send__label">Send as new</span>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 12-6-4 12-2-5-6-1Z" /></svg>
          </template>
        </button>
      </div>
      <HomePrivateRangePanel
        ref="privateRangePanel"
        @open-change="privateRangeOpen = $event"
      />
    </form>
    <div class="home-composer__below">
      <span id="composer-help">Enter to send · Shift+Enter for a new line · ArrowUp edits your latest queued message</span>
      <span
        v-if="composerBusy.active"
        id="composer-status"
        class="home-composer__status"
        role="status"
        aria-live="polite"
      >{{ composerBusy.detail }}</span>
      <span id="composer-error" class="home-composer__error" role="alert">{{ store.composerError }}</span>
    </div>
    <div id="home-queue-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ store.queueAnnouncement }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { CONVERSATION_LIFECYCLE } from "../../../orchestrator/conversation/conversation-public-wire-contract.js";
import { useHomeComposerQuotes } from "../composables/useHomeComposerQuotes.js";
import { describeHomeComposerBusy } from "../conversation-home-loading.js";
import { HOME_QUEUED_MESSAGE_PROJECTION_KIND } from "../conversation-home-message-queue-types.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import { matchHomeComposerSuggestions } from "../home-composer-suggestions.js";
import HomeCapabilityTargetChooser from "./HomeCapabilityTargetChooser.vue";
import HomePrivateRangePanel from "./HomePrivateRangePanel.vue";
import HomePrivateRangeSummary from "./HomePrivateRangeSummary.vue";
import HomeQueueEditStatus from "./HomeQueueEditStatus.vue";
import HomeQueuedMessages from "./HomeQueuedMessages.vue";
import HomeQuoteSelectionList from "./HomeQuoteSelectionList.vue";

const props = withDefaults(defineProps<{ transientUiOpen?: boolean }>(), {
  transientUiOpen: false,
});
defineEmits<{ "open-capabilities": [] }>();
const store = useConversationHomeStore();
const { quoteChips } = useHomeComposerQuotes();
const textarea = ref<HTMLTextAreaElement | null>(null);
const composing = ref(false);
const activeSuggestion = ref(0);
const suggestionsDismissed = ref(false);
const pendingEscapeDraft = ref<string | null>(null);
const suggestionDraftSnapshot = ref("");
const suggestionListId = "composer-suggestions";
const privateRangeOpen = ref(false);
const privateRangePanel = ref<{ open(reset?: boolean): void } | null>(null);
const openPrivateRangePanel = (reset = false) => privateRangePanel.value?.open(reset);

const placeholder = computed(() =>
  store.activeRevision?.lifecycle === CONVERSATION_LIFECYCLE.NEEDS_INPUT
    ? "Reply with the missing detail to continue…"
    : store.activeSession
      ? "Ask, steer, add an agent, or extend the CLI…"
      : "What do you want the AI team to build?",
);
const suggestions = computed(() =>
  matchHomeComposerSuggestions(store.draft, store.activeRevision?.participants ?? []),
);
const visibleSuggestions = computed(() =>
  store.queuedMessageEdit || suggestionsDismissed.value ? [] : suggestions.value,
);
const queueEditAvailable = computed(
  () =>
    store.draft === "" &&
    quoteChips.value.length === 0 &&
    !store.privateContextPresent &&
    !privateRangeOpen.value &&
    store.capabilityTargetRequest?.selection_mode !== "explicit" &&
    !props.transientUiOpen &&
    visibleSuggestions.value.length === 0,
);
const composerDescription = computed(() =>
  store.queuedMessageEdit
    ? "composer-help queue-edit-help composer-error home-queue-status"
    : store.queueSendAsNew
      ? "composer-help queue-send-as-new-help composer-error home-queue-status"
      : composerBusy.value.active
        ? "composer-help composer-status composer-error home-queue-status"
        : "composer-help composer-error home-queue-status",
);
const sendLabel = computed(() => {
  if (store.queuedMessageEditSaving) return "Saving queued message";
  if (store.queuedMessageEdit) return "Save queued message";
  if (store.queueSendAsNew) return "Send preserved draft as a new queued message";
  if (store.submitting) return "Preparing action";
  return "Send message";
});
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
const suggestionSignature = computed(() =>
  suggestions.value.map((suggestion) => suggestion.value).join("\0"),
);
const activeSuggestionId = computed(() =>
  visibleSuggestions.value.length ? suggestionOptionId(activeSuggestion.value) : undefined,
);

watch(suggestionSignature, () => {
  suggestionsDismissed.value = false;
  activeSuggestion.value = 0;
});

watch(
  [() => store.draft, suggestions],
  ([draft, availableSuggestions]) => {
    if (availableSuggestions.length) suggestionDraftSnapshot.value = draft;
  },
  { immediate: true },
);
watch(
  () => store.queueComposerFocusEpoch,
  () => void restoreComposerFocus(),
);

function resize() {
  const element = textarea.value;
  if (!element) return;
  element.style.height = "0";
  element.style.height = `${Math.min(element.scrollHeight, 176)}px`;
}

function insert(value: string) {
  if (store.queuedMessageEdit) return;
  const element = textarea.value;
  const start = element?.selectionStart ?? store.draft.length;
  const end = element?.selectionEnd ?? start;
  const before = store.draft.slice(0, start);
  const after = store.draft.slice(end);
  const leading = before && !/\s$/u.test(before) ? " " : "";
  const trailing = after && !/^\s/u.test(after) ? " " : "";
  store.draft = `${before}${leading}${value}${trailing}${after}`;
  const caret = before.length + leading.length + value.length + trailing.length;
  nextTick(() => {
    textarea.value?.focus();
    textarea.value?.setSelectionRange(caret, caret);
    resize();
  });
}

async function restoreComposerFocus() {
  await nextTick();
  textarea.value?.focus();
}

async function restoreComposerFocusAfterConfirmation(completion: Promise<boolean>) {
  if (await completion) await restoreComposerFocus();
}

async function focusQueuedEdit() {
  await restoreComposerFocus();
  const end = store.draft.length;
  textarea.value?.setSelectionRange(end, end);
  resize();
}

async function cancelQueuedEdit() {
  if (!store.cancelQueuedMessageEdit()) return;
  await restoreComposerFocus();
  resize();
}

function choose(value: string) {
  store.draft = value;
  nextTick(() => {
    textarea.value?.focus();
    textarea.value?.setSelectionRange(value.length, value.length);
    resize();
  });
}
const suggestionOptionId = (index: number) => `composer-suggestion-${index}`;

function onKeydown(event: KeyboardEvent) {
  if (composing.value || event.isComposing || event.keyCode === 229) return;
  if (visibleSuggestions.value.length) {
    if (dismissSuggestionsWithEscape(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      activeSuggestion.value =
        (activeSuggestion.value + delta + visibleSuggestions.value.length) %
        visibleSuggestions.value.length;
      return;
    }
    if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
      event.preventDefault();
      const suggestion = visibleSuggestions.value[activeSuggestion.value];
      if (suggestion) choose(suggestion.value);
      return;
    }
  }
  if (event.key === "Escape" && store.queuedMessageEdit) {
    event.preventDefault();
    event.stopPropagation();
    void cancelQueuedEdit();
    return;
  }
  if (event.key === "ArrowUp" && queueEditAvailable.value) {
    if (store.beginQueuedMessageEdit()) {
      event.preventDefault();
      void focusQueuedEdit();
    }
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
}

function dismissSuggestionsWithEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || !visibleSuggestions.value.length) return false;
  const preservedDraft = suggestionDraftSnapshot.value.length
    ? suggestionDraftSnapshot.value
    : store.draft;
  pendingEscapeDraft.value = preservedDraft;
  suggestionsDismissed.value = true;
  restorePreservedDraft(preservedDraft);
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function restorePreservedDraft(preservedDraft: string) {
  if (store.draft !== preservedDraft) store.draft = preservedDraft;
  const element = textarea.value;
  if (element && element.value !== preservedDraft) {
    element.value = preservedDraft;
    element.setSelectionRange(preservedDraft.length, preservedDraft.length);
    resize();
  }
}

function restoreDismissedDraft(event: KeyboardEvent) {
  if (event.key !== "Escape" || pendingEscapeDraft.value === null) return;
  restorePreservedDraft(pendingEscapeDraft.value);
  pendingEscapeDraft.value = null;
  event.preventDefault();
  event.stopPropagation();
}

function onKeyup(event: KeyboardEvent) {
  restoreDismissedDraft(event);
}

function onBeforeInput(event: InputEvent) {
  if ((composing.value || event.isComposing) && event.inputType === "insertLineBreak")
    event.preventDefault();
}

async function submit() {
  if (composing.value) return;
  await store.submitDraft();
  await nextTick();
  if (store.capabilityTargetRequest?.selection_mode === "explicit") return;
  textarea.value?.focus();
  resize();
}
</script>
