import { type Ref, type ShallowRef, computed } from "vue";
import { CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION } from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import { conversationHomeApi } from "./conversation-home-api.js";
import { mergeHomeQueuedMessage } from "./conversation-home-message-queue-authority.js";
import type {
  HomeEnqueueMessageRequest,
  HomeMessageQueueSnapshot,
  HomeOptimisticQueuedMessage,
  HomeQueuedMessage,
  HomeQueuedMessageProjection,
} from "./conversation-home-message-queue-types.js";
import { createHomeActionKey, readableHomeError } from "./conversation-home-runtime.js";

interface QueueActivationAuthority {
  captureGeneration(): number;
  isGenerationCurrent(generation: number): boolean;
}

export interface HomeQueueAdmissionSnapshot {
  idempotency_key?: string;
  content: string;
  target_participants: "all" | string[];
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
  announcement: Ref<string>;
  refreshQueue(): Promise<boolean>;
  clearSendAsNew(): void;
}

const cloneTargets = (targets: "all" | string[]): "all" | string[] =>
  targets === "all" ? "all" : [...targets];

export function createHomeMessageQueueAdmissionRuntime(input: AdmissionRuntimeInput) {
  const active = new Map<string, AdmissionEntry>();
  const interrupted = new Map<string, AdmissionEntry[]>();
  const refreshDeferred = new Set<string>();
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
  const projections = computed<HomeQueuedMessageProjection[]>(() => {
    const authoritative = (input.snapshot.value?.items ?? []).map((item) => ({
      kind: "authoritative" as const,
      item,
    }));
    return [...authoritative, ...input.optimistic.value].sort((left, right) => {
      const leftOrder =
        left.kind === "authoritative" ? left.item.queue_sequence : left.client_order;
      const rightOrder =
        right.kind === "authoritative" ? right.item.queue_sequence : right.client_order;
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
      kind: "optimistic",
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
      input.clearSendAsNew();
      input.announcement.value = `Queued message ${item.queue_sequence}.`;
      return true;
    } catch (error) {
      if (!isCurrent(entry) || entry.controller.signal.aborted) return false;
      removeOptimistic(entry.projection.projection_key);
      entry.admission.restoreIfVacant();
      input.composerError.value = readableHomeError(error);
      input.announcement.value = "Message was not queued. Draft preserved for an explicit retry.";
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
      input.composerError.value =
        "Wait for this conversation’s message queue to finish refreshing.";
      return false;
    }
    if (!input.online.value) return false;
    const entry = makeEntry(root, admission);
    input.composerError.value = "";
    input.clearSendAsNew();
    admission.clearIfCurrent();
    return transport(entry, true);
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

  function goOffline(root: string): void {
    for (const [key, entry] of active) {
      if (entry.root !== root) continue;
      entry.controller.abort();
      active.delete(key);
      removeOptimistic(entry.projection.projection_key);
      entry.admission.restoreIfVacant();
    }
    interrupted.delete(root);
    refreshDeferred.delete(root);
  }

  function dispose(): void {
    for (const entry of active.values()) entry.controller.abort();
    active.clear();
    interrupted.clear();
    refreshDeferred.clear();
  }

  return {
    projections,
    enqueue,
    deferRefresh,
    interruptRoot,
    resumeRoot,
    goOffline,
    dispose,
  };
}
