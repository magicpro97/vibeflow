<template>
  <div
    data-trace-drawer
    class="fixed inset-0 z-50 flex justify-end bg-black/60"
    tabindex="-1"
    @click.self="$emit('close')"
    @keydown.esc.capture.stop="$emit('close')"
    @keydown.tab.capture.stop="trapFocus"
  >
    <aside
      ref="drawerEl"
      class="flex h-full w-full max-w-3xl flex-col border-l border-neutral-800 bg-neutral-950"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trace-drawer-title"
    >
      <div class="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <div>
          <p class="text-[10px] uppercase tracking-[0.24em] text-neutral-500">Trace Drawer</p>
          <h2 id="trace-drawer-title" class="mt-1 text-sm font-medium text-neutral-100">Public conversation trace</h2>
        </div>
        <button type="button" class="btn-ghost" aria-label="Close trace drawer" @click="$emit('close')">Close</button>
      </div>

      <div class="grid min-h-0 flex-1 gap-px bg-neutral-800 md:grid-cols-[18rem_1fr]">
        <div class="overflow-auto bg-neutral-950">
          <button
            v-for="record in traces"
            :key="record.seq"
            type="button"
            class="block w-full border-b border-neutral-800/60 px-4 py-3 text-left transition-colors"
            :class="record.seq === selectedSeqComputed ? 'bg-neutral-900 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900/70 hover:text-neutral-200'"
            @click="$emit('update:selected-seq', record.seq)"
          >
            <p class="text-[11px] font-medium">#{{ record.seq }} · {{ record.event.type }}</p>
            <p class="mt-1 text-[11px] text-neutral-500">{{ record.ts }}</p>
          </button>
        </div>

        <div class="overflow-auto bg-neutral-950 px-4 py-4">
          <template v-if="selected">
            <div class="grid gap-3 md:grid-cols-2">
              <div class="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
                <p class="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Correlation</p>
                <dl class="mt-2 space-y-1 text-xs text-neutral-300">
                  <div><dt class="inline text-neutral-500">workflow</dt> <dd class="inline">{{ selected.workflow_id }}</dd></div>
                  <div><dt class="inline text-neutral-500">conversation</dt> <dd class="inline">{{ selected.conversation_id }}</dd></div>
                  <div><dt class="inline text-neutral-500">revision</dt> <dd class="inline">{{ selected.revision_id }}</dd></div>
                  <div><dt class="inline text-neutral-500">run</dt> <dd class="inline">{{ selected.run_id }}</dd></div>
                  <div><dt class="inline text-neutral-500">turn</dt> <dd class="inline">{{ selected.turn_id }}</dd></div>
                  <div><dt class="inline text-neutral-500">operation</dt> <dd class="inline">{{ selected.operation_id }}</dd></div>
                  <div><dt class="inline text-neutral-500">attempt</dt> <dd class="inline">{{ selected.attempt_id }}</dd></div>
                  <div v-if="selected.parent_attempt_id"><dt class="inline text-neutral-500">parent attempt</dt> <dd class="inline">{{ selected.parent_attempt_id }}</dd></div>
                </dl>
              </div>

              <div class="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
                <p class="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Context</p>
                <dl class="mt-2 space-y-1 text-xs text-neutral-300">
                  <div><dt class="inline text-neutral-500">role</dt> <dd class="inline">{{ selected.role_ref ?? "n/a" }}</dd></div>
                  <div><dt class="inline text-neutral-500">engine</dt> <dd class="inline">{{ selected.engine ?? "n/a" }}</dd></div>
                  <div><dt class="inline text-neutral-500">session</dt> <dd class="inline">{{ selected.public_session_ref ?? "n/a" }}</dd></div>
                  <div v-if="sessionView"><dt class="inline text-neutral-500">session status</dt> <dd class="inline">{{ sessionView.status }}</dd></div>
                  <div><dt class="inline text-neutral-500">skills</dt> <dd class="inline">{{ selected.skill_refs?.join(", ") || "n/a" }}</dd></div>
                  <div><dt class="inline text-neutral-500">evidence</dt> <dd class="inline">{{ selected.evidence_refs?.join(", ") || "n/a" }}</dd></div>
                </dl>
              </div>
            </div>

            <div v-if="sessionView" class="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
              <p class="text-[10px] uppercase tracking-[0.2em] text-neutral-500">History Reconciliation</p>
              <p class="mt-2 text-xs text-neutral-300">
                {{ sessionView.status }} · turns {{ sessionView.imported_turn_count }} · tools {{ sessionView.imported_tool_count }}
              </p>
              <p class="mt-1 text-xs text-neutral-500">{{ sessionView.completeness_reason }}</p>
            </div>

            <div class="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
              <p class="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Payload</p>
              <pre class="mt-2 overflow-auto whitespace-pre-wrap text-[11px] text-neutral-300">{{ payloadText }}</pre>
            </div>
          </template>
          <p v-else class="text-sm text-neutral-600">No trace event selected.</p>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { TraceSessionView } from "../conversation-store.js";
import type { ConversationTraceRecord } from "../conversation-types.js";

const props = defineProps<{
  traces: ConversationTraceRecord[];
  selectedSeq: number | null;
  sessions: Map<string, TraceSessionView>;
}>();

const emit = defineEmits<{ close: []; "update:selected-seq": [seq: number] }>();
const drawerEl = ref<HTMLElement | null>(null);
const selectedSeqComputed = computed(() => props.selectedSeq ?? props.traces.at(-1)?.seq ?? null);
const selected = computed(
  () => props.traces.find((record) => record.seq === selectedSeqComputed.value) ?? null,
);
const sessionView = computed(() => {
  const refValue = selected.value?.public_session_ref;
  return refValue ? (props.sessions.get(refValue) ?? null) : null;
});
const payloadText = computed(() =>
  selected.value ? JSON.stringify(selected.value.event.payload, null, 2) : "",
);

function trapFocus(event: KeyboardEvent) {
  const root = drawerEl.value;
  if (!root) return;
  const focusable = Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ),
  );
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

function onFocusIn(event: FocusEvent) {
  if (!drawerEl.value) return;
  if (!drawerEl.value.contains(event.target as Node)) {
    event.stopPropagation();
    drawerEl.value.querySelector<HTMLElement>("button, [href], [tabindex]")?.focus();
  }
}

onMounted(() => {
  drawerEl.value?.focus();
  document.addEventListener("focusin", onFocusIn, true);
});

onUnmounted(() => {
  document.removeEventListener("focusin", onFocusIn, true);
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
