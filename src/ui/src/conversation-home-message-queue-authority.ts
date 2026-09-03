import { type ComputedRef, type Ref, type ShallowRef, computed } from "vue";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  type ConversationMessageQueueRecoveryActionV1,
  type ConversationMessageQueueTargetParticipantsV1,
} from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import {
  isConversationMessageQueueSnapshotWireV1,
  isPublicConversationMessageQueueInvalidationWireV1,
  isPublicQueuedUserMessageWireV1,
} from "../../orchestrator/conversation/conversation-message-queue-wire.js";
import { ConversationHomeApiError } from "./conversation-home-api.js";
import type {
  HomeEnqueueMessageRequest,
  HomeMessageQueueInvalidation,
  HomeMessageQueueSnapshot,
  HomeNeedsActionQueuedMessage,
  HomeOptimisticQueuedMessage,
  HomeQueueRecoveryBusyKind,
  HomeQueuedMessage,
  HomeQueuedMessageProjection,
  HomeRetryableQueuedMessage,
} from "./conversation-home-message-queue-types.js";
import {
  HOME_QUEUED_MESSAGE_PROJECTION_KIND,
  HOME_QUEUE_RECOVERY_BUSY_KIND,
} from "./conversation-home-message-queue-types.js";
import { createHomeActionKey } from "./conversation-home-runtime.js";

export function isHomeQueuedMessage(value: unknown): value is HomeQueuedMessage {
  return isPublicQueuedUserMessageWireV1(value);
}

export function assertHomeMessageQueueSnapshot(
  value: unknown,
  rootSessionId: string,
): asserts value is HomeMessageQueueSnapshot {
  if (!isConversationMessageQueueSnapshotWireV1(value, rootSessionId))
    throw new Error("The message queue projection did not match this session.");
  let priorSequence = 0;
  const ids = new Set<string>();
  for (const item of value.items as HomeQueuedMessage[]) {
    if (item.queue_sequence <= priorSequence || ids.has(item.queue_item_id))
      throw new Error("The message queue projection was not canonical.");
    priorSequence = item.queue_sequence;
    ids.add(item.queue_item_id);
  }
}

export function assertHomeQueueInvalidation(
  value: unknown,
  rootSessionId: string,
): asserts value is HomeMessageQueueInvalidation {
  if (!isPublicConversationMessageQueueInvalidationWireV1(value, rootSessionId))
    throw new Error("The message queue update did not match this session.");
}

export function mergeHomeQueuedMessage(
  snapshot: HomeMessageQueueSnapshot,
  item: unknown,
): HomeMessageQueueSnapshot {
  if (!isHomeQueuedMessage(item) || item.root_session_id !== snapshot.root_session_id)
    throw new Error("The queued message response did not match this session.");
  const byId = new Map(snapshot.items.map((entry) => [entry.queue_item_id, entry]));
  byId.set(item.queue_item_id, structuredClone(item));
  return {
    ...snapshot,
    items: [...byId.values()].sort((left, right) => left.queue_sequence - right.queue_sequence),
  };
}

export function latestHomeEditableQueueItem(
  snapshot: HomeMessageQueueSnapshot | null,
): HomeQueuedMessage | null {
  if (!snapshot) return null;
  for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
    const item = snapshot.items[index];
    if (
      item?.author_public_id === CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN &&
      item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED
    )
      return item;
  }
  return null;
}

export function isHomeQueuedMessageProjectionWaiting(row: HomeQueuedMessageProjection): boolean {
  if (row.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION) return false;
  if (row.kind !== HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE) return true;
  return (
    row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
    row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED
  );
}

export interface HomeQueueAdmissionSnapshot {
  idempotency_key?: string;
  content: string;
  target_participants: ConversationMessageQueueTargetParticipantsV1;
  quote_refs: HomeQueuedMessage["quote_refs"];
  private_context_present: boolean;
  clearIfCurrent(): void;
  restoreIfVacant(): boolean;
  discardRetained(): Promise<boolean>;
}

