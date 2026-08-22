<template>
  <div
    :class="overlayClass"
    tabindex="-1"
    @click.self="closeWorkspace"
    @keydown.esc="closeWorkspace"
    @keydown.tab.capture="trapFocus"
  >
    <div
      ref="dialogEl"
      :class="dialogClass"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chat-workspace-title"
    >
      <header class="border-b border-neutral-800 px-5 py-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p :class="eyebrowClass">Conversation Workspace</p>
            <h1 id="chat-workspace-title" class="mt-1 text-xl font-medium text-neutral-100">
              Create, resume, and steer traced conversations
            </h1>
            <p class="mt-1 text-sm text-neutral-500">
              Tokens stay in memory only. Trace, artifacts, and controls render from public DTOs.
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="btn-secondary text-xs"
              aria-label="Open legacy Ask card"
              @click="legacyAskOpen = true"
            >
              File-range Ask
            </button>
            <button
              type="button"
              class="btn-secondary text-xs"
              aria-label="Close conversation workspace"
              @click="closeWorkspace"
            >
              Close
            </button>
          </div>
        </div>
      </header>

      <div :class="bodyClass">
        <div class="min-h-0 overflow-auto">
          <section :class="cardClass">
            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                :class="[tabButtonClass, tab === 'create' ? activeTabClass : inactiveTabClass]"
                @click="tab = 'create'"
              >
                Create
              </button>
              <button
                type="button"
                :class="[tabButtonClass, tab === 'resume' ? activeTabClass : inactiveTabClass]"
                @click="tab = 'resume'"
              >
                Resume
              </button>
            </div>

            <form v-if="tab === 'create'" class="mt-4 grid gap-3" @submit.prevent="startConversation">
              <label :class="fieldClass">
                Topic
                <textarea
                  v-model="createForm.topic"
                  rows="3"
                  class="input-base resize-y"
                  :placeholder="topicPlaceholder"
                />
              </label>
              <div class="grid gap-3 md:grid-cols-[1fr_10rem]">
                <label :class="fieldClass">
                  Policy
                  <input
                    v-model="createForm.policy"
                    class="input-base"
                    placeholder="direct, debate, plan, review, verify, orchestrate"
                  />
                </label>
                <label :class="fieldClass">
                  Max rounds
                  <input
                    v-model="createForm.maxRounds"
                    class="input-base"
                    inputmode="numeric"
                    placeholder="3"
                  />
                </label>
              </div>
              <label :class="fieldClass">
                Participants
                <textarea
                  v-model="createForm.participants"
                  rows="4"
                  class="input-base resize-y font-mono text-[12px]"
                  :placeholder="participantsPlaceholder"
                />
              </label>
              <div class="flex justify-end">
                <button type="submit" class="btn-primary text-xs" :disabled="pending">
                  {{ pending ? "Starting…" : "Start conversation" }}
                </button>
              </div>
            </form>

            <form
              v-else
              class="mt-4 grid gap-3 md:grid-cols-[1fr_auto]"
              @submit.prevent="resumeConversationFromInput"
            >
              <label :class="fieldClass">
                Conversation id
                <input
                  v-model="resumeConversationId"
                  class="input-base font-mono text-[12px]"
                  placeholder="conversation-123"
                />
              </label>
              <div class="flex items-end">
                <button type="submit" class="btn-primary text-xs" :disabled="pending">
                  {{ pending ? "Loading…" : "Resume conversation" }}
                </button>
              </div>
            </form>

            <p v-if="localError" :class="errorClass">{{ localError }}</p>
            <p v-else-if="workspace.state.streamStatus === 'reconnecting'" :class="reconnectClass">
              Reconnecting with the last confirmed cursor.
            </p>
          </section>

          <section v-if="workspace.state.parentConversationId" :class="parentCardClass">
            <p class="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Revision link</p>
            <p class="mt-1 text-sm text-neutral-200">
              This conversation was created from parent
              <button
                type="button"
                class="ml-1 text-neutral-100 underline decoration-neutral-700 underline-offset-4 hover:decoration-neutral-300"
                @click="resumeConversation(workspace.state.parentConversationId)"
              >
                {{ workspace.state.parentConversationId }}
              </button>
            </p>
          </section>

          <div class="mt-4">
            <ConversationPanel
              :snapshot="workspace.state.snapshot"
              :messages="workspace.messages.value"
              :approvals="workspace.approvals.value"
              :operations="workspace.operations.value"
              :controls="workspace.controls.value"
              :pending="pending"
              :notice="workspace.state.notice"
              :error="localError || workspace.state.streamError"
              @pause="pauseConversation"
              @resume="resumeActiveConversation"
              @stop="stopConversation"
              @show-trace="openTrace"
              @submit-message="submitMessage"
              @resolve-approval="resolveApproval"
              @cancel-operation="cancelOperation"
            />
          </div>
        </div>

        <aside class="min-h-0 space-y-4 overflow-auto">
          <DecisionMatrix
            :matrix="workspace.decisionMatrix.value"
            :baseline="workspace.baseline.value"
          />
          <section :class="cardClass">
            <div class="flex items-center justify-between gap-3">
              <div>
                <p :class="eyebrowClass">Artifacts</p>
                <h2 class="mt-1 text-sm font-medium text-neutral-100">Opaque artifact previews</h2>
              </div>
              <button
                type="button"
                class="btn-ghost"
                aria-label="Open latest trace event"
                :disabled="!workspace.state.traces.length"
                @click="openTrace(workspace.state.traces.at(-1)?.seq ?? 0)"
              >
                Latest trace
              </button>
            </div>
            <div v-if="workspace.artifacts.value.length" class="mt-4 space-y-3">
              <ArtifactCard
                v-for="artifact in workspace.artifacts.value"
                :key="artifact.artifact_id"
                :conversation-id="workspace.state.activeConversationId || ''"
                :artifact="artifact"
                @show-trace="openTrace"
              />
            </div>
            <p
              v-else
              class="mt-4 rounded border border-dashed border-neutral-800 px-3 py-4 text-xs text-neutral-600"
            >
              No artifact events yet. Plans, diffs, tests, synthesis, and transcripts will appear
              here.
            </p>
          </section>
        </aside>
      </div>
    </div>

    <TraceDrawer
      v-if="traceOpen"
      :traces="workspace.state.traces"
      :selected-seq="selectedTraceSeq"
      :sessions="workspace.sessions.value"
      @close="traceOpen = false"
      @update:selected-seq="selectedTraceSeq = $event"
    />
    <AskCard v-if="legacyAskOpen" @close="legacyAskOpen = false" />
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import { useConversationWorkspace } from "../composables/useConversationWorkspace.js";
import type { AskPrefill } from "../lib/ask-prefill.js";
import ArtifactCard from "./ArtifactCard.vue";
import AskCard from "./AskCard.vue";
import ConversationPanel from "./ConversationPanel.vue";
import DecisionMatrix from "./DecisionMatrix.vue";
import TraceDrawer from "./TraceDrawer.vue";

