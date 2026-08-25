<template>
  <div class="home-composer-wrap">
    <div v-if="!store.online" class="home-offline-note" role="status">
      You’re offline. This draft stays in memory and will not send itself when the connection returns.
    </div>
    <HomeQuoteSelectionList :chips="quoteChips" />
    <section v-if="store.privateFileRange" class="home-quote-stack" aria-label="Private file range">
      <article class="home-quote-card" data-status="ready">
        <header>
          <strong>Private file range selected</strong>
          <small>{{ store.privateFileRange.repo_relative_path }} · Lines {{ store.privateFileRange.start_line }}–{{ store.privateFileRange.end_line }}</small>
        </header>
        <p>VibeFlow has staged this excerpt privately for one use. Only the binding stays in browser memory, and nothing is persisted in browser storage or exposed on the public timeline.</p>
        <div class="home-quote-card__actions">
          <button type="button" class="home-button" @click="openPrivateRangePanel(true)">Change</button>
          <button type="button" class="home-button" @click="store.clearPrivateFileRange()">Remove</button>
        </div>
      </article>
    </section>
    <form class="home-composer" aria-label="Message VibeFlow" @submit.prevent="submit">
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
          :disabled="store.submitting"
          :aria-activedescendant="activeSuggestionId"
          aria-autocomplete="list"
          :aria-controls="visibleSuggestions.length ? suggestionListId : undefined"
          aria-describedby="composer-help composer-error"
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
      <div class="home-composer__toolbar">
        <div class="home-composer__tools" aria-label="Conversation shortcuts">
          <button type="button" title="Add an AI participant" @click="insert('+')">
            <span aria-hidden="true">+</span> Agent
          </button>
          <button type="button" title="Message one participant" @click="insert('@')">
            <span aria-hidden="true">@</span> Mention
          </button>
          <button
            type="button"
            :aria-expanded="privateRangeOpen"
            aria-controls="home-private-range-panel"
            :title="store.privateFileRange ? 'Change the private file range' : 'Attach an exact private file range'"
            @click="openPrivateRangePanel()"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12v12H4zM7 2v4M13 2v4M7 14h6" /></svg>
            {{ store.privateFileRange ? "Change range" : "Private range" }}
          </button>
          <button type="button" title="Find a capability" @click="$emit('open-capabilities')">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3h8v4h3v7h-3v3H6v-3H3V7h3V3Z" /></svg>
            Capabilities
          </button>
        </div>
        <button
          class="home-send"
          type="submit"
          :disabled="!store.draft.trim() || store.submitting || !store.online"
          :aria-label="store.submitting ? 'Sending message' : 'Send message'"
        >
          <span v-if="store.submitting" class="home-send__busy" />
          <svg v-else viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 12-6-4 12-2-5-6-1Z" /></svg>
        </button>
      </div>
      <section
        v-if="privateRangeOpen"
        id="home-private-range-panel"
        class="home-private-range-panel"
        aria-labelledby="home-private-range-title"
      >
        <div class="home-private-range-panel__copy">
          <strong id="home-private-range-title">{{ store.privateFileRange ? "Change private file range" : "Attach a private file range" }}</strong>
          <p>Stage an exact repo-relative excerpt into VibeFlow&apos;s private one-shot handoff. Only the binding stays in browser memory, and nothing is persisted in browser storage or exposed on the public timeline.</p>
        </div>
        <div class="home-private-range-grid">
          <label>
            <span>Path</span>
            <input
              ref="privatePathInput"
              v-model="privateRangeDraft.path"
              type="text"
              name="private-range-path"
              autocomplete="off"
              spellcheck="false"
              placeholder="src/server.ts"
            />
          </label>
          <label>
            <span>Start line</span>
            <input
              v-model="privateRangeDraft.startLine"
              type="number"
              min="1"
              step="1"
              inputmode="numeric"
              name="private-range-start"
            />
          </label>
          <label>
            <span>End line</span>
            <input
              v-model="privateRangeDraft.endLine"
              type="number"
              min="1"
              step="1"
              inputmode="numeric"
              name="private-range-end"
            />
          </label>
        </div>
        <div class="home-private-range-panel__actions">
          <button
            type="button"
            class="home-button home-button--primary"
            :disabled="privateRangeBusy"
            @click="stagePrivateRange"
          >{{ privateRangeBusy ? "Selecting…" : "Select range" }}</button>
          <button type="button" class="home-button" :disabled="privateRangeBusy" @click="resetPrivateRangeForm">Reset</button>
          <button type="button" class="home-button" :disabled="privateRangeBusy" @click="closePrivateRangePanel">Close</button>
        </div>
        <p v-if="privateRangeError" class="home-private-range-panel__error" role="alert">
          {{ privateRangeError }}
        </p>
      </section>
    </form>
    <div class="home-composer__below">
      <span id="composer-help">Enter to send · Shift+Enter for a new line</span>
      <span id="composer-error" class="home-composer__error" role="alert">{{ store.composerError }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useHomePrivateRangeComposer } from "../composables/useHomePrivateRangeComposer.js";