export interface HomeQueueAdmissionEntry {
  root: string;
  generation: number;
  request: HomeEnqueueMessageRequest;
  projection: HomeOptimisticQueuedMessage;
  admission: HomeQueueAdmissionSnapshot;
  controller: AbortController;
}

export interface HomeQueueActivationAuthority {
  captureGeneration(): number;
  isGenerationCurrent(generation: number): boolean;
}

export interface HomeQueueAdmissionRuntimeInput {
  activation: HomeQueueActivationAuthority;
  activeRootId: Ref<string | null>;
  online: Ref<boolean>;
  composerError: Ref<string>;
  snapshot: ShallowRef<HomeMessageQueueSnapshot | null>;
  optimistic: Ref<HomeOptimisticQueuedMessage[]>;
  retryable: Ref<HomeRetryableQueuedMessage[]>;
  needsAction: Ref<HomeNeedsActionQueuedMessage[]>;
  announcement: Ref<string>;
  refreshQueue(): Promise<boolean>;
  setSendAsNew(value: boolean): void;
  focusComposer(): void;
}

export const cloneHomeQueueTargets = (
  targets: ConversationMessageQueueTargetParticipantsV1,
): ConversationMessageQueueTargetParticipantsV1 =>
  targets === CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL
    ? CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL
    : [...targets];

export function createHomeQueueAdmissionEntry(input: {
  root: string;
  generation: number;
  authorityDigest: string;
  clientInstanceId: string;
  wireClientOrder: number;
  projectionOrder: number;
  admission: HomeQueueAdmissionSnapshot;
}): HomeQueueAdmissionEntry {
  const idempotencyKey =
    input.admission.idempotency_key ?? `home-message.${createHomeActionKey()}`.slice(0, 128);
  const projection: HomeOptimisticQueuedMessage = {
    kind: HOME_QUEUED_MESSAGE_PROJECTION_KIND.OPTIMISTIC,
    projection_key: `home-optimistic:${createHomeActionKey()}`,
    root_session_id: input.root,
    client_order: input.projectionOrder,
    content: input.admission.content,
    target_participants: cloneHomeQueueTargets(input.admission.target_participants),
    quote_refs: structuredClone(input.admission.quote_refs),
    private_context_present: input.admission.private_context_present,
  };
  return {
    root: input.root,
    generation: input.generation,
    request: {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      idempotency_key: idempotencyKey,
      expected_authority_digest: input.authorityDigest,
      client_instance_id: input.clientInstanceId,
      client_order: input.wireClientOrder,
      content: input.admission.content,
      target_participants: cloneHomeQueueTargets(input.admission.target_participants),
      quote_refs: structuredClone(input.admission.quote_refs),
      private_context_present: input.admission.private_context_present,
    },
    projection,
    admission: input.admission,
    controller: new AbortController(),
  };
}

export function projectHomeQueuedMessages(input: {
  snapshot: HomeMessageQueueSnapshot | null;
  optimistic: readonly HomeOptimisticQueuedMessage[];
  retryable: readonly HomeRetryableQueuedMessage[];
  needsAction: readonly HomeNeedsActionQueuedMessage[];
  activeRootId: string | null;
}): HomeQueuedMessageProjection[] {
  const authoritative = (input.snapshot?.items ?? []).map((item) => ({
    kind: HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE,
    item,
  }));
  const local = [...input.optimistic, ...input.retryable, ...input.needsAction].filter(
    (item) => item.root_session_id === input.activeRootId,
  );
  authoritative.sort((left, right) => left.item.queue_sequence - right.item.queue_sequence);
  local.sort((left, right) => left.client_order - right.client_order);
  return [...authoritative, ...local];
}

export const hasHomeLiveQueueItems = (
  snapshot: HomeMessageQueueSnapshot | null,
  optimisticCount: number,
): boolean =>
  optimisticCount > 0 ||
  Boolean(
    snapshot?.items.some(
      (item) =>
        item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
        item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
    ),
  );

export const isHomeQueueFailureRetryable = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof ConversationHomeApiError &&
    error.publicError.retryable === true &&
    error.publicError.recovery_action === CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY);

