<template>
  <Transition name="home-drawer">
    <aside v-if="open" class="home-trace-drawer" aria-label="Trace and evidence">
      <header>
        <span><small>Public durable record</small><strong>Trace &amp; evidence</strong></span>
        <button ref="closeButton" type="button" aria-label="Close trace and evidence" @click="$emit('close')">×</button>
      </header>
      <p class="home-drawer-copy">Correlation, evidence references, and durable actions from the selected public timeline.</p>

      <section v-if="store.timeline" class="home-trace-summary">
        <small>Verified head</small>
        <dl>
          <div><dt>Revision</dt><dd>{{ store.timeline.head.revision_ordinal + 1 }}</dd></div>
          <div><dt>Epoch</dt><dd>{{ store.timeline.head_epoch }}</dd></div>
          <div><dt>Digest</dt><dd :title="store.timeline.head_digest">{{ short(store.timeline.head_digest) }}</dd></div>
          <div><dt>Next cursor</dt><dd>{{ store.timeline.next_cursor ? short(store.timeline.next_cursor) : "Complete" }}</dd></div>
        </dl>
      </section>

      <div
        v-if="store.activationLoading && !store.timeline"
        class="home-loading-panel home-loading-panel--drawer"
        aria-label="Loading trace"
        role="status"
        aria-live="polite"
      >
        <header class="home-loading-panel__header">
          <span>{{ traceLoading.eyebrow }}</span>
          <strong>{{ traceLoading.title }}</strong>
        </header>
        <p class="home-loading-panel__copy">{{ traceLoading.detail }}</p>
        <ul class="home-loading-panel__checkpoints" aria-label="Trace restore progress">
          <li v-for="checkpoint in traceLoading.checkpoints" :key="checkpoint">{{ checkpoint }}</li>
        </ul>
        <div class="home-loading-trace" aria-hidden="true">
          <article v-for="index in 3" :key="index">
            <strong />
            <small />
            <span />
          </article>
        </div>
      </div>
      <div v-else-if="!store.activeSession" class="home-drawer-state">
        <span class="home-drawer-state__glyph" aria-hidden="true">⌁</span><strong>No conversation selected</strong><span>Choose a session to inspect its durable public trace.</span>
      </div>
      <div v-else-if="!entries.length" class="home-drawer-state">
        <span class="home-drawer-state__glyph" aria-hidden="true">·</span><strong>No trace events yet</strong><span>Events and evidence will appear here as the AI CLIs work.</span>
      </div>
      <ol v-else class="home-trace-list">
        <li v-for="entry in entries" :key="entry.id">
          <header><span>#{{ entry.seq }}</span><strong>{{ entry.type }}</strong><time :datetime="entry.at">{{ clock(entry.at) }}</time></header>
          <dl>
            <div><dt>Revision</dt><dd>{{ entry.revisionOrdinal + 1 }}</dd></div>
            <div><dt>Event</dt><dd :title="entry.id">{{ short(entry.id) }}</dd></div>
            <div><dt>Run</dt><dd :title="entry.correlation.runId">{{ short(entry.correlation.runId) }}</dd></div>
            <div><dt>Attempt</dt><dd :title="entry.correlation.attemptId">{{ short(entry.correlation.attemptId) }}</dd></div>
            <div v-if="entry.publicSessionRef"><dt>CLI session</dt><dd :title="entry.publicSessionRef">{{ short(entry.publicSessionRef) }}</dd></div>
          </dl>
          <details v-if="entry.evidence.length"><summary>{{ entry.evidence.length }} evidence reference{{ entry.evidence.length === 1 ? '' : 's' }}</summary><ul><li v-for="reference in entry.evidence" :key="reference">{{ reference }}</li></ul></details>
          <div v-if="entry.operations.length" class="home-trace-operations"><span v-for="operation in entry.operations" :key="operation.proposal_id">{{ operation.domain }} · {{ operation.state }}</span></div>
        </li>
      </ol>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { describeHomeTraceLoading } from "../conversation-home-loading.js";
import { projectHomeTrace } from "../conversation-home-projection.js";
import { useConversationHomeStore } from "../conversation-home-store.js";

const props = defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
const store = useConversationHomeStore();
const closeButton = ref<HTMLButtonElement | null>(null);
const entries = computed(() => projectHomeTrace(store.timeline?.items ?? []));
const traceLoading = computed(() =>
  describeHomeTraceLoading(
    store.activeSession?.active?.topic ?? store.activeSession?.root.topic ?? null,
  ),
);
const short = (value: string) =>
  value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value;
const clock = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));

watch(
  () => props.open,
  async (open) => {
    if (open) {
      await nextTick();
      closeButton.value?.focus();
    }
  },
);
</script>
