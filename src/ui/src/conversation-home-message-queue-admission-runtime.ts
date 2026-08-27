import { type Ref, type ShallowRef, computed } from "vue";
import {
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  type ConversationMessageQueueTargetParticipantsV1,
} from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import { conversationHomeApi } from "./conversation-home-api.js";
import { mergeHomeQueuedMessage } from "./conversation-home-message-queue-authority.js";
import type {
  HomeEnqueueMessageRequest,
  HomeMessageQueueSnapshot,
  HomeOptimisticQueuedMessage,
  HomeQueuedMessage,
  HomeQueuedMessageProjection,
  HomeRetryableQueuedMessage,
} from "./conversation-home-message-queue-types.js";
import { HOME_QUEUED_MESSAGE_PROJECTION_KIND } from "./conversation-home-message-queue-types.js";
import { createHomeActionKey, readableHomeError } from "./conversation-home-runtime.js";

interface QueueActivationAuthority {
  captureGeneration(): number;
  isGenerationCurrent(generation: number): boolean;
}

export interface HomeQueueAdmissionSnapshot {
  idempotency_key?: string;
  content: string;
  target_participants: ConversationMessageQueueTargetParticipantsV1;
  quote_refs: HomeQueuedMessage["quote_refs"];
  private_context_present: boolean;
  clearIfCurrent(): void;
  restoreIfVacant(): boolean;
}

interface AdmissionEntry {
  root: string;
  generation: number;
  request: HomeEnqueueMessageRequest;
  projection: HomeOptimisticQueuedMessage;
  admission: HomeQueueAdmissionSnapshot;
  controller: AbortController;
}

interface AdmissionRuntimeInput {
  activation: QueueActivationAuthority;
  activeRootId: Ref<string | null>;
  online: Ref<boolean>;
  composerError: Ref<string>;
  snapshot: ShallowRef<HomeMessageQueueSnapshot | null>;
  optimistic: Ref<HomeOptimisticQueuedMessage[]>;
  retryable: Ref<HomeRetryableQueuedMessage[]>;
  announcement: Ref<string>;
  refreshQueue(): Promise<boolean>;
  clearSendAsNew(): void;
}

const cloneTargets = (
  targets: ConversationMessageQueueTargetParticipantsV1,
): ConversationMessageQueueTargetParticipantsV1 =>
  targets === CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL
    ? CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL
    : [...targets];

