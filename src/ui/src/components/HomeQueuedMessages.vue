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
        :data-queue-item-id="
          row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE
            ? row.item.queue_item_id
            : undefined
        "
      >
        <span class="home-message-queue__sequence" aria-hidden="true">
          {{
            row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE
              ? row.item.queue_sequence
              : "·"
          }}
        </span>
        <span class="home-message-queue__content">
          <strong>{{ rowContent(row) }}</strong>
          <small>
            {{ stateLabel(row) }} · {{ targetLabel(row) }}
            <template v-if="rowQuotes(row).length"> · {{ rowQuotes(row).length }} quote{{ rowQuotes(row).length === 1 ? "" : "s" }}</template>
            <template v-if="rowPrivateContext(row)"> · Private context attached</template>
          </small>
          <small v-if="isFailedProjection(row)" class="home-message-queue__failure">
            {{ row.failure_message }}
          </small>
          <small
            v-if="row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION"
            class="home-message-queue__failure"
          >
            Suggested recovery: {{ recoveryActionLabel(row.recovery_action) }}
          </small>
          <small
            v-if="isAuthorityRepair(row)"
            class="home-message-queue__repair-guidance"
          >
            This public error does not expose the affected scope. In a terminal, identify whether it
            is project or user authority, then run <code>vf authority repair --scope project</code>
            or <code>vf authority repair --scope user</code>. This message stays unsent.
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
        <button
          v-else-if="canRetry(row)"
          type="button"
          class="home-message-queue__retry"
          :disabled="!store.online || row.retrying"
          :aria-label="`Retry queued message: ${row.content}`"
          @click="retry(row.projection_key)"
        >
          {{ row.retrying ? "Retrying…" : "Retry" }}
        </button>
        <span
          v-else-if="row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION"
          class="home-message-queue__actions"
          :aria-busy="store.queueRecoveryBusyKey === row.projection_key ? 'true' : 'false'"
        >
          <button
            v-if="hasPrimaryRecovery(row)"
            type="button"
            class="home-message-queue__retry"
            :disabled="primaryRecoveryDisabled(row)"
            :aria-label="`${primaryRecoveryLabel(row.recovery_action)}: ${row.content}`"
            @click="recover(row.projection_key)"
          >
            {{
              isRestoring(row)
                ? row.recovery_action ===
                  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SELECT_ACTIVE_CONVERSATION
                  ? "Refreshing…"
                  : "Restoring…"
                : primaryRecoveryLabel(row.recovery_action)
            }}
          </button>
          <button
            type="button"
            class="home-message-queue__edit"
            :disabled="dismissDisabled(row)"
            :aria-label="`Dismiss failed unsent message: ${row.content}`"
            @click="dismiss(row.projection_key)"
          >
            {{ isDismissing(row) ? "Discarding…" : "Dismiss" }}
          </button>
        </span>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  type ConversationMessageQueueRecoveryActionV1,
} from "../../../orchestrator/conversation/conversation-message-queue-contract.js";
import { isHomeQueuedMessageProjectionWaiting } from "../conversation-home-message-queue-authority.js";
import type {
  HomeMessageQueueState,
  HomeQueuedMessageProjection,
} from "../conversation-home-message-queue-types.js";
import {
  HOME_QUEUED_MESSAGE_PROJECTION_KIND,
  HOME_QUEUE_RECOVERY_BUSY_KIND,
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
      row.kind !== HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE ||
      row.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED,
  ),
);
const liveCount = computed(
  () => store.queuedMessages.filter(isHomeQueuedMessageProjectionWaiting).length,
);
const latestEditableId = computed(() => {
  const queued = store.messageQueue?.items.filter(
    (item) =>
      item.author_public_id === CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN &&
      item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED,
  );
  return queued?.at(-1)?.queue_item_id ?? null;
});

const rowKey = (row: HomeQueuedMessageProjection) =>
  row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE
    ? row.item.queue_item_id
    : row.projection_key;
const rowState = (row: HomeQueuedMessageProjection) =>
  row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE ? row.item.state : row.kind;
const rowContent = (row: HomeQueuedMessageProjection) =>
  row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE ? row.item.content : row.content;
const rowQuotes = (row: HomeQueuedMessageProjection) =>
  row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE
    ? row.item.quote_refs
    : row.quote_refs;
const rowPrivateContext = (row: HomeQueuedMessageProjection) =>
  row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE
    ? row.item.private_context_present
    : row.private_context_present;