import { resolveHomeQuoteStatus } from "../conversation-home-authoring.js";
import { projectHomeTimeline } from "../conversation-home-projection.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import { matchHomeComposerSuggestions } from "../home-composer-suggestions.js";
import HomeQuoteSelectionList from "./HomeQuoteSelectionList.vue";

defineEmits<{ "open-capabilities": [] }>();
const store = useConversationHomeStore();
const textarea = ref<HTMLTextAreaElement | null>(null);
const composing = ref(false);
const activeSuggestion = ref(0);
const suggestionsDismissed = ref(false);
const pendingEscapeDraft = ref<string | null>(null);
const suggestionDraftSnapshot = ref("");
const suggestionListId = "composer-suggestions";
const {
  privatePathInput,
  privateRangeOpen,
  privateRangeBusy,
  privateRangeError,
  privateRangeDraft,
  resetPrivateRangeForm,
  closePrivateRangePanel,
  openPrivateRangePanel,
  stagePrivateRange,
} = useHomePrivateRangeComposer({
  privateFileRange: computed(() => store.privateFileRange),
  setPrivateFileRange: store.setPrivateFileRange,
});

const placeholder = computed(() =>
  store.activeSession
    ? "Ask, steer, add an agent, or extend the CLI…"
    : "What do you want the AI team to build?",
);
const visibleQuoteSources = computed(() => {
  const sources = new Map<
    string,
    {
      source_key: string;
      root_session_id: string | null;
      author: string;
      excerpt: string;
      target_event_id: string | null;
      content_digest: string | null;
    }
  >();
  for (const item of projectHomeTimeline(store.timeline?.items ?? [])) {
    if (!item.anchorKey) continue;
    sources.set(item.anchorKey, {
      source_key: item.anchorKey,
      root_session_id: store.activeRootId,
      author: item.title,
      excerpt: item.body,
      target_event_id: item.messageRef?.target_event_id ?? null,
      content_digest: item.messageRef?.content_digest ?? null,
    });
  }
  return sources;
});
const quoteChips = computed(() =>
  store.quoteRefs.map((reference) => {
    const visible = visibleQuoteSources.value.get(reference.source_key) ?? null;
    const resolved = resolveHomeQuoteStatus(reference, store.activeRootId, visible);
    return {
      reference,
      status: resolved.status,
      message: resolved.message,
      canJump: Boolean(visible),
    };
  }),
);

const suggestions = computed(() =>
  matchHomeComposerSuggestions(store.draft, store.activeRevision?.participants ?? []),
);
const visibleSuggestions = computed(() => (suggestionsDismissed.value ? [] : suggestions.value));
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

function resize() {
  const element = textarea.value;
  if (!element) return;
  element.style.height = "0";
  element.style.height = `${Math.min(element.scrollHeight, 176)}px`;
}

function insert(value: string) {
  store.draft = value;
  nextTick(() => {
    textarea.value?.focus();
    resize();
  });
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
  resize();
}
</script>