export function createHomeMessageQueueAdmissionRuntime(input: AdmissionRuntimeInput) {
  const active = new Map<string, AdmissionEntry>();
  const interrupted = new Map<string, AdmissionEntry[]>();
  const retryableEntries = new Map<string, AdmissionEntry>();
  const refreshDeferred = new Set<string>();
  let composerErrorLease: { owner: string; expected: string } | null = null;
  let clientOrder = 0;

  const isCurrent = (entry: AdmissionEntry): boolean =>
    input.activation.isGenerationCurrent(entry.generation) &&
    input.activeRootId.value === entry.root;
  const rootHasActive = (root: string): boolean =>
    [...active.values()].some((entry) => entry.root === root);
  const removeOptimistic = (projectionKey: string) => {
    input.optimistic.value = input.optimistic.value.filter(
      (item) => item.projection_key !== projectionKey,
    );
  };
  const removeRetryable = (projectionKey: string) => {
    retryableEntries.delete(projectionKey);
    input.retryable.value = input.retryable.value.filter(
      (item) => item.projection_key !== projectionKey,
    );
  };
  const ownsComposerError = (entry: AdmissionEntry): boolean => {
    const lease = composerErrorLease;
    if (!lease || lease.owner !== entry.projection.projection_key) return false;
    if (input.composerError.value === lease.expected) return true;
    composerErrorLease = null;
    return false;
  };
  const claimComposerError = (entry: AdmissionEntry) => {
    input.composerError.value = "";
    composerErrorLease = { owner: entry.projection.projection_key, expected: "" };
  };
  const setOwnedComposerError = (entry: AdmissionEntry, message: string): boolean => {
    if (!ownsComposerError(entry)) return false;
    input.composerError.value = message;
    composerErrorLease = { owner: entry.projection.projection_key, expected: message };
    return true;
  };
  const releaseComposerError = (entry: AdmissionEntry) => {
    if (ownsComposerError(entry)) composerErrorLease = null;
  };
  const setUnownedComposerError = (message: string) => {
    composerErrorLease = null;
    input.composerError.value = message;
  };
  const retainRetryable = (entry: AdmissionEntry, failureMessage: string, retrying = false) => {
    retryableEntries.set(entry.projection.projection_key, entry);
    const projection: HomeRetryableQueuedMessage = {
      ...entry.projection,
      kind: HOME_QUEUED_MESSAGE_PROJECTION_KIND.RETRYABLE,
      failure_message: failureMessage,
      retrying,
    };
    input.retryable.value = [
      ...input.retryable.value.filter(
        (item) => item.projection_key !== entry.projection.projection_key,
      ),
      projection,
    ];
  };
  const projections = computed<HomeQueuedMessageProjection[]>(() => {
    const authoritative = (input.snapshot.value?.items ?? []).map((item) => ({
      kind: HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE,
      item,
    }));
    const retryable = input.retryable.value.filter(
      (item) => item.root_session_id === input.activeRootId.value,
    );
    return [...authoritative, ...input.optimistic.value, ...retryable].sort((left, right) => {
      const leftOrder =
        left.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE
          ? left.item.queue_sequence
          : left.client_order;
      const rightOrder =
        right.kind === HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE
          ? right.item.queue_sequence
          : right.client_order;
      return leftOrder - rightOrder;
    });
  });

  function makeEntry(root: string, admission: HomeQueueAdmissionSnapshot): AdmissionEntry {
    const idempotencyKey =
      admission.idempotency_key ?? `home-message.${createHomeActionKey()}`.slice(0, 128);
    clientOrder =
      Math.max(
        clientOrder,
        ...(input.snapshot.value?.items.map((item) => item.queue_sequence) ?? []),
        ...input.optimistic.value.map((item) => item.client_order),
      ) + 1;
    const projection: HomeOptimisticQueuedMessage = {
      kind: HOME_QUEUED_MESSAGE_PROJECTION_KIND.OPTIMISTIC,
      projection_key: `home-optimistic:${createHomeActionKey()}`,
      root_session_id: root,
      client_order: clientOrder,
      content: admission.content,
      target_participants: cloneTargets(admission.target_participants),
      quote_refs: structuredClone(admission.quote_refs),
      private_context_present: admission.private_context_present,
    };
    return {
      root,
      generation: input.activation.captureGeneration(),
      request: {
        schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
        idempotency_key: idempotencyKey,
        expected_authority_digest: input.snapshot.value?.current_authority_digest ?? "",
        content: admission.content,
        target_participants: cloneTargets(admission.target_participants),
        quote_refs: structuredClone(admission.quote_refs),
        private_context_present: admission.private_context_present,
      },
      projection,
      admission,
      controller: new AbortController(),
    };
  }

  async function transport(entry: AdmissionEntry, visible: boolean): Promise<boolean> {
    active.set(entry.request.idempotency_key, entry);
    if (visible) input.optimistic.value = [...input.optimistic.value, entry.projection];
    try {
      let item: HomeQueuedMessage;
      try {
        item = await conversationHomeApi.enqueueMessage(
          entry.root,
          entry.request,
          entry.controller.signal,
        );
      } catch (error) {
        if (
          !(error instanceof TypeError) ||
          !isCurrent(entry) ||
          !input.online.value ||
          entry.controller.signal.aborted
        )
          throw error;
        item = await conversationHomeApi.enqueueMessage(
          entry.root,
          entry.request,
          entry.controller.signal,
        );
      }
      if (!isCurrent(entry) || entry.controller.signal.aborted) return false;
      const currentSnapshot = input.snapshot.value;
      if (!currentSnapshot || currentSnapshot.root_session_id !== entry.root) return false;
      input.snapshot.value = mergeHomeQueuedMessage(currentSnapshot, item);
      removeOptimistic(entry.projection.projection_key);
      removeRetryable(entry.projection.projection_key);
      releaseComposerError(entry);
      input.announcement.value = `Queued message ${item.queue_sequence}.`;
      return true;
    } catch (error) {
      if (!isCurrent(entry) || entry.controller.signal.aborted) return false;
      removeOptimistic(entry.projection.projection_key);
      const failureMessage = readableHomeError(error);
      setOwnedComposerError(entry, failureMessage);
      if (entry.admission.restoreIfVacant()) {
        removeRetryable(entry.projection.projection_key);
        input.announcement.value = "Message was not queued. Draft restored to the composer.";
      } else {
        retainRetryable(entry, failureMessage);
        input.announcement.value =
          "Message was not queued. It remains in Message queue for an explicit retry.";
      }
      return false;
    } finally {
      if (active.get(entry.request.idempotency_key) === entry)
        active.delete(entry.request.idempotency_key);
      if (isCurrent(entry) && !rootHasActive(entry.root) && refreshDeferred.delete(entry.root))
        void input.refreshQueue().catch(() => undefined);
    }
  }

  async function enqueue(admission: HomeQueueAdmissionSnapshot): Promise<boolean> {
    const root = input.activeRootId.value;
    if (!root || input.snapshot.value?.root_session_id !== root) {
      setUnownedComposerError("Wait for this conversation’s message queue to finish refreshing.");
      return false;
    }
    if (!input.online.value) return false;
    const entry = makeEntry(root, admission);
    claimComposerError(entry);
    input.clearSendAsNew();
    admission.clearIfCurrent();
    return transport(entry, true);
  }

  async function retry(projectionKey: string): Promise<boolean> {
    const prior = retryableEntries.get(projectionKey);
    const root = input.activeRootId.value;
    if (!prior || !root || prior.root !== root || input.snapshot.value?.root_session_id !== root)
      return false;
    if (!input.online.value) {
      const failureMessage = "Reconnect before retrying this queued message.";
      setOwnedComposerError(prior, failureMessage);
      retainRetryable(prior, failureMessage);
      input.announcement.value = failureMessage;
      return false;
    }
    if (active.has(prior.request.idempotency_key)) return false;
    const entry: AdmissionEntry = {
      ...prior,
      generation: input.activation.captureGeneration(),
      controller: new AbortController(),
    };
    setOwnedComposerError(entry, "");
    retainRetryable(entry, "Retrying the exact queued message request.", true);
    return transport(entry, false);
  }

  function deferRefresh(root: string): boolean {
    if (!rootHasActive(root)) return false;
    refreshDeferred.add(root);
    return true;
  }

  function interruptRoot(root: string): void {
    const saved = interrupted.get(root) ?? [];
    for (const [key, entry] of active) {
      if (entry.root !== root) continue;
      entry.controller.abort();
      active.delete(key);
      removeOptimistic(entry.projection.projection_key);
      saved.push(entry);
    }
    saved.sort((left, right) => left.projection.client_order - right.projection.client_order);
    if (saved.length) interrupted.set(root, saved);
    refreshDeferred.delete(root);
  }

  function resumeRoot(root: string): void {
    const saved = interrupted.get(root);
    if (!saved?.length || !input.online.value || input.activeRootId.value !== root) return;
    interrupted.delete(root);
    input.announcement.value = `Reconciling ${saved.length} interrupted message${saved.length === 1 ? "" : "s"}.`;
    void (async () => {
      for (let index = 0; index < saved.length; index += 1) {
        const prior = saved[index];
        if (!prior || input.activeRootId.value !== root || !input.online.value) {
          interrupted.set(root, saved.slice(index));
          return;
        }
        const entry: AdmissionEntry = {
          ...prior,
          generation: input.activation.captureGeneration(),
          controller: new AbortController(),
        };
        await transport(entry, false);
      }
    })();
  }

  function goOffline(root: string): boolean {
    let retainedForRetry = false;
    for (const [key, entry] of active) {
      if (entry.root !== root) continue;
      entry.controller.abort();
      active.delete(key);
      removeOptimistic(entry.projection.projection_key);
      if (entry.admission.restoreIfVacant()) removeRetryable(entry.projection.projection_key);
      else {
        retainRetryable(entry, "Connection lost before queue admission was confirmed.");
        retainedForRetry = true;
      }
    }
    interrupted.delete(root);
    refreshDeferred.delete(root);
    return retainedForRetry;
  }

  function dispose(): void {
    for (const entry of active.values()) entry.controller.abort();
    active.clear();
    interrupted.clear();
    retryableEntries.clear();
    refreshDeferred.clear();
    composerErrorLease = null;
  }

  return {
    projections,
    enqueue,
    retry,
    deferRefresh,
    interruptRoot,
    resumeRoot,
    goOffline,
    dispose,
  };
}