const stateLabel = (row: HomeQueuedMessageProjection) => {
  if (row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.OPTIMISTIC) return "Confirming admission";
  if (row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.RETRYABLE) return "Needs retry";
  if (row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION) return "Needs action";
  const labels = {
    [CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED]: "Queued",
    [CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED]: "Sending now",
    [CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED]: "Delivered",
    [CONVERSATION_MESSAGE_QUEUE_STATE.STALE]: "Needs attention",
  } satisfies Record<HomeMessageQueueState, string>;
  return labels[row.item.state];
};
const RECOVERY_ACTION_LABEL = Object.freeze({
  [CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT]: "edit the payload before sending",
  [CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY]: "retry from the Needs retry state",
  [CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SEND_AS_NEW]: "restore as a new unsent draft",
  [CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.REPAIR_AUTHORITY]:
    "repair authority from an interactive CLI",
  [CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SELECT_ACTIVE_CONVERSATION]:
    "refresh the active conversation, then review",
} satisfies Readonly<Record<ConversationMessageQueueRecoveryActionV1, string>>);
const recoveryActionLabel = (action: ConversationMessageQueueRecoveryActionV1 | null) =>
  action === null ? "review the error" : RECOVERY_ACTION_LABEL[action];
const PRIMARY_RECOVERY_LABEL = Object.freeze({
  [CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT]: "Restore to edit",
  [CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SEND_AS_NEW]: "Restore as new draft",
  [CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SELECT_ACTIVE_CONVERSATION]: "Refresh and restore",
} as const);
const isFailedProjection = (
  row: HomeQueuedMessageProjection,
): row is Extract<
  HomeQueuedMessageProjection,
  {
    kind:
      | typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND.RETRYABLE
      | typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION;
  }
> =>
  row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.RETRYABLE ||
  row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION;
const targetLabel = (row: HomeQueuedMessageProjection) => {
  const targets =
    row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE
      ? row.item.target_participants
      : row.target_participants;
  if (targets === CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL) return "All agents";
  return `${targets.length} agent${targets.length === 1 ? "" : "s"}`;
};
const canEdit = (
  row: HomeQueuedMessageProjection,
): row is Extract<
  HomeQueuedMessageProjection,
  { kind: typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE }
> =>
  row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE &&
  row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED &&
  row.item.queue_item_id === latestEditableId.value &&
  !store.queuedMessageEdit &&
  props.editingAvailable;
const canRetry = (
  row: HomeQueuedMessageProjection,
): row is Extract<
  HomeQueuedMessageProjection,
  { kind: typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND.RETRYABLE }
> => row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.RETRYABLE;
const hasPrimaryRecovery = (
  row: HomeQueuedMessageProjection,
): row is Extract<
  HomeQueuedMessageProjection,
  { kind: typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION }
> =>
  row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION &&
  (row.recovery_action === null || Object.hasOwn(PRIMARY_RECOVERY_LABEL, row.recovery_action));
const primaryRecoveryLabel = (action: ConversationMessageQueueRecoveryActionV1 | null): string =>
  action === null
    ? "Restore to review"
    : PRIMARY_RECOVERY_LABEL[action as keyof typeof PRIMARY_RECOVERY_LABEL];
const primaryRecoveryDisabled = (
  row: Extract<
    HomeQueuedMessageProjection,
    { kind: typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION }
  >,
): boolean =>
  !store.queueRecoveryComposerVacant ||
  store.queueRecoveryBusyKey !== null ||
  (row.recovery_action === CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SELECT_ACTIVE_CONVERSATION &&
    !store.online);
const isAuthorityRepair = (
  row: HomeQueuedMessageProjection,
): row is Extract<
  HomeQueuedMessageProjection,
  { kind: typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION }
> =>
  row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION &&
  row.recovery_action === CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.REPAIR_AUTHORITY;
const isRestoring = (row: HomeQueuedMessageProjection): boolean =>
  row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION &&
  store.queueRecoveryBusyKey === row.projection_key &&
  store.queueRecoveryBusyKind === HOME_QUEUE_RECOVERY_BUSY_KIND.RESTORE;
const isDismissing = (row: HomeQueuedMessageProjection): boolean =>
  row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION &&
  store.queueRecoveryBusyKey === row.projection_key &&
  store.queueRecoveryBusyKind === HOME_QUEUE_RECOVERY_BUSY_KIND.DISMISS;
const dismissDisabled = (
  row: Extract<
    HomeQueuedMessageProjection,
    { kind: typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION }
  >,
): boolean => store.queueRecoveryBusyKey !== null || (row.private_context_present && !store.online);

function edit(queueItemId: string) {
  if (!store.beginQueuedMessageEdit(queueItemId)) return;
  emit("edit-requested");
}

function retry(projectionKey: string) {
  void store.retryQueuedMessage(projectionKey);
}

function recover(projectionKey: string) {
  void store.recoverFailedQueuedMessage(projectionKey);
}

function dismiss(projectionKey: string) {
  if (
    !globalThis.confirm(
      "Dismiss this unsent message? Its text, quotes, and private-context attachment will be removed from this queue view.",
    )
  )
    return;
  void store.dismissFailedQueuedMessage(projectionKey);
}
</script>