const props = defineProps<{ initialPrefill?: AskPrefill | null }>();
const emit = defineEmits<{ close: [] }>();

const overlayClass = "fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 py-6";
const dialogClass =
  "flex h-[calc(100vh-3rem)] w-full max-w-7xl flex-col overflow-hidden rounded-3xl border border-neutral-800 bg-neutral-950 shadow-2xl";
const bodyClass = "grid min-h-0 flex-1 gap-4 overflow-hidden p-4 xl:grid-cols-[1.65fr_1fr]";
const cardClass = "rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4";
const parentCardClass = "mt-4 rounded-2xl border border-neutral-800 bg-neutral-900/60 px-4 py-3";
const eyebrowClass = "text-[10px] uppercase tracking-[0.24em] text-neutral-500";
const fieldClass = "grid gap-1 text-xs text-neutral-400";
const tabButtonClass = "rounded-full px-3 py-1.5 text-xs transition-colors";
const activeTabClass = "bg-neutral-100 text-neutral-900";
const inactiveTabClass = "bg-neutral-900 text-neutral-400 hover:text-neutral-200";
const errorClass =
  "mt-3 rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300";
const reconnectClass =
  "mt-3 rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200";
const topicPlaceholder = "Compare implementation strategies, plan a change, or start a direct chat";
const participantsPlaceholder = "brainstorm-participant@codex\nbrainstorm-skeptic@claude:gpt-5";
const focusSelector =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

const {
  workspace,
  pending,
  localError,
  resumeConversationId,
  legacyAskOpen,
  traceOpen,
  selectedTraceSeq,
  createForm,
  startConversation,
  resumeConversation,
  resumeConversationFromInput,
  submitMessage,
  pauseConversation,
  resumeActiveConversation,
  stopConversation,
  resolveApproval,
  cancelOperation,
  openTrace,
} = useConversationWorkspace(Boolean(props.initialPrefill));

const dialogEl = ref<HTMLElement | null>(null);
const previousFocus = ref<HTMLElement | null>(null);
const tab = ref<"create" | "resume">("create");

function trapFocus(event: KeyboardEvent) {
  if (event.target instanceof Element && event.target.closest("[data-trace-drawer]")) return;
  const root = dialogEl.value;
  if (!root) return;
  const focusable = Array.from(root.querySelectorAll<HTMLElement>(focusSelector));
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey) {
    if (document.activeElement === first || !root.contains(document.activeElement)) {
      event.preventDefault();
      last.focus();
    }
  } else if (document.activeElement === last || !root.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  }
}

function closeWorkspace() {
  emit("close");
  void nextTick(() => previousFocus.value?.isConnected && previousFocus.value.focus());
}

onMounted(() => {
  previousFocus.value =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialogEl.value?.focus();
});
</script>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  * {
    scroll-behavior: auto;
    transition-duration: 0.01ms !important;
  }
}
</style>