export function homeQueueFailureRecoveryAction(
  error: unknown,
): ConversationMessageQueueRecoveryActionV1 | null {
  if (!(error instanceof ConversationHomeApiError)) return null;
  const recoveryAction = error.publicError.recovery_action;
  if (recoveryAction === CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY) return null;
  return Object.values(CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION).some(
    (candidate) => candidate === recoveryAction,
  )
    ? (recoveryAction as ConversationMessageQueueRecoveryActionV1)
    : null;
}

interface HomeQueueRecoveryRuntimeInput {
  activeRootId: Ref<string | null>;
  online: Ref<boolean>;
  activationError: Ref<string>;
  messageQueue: ShallowRef<HomeMessageQueueSnapshot | null>;
  needsAction: Ref<HomeNeedsActionQueuedMessage[]>;
  announcement: Ref<string>;
  busyKey: Ref<string | null>;
  busyKind: Ref<HomeQueueRecoveryBusyKind | null>;
  isComposerVacant(): boolean;
  selectSession(rootSessionId: string): Promise<void>;
  restore(projectionKey: string, sendAsNew: boolean): boolean;
  dismiss(projectionKey: string): Promise<boolean>;
}

export interface HomeQueueRecoveryRuntime {
  composerVacant: ComputedRef<boolean>;
  recover(projectionKey: string): Promise<boolean>;
  dismiss(projectionKey: string): Promise<boolean>;
}

export function createHomeQueueRecoveryRuntime(
  input: HomeQueueRecoveryRuntimeInput,
): HomeQueueRecoveryRuntime {
  const composerVacant = computed(input.isComposerVacant);

  async function recover(projectionKey: string): Promise<boolean> {
    if (!composerVacant.value || input.busyKey.value) return false;
    const failure = input.needsAction.value.find((entry) => entry.projection_key === projectionKey);
    if (!failure) return false;
    const recoveryAction = failure.recovery_action;
    if (
      recoveryAction === CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.REPAIR_AUTHORITY ||
      recoveryAction === CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY
    )
      return false;
    input.busyKey.value = projectionKey;
    input.busyKind.value = HOME_QUEUE_RECOVERY_BUSY_KIND.RESTORE;
    try {
      if (
        recoveryAction === CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SELECT_ACTIVE_CONVERSATION
      ) {
        const rootSessionId = input.activeRootId.value;
        if (!input.online.value || !rootSessionId) {
          input.announcement.value =
            "Reconnect before selecting the active conversation for this failed message.";
          return false;
        }
        await input.selectSession(rootSessionId);
        if (
          input.activeRootId.value !== rootSessionId ||
          input.messageQueue.value?.root_session_id !== rootSessionId ||
          input.activationError.value !== ""
        ) {
          input.announcement.value =
            "The active conversation could not be refreshed. The failed message remains unsent.";
          return false;
        }
      }
      return input.restore(
        projectionKey,
        recoveryAction === CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SEND_AS_NEW,
      );
    } finally {
      if (input.busyKey.value === projectionKey) input.busyKey.value = null;
      if (input.busyKind.value === HOME_QUEUE_RECOVERY_BUSY_KIND.RESTORE)
        input.busyKind.value = null;
    }
  }

  async function dismiss(projectionKey: string): Promise<boolean> {
    if (input.busyKey.value) return false;
    const failure = input.needsAction.value.find((entry) => entry.projection_key === projectionKey);
    if (!failure) return false;
    if (failure.private_context_present && !input.online.value) {
      input.announcement.value =
        "Reconnect before dismissing this message so private context cleanup can be confirmed.";
      return false;
    }
    input.busyKey.value = projectionKey;
    input.busyKind.value = HOME_QUEUE_RECOVERY_BUSY_KIND.DISMISS;
    try {
      return await input.dismiss(projectionKey);
    } finally {
      if (input.busyKey.value === projectionKey) input.busyKey.value = null;
      if (input.busyKind.value === HOME_QUEUE_RECOVERY_BUSY_KIND.DISMISS)
        input.busyKind.value = null;
    }
  }

  return { composerVacant, recover, dismiss };
}
