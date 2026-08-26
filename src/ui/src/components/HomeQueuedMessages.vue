<template>
  <section
    v-if="visibleRows.length"
    class="home-message-queue"
    aria-labelledby="home-message-queue-title"
  >
    <header>
      <span>
        <strong id="home-message-queue-title">Message queue</strong>
        <small>Sent in this order</small>
      </span>
      <span class="home-message-queue__count">{{ liveCount }} waiting</span>
    </header>
    <ol>
      <li
        v-for="row in visibleRows"
        :key="rowKey(row)"
        :data-state="rowState(row)"
        :data-queue-item-id="row.kind === 'authoritative' ? row.item.queue_item_id : undefined"
      >
        <span class="home-message-queue__sequence" aria-hidden="true">
          {{ row.kind === "authoritative" ? row.item.queue_sequence : "·" }}
        </span>
        <span class="home-message-queue__content">
          <strong>{{ rowContent(row) }}</strong>
          <small>
            {{ stateLabel(row) }} · {{ targetLabel(row) }}
            <template v-if="rowQuotes(row).length"> · {{ rowQuotes(row).length }} quote{{ rowQuotes(row).length === 1 ? "" : "s" }}</template>
            <template v-if="rowPrivateContext(row)"> · Private context attached</template>
          </small>
        </span>
        <button
          v-if="canEdit(row)"
          type="button"
          class="home-message-queue__edit"
          :aria-label="`Edit queued message ${row.item.queue_sequence}`"
          @click="edit(row.item.queue_item_id)"
        >
          Edit
        </button>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { CONVERSATION_MESSAGE_QUEUE_STATE } from "../../../orchestrator/conversation/conversation-message-queue-contract.js";
import type {
  HomeMessageQueueState,
  HomeQueuedMessageProjection,
} from "../conversation-home-message-queue-types.js";
import { useConversationHomeStore } from "../conversation-home-store.js";

const props = withDefaults(defineProps<{ editingAvailable?: boolean }>(), {
  editingAvailable: true,
});
const emit = defineEmits<{ "edit-requested": [] }>();
const store = useConversationHomeStore();
const visibleRows = computed(() =>
  store.queuedMessages.filter(
    (row) =>
      row.kind === "optimistic" || row.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED,
  ),
);
const liveCount = computed(
  () =>
    store.queuedMessages.filter(
      (row) =>
        row.kind === "optimistic" ||
        row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
        row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
    ).length,
);
const latestEditableId = computed(() => {
  const queued = store.messageQueue?.items.filter(
    (item) =>
      item.author_public_id === "human" && item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED,
  );
  return queued?.at(-1)?.queue_item_id ?? null;
});

const rowKey = (row: HomeQueuedMessageProjection) =>
  row.kind === "authoritative" ? row.item.queue_item_id : row.projection_key;
const rowState = (row: HomeQueuedMessageProjection) =>
  row.kind === "authoritative" ? row.item.state : "admitting";
const rowContent = (row: HomeQueuedMessageProjection) =>
  row.kind === "authoritative" ? row.item.content : row.content;
const rowQuotes = (row: HomeQueuedMessageProjection) =>
  row.kind === "authoritative" ? row.item.quote_refs : row.quote_refs;
const rowPrivateContext = (row: HomeQueuedMessageProjection) =>
  row.kind === "authoritative" ? row.item.private_context_present : row.private_context_present;
const stateLabel = (row: HomeQueuedMessageProjection) => {
  if (row.kind === "optimistic") return "Confirming admission";
  const labels = {
    [CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED]: "Queued",
    [CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED]: "Sending now",
    [CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED]: "Delivered",
    [CONVERSATION_MESSAGE_QUEUE_STATE.STALE]: "Needs attention",
  } satisfies Record<HomeMessageQueueState, string>;
  return labels[row.item.state];
};
const targetLabel = (row: HomeQueuedMessageProjection) => {
  const targets =
    row.kind === "authoritative" ? row.item.target_participants : row.target_participants;
  if (targets === "all") return "All agents";
  return `${targets.length} agent${targets.length === 1 ? "" : "s"}`;
};
const canEdit = (
  row: HomeQueuedMessageProjection,
): row is Extract<HomeQueuedMessageProjection, { kind: "authoritative" }> =>
  row.kind === "authoritative" &&
  row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED &&
  row.item.queue_item_id === latestEditableId.value &&
  !store.queuedMessageEdit &&
  props.editingAvailable;

function edit(queueItemId: string) {
  if (!store.beginQueuedMessageEdit(queueItemId)) return;
  emit("edit-requested");
}
</script>
