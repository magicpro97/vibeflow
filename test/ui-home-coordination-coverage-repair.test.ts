import { afterEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { ref, shallowRef } from "vue";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
} from "../src/orchestrator/conversation/conversation-message-queue-contract.js";
import {
  ConversationHomeApiError,
  conversationHomeApi,
} from "../src/ui/src/conversation-home-api.js";
import {
  type HomeQueueAdmissionEntry,
  isHomeQueuedMessageProjectionWaiting,
} from "../src/ui/src/conversation-home-message-queue-authority.js";
import { HomeMessageQueueClientLanes } from "../src/ui/src/conversation-home-message-queue-client-lanes.js";
import { createHomeMessageQueueRuntime } from "../src/ui/src/conversation-home-message-queue-runtime.js";
import { HomeMessageQueueTransportSequencer } from "../src/ui/src/conversation-home-message-queue-transport-sequencer.js";
import type {
  HomeMessageQueueSnapshot,
  HomeNeedsActionQueuedMessage,
  HomeOptimisticQueuedMessage,
  HomeQueuedMessage,
  HomeQueuedMessageEditBinding,
  HomeRetryableQueuedMessage,
} from "../src/ui/src/conversation-home-message-queue-types.js";
import { HOME_QUEUED_MESSAGE_PROJECTION_KIND } from "../src/ui/src/conversation-home-message-queue-types.js";
import { ActivationEpoch } from "../src/ui/src/conversation-home-state.js";
import { useConversationHomeStore } from "../src/ui/src/conversation-home-store.js";

const digest = (seed: string): string => `sha256:${seed.repeat(64).slice(0, 64)}`;
const queueId = (seed: string): string => `vf-queued-message-${seed.repeat(64).slice(0, 64)}`;
const originalEnqueue = conversationHomeApi.enqueueMessage;

afterEach(() => {
  conversationHomeApi.enqueueMessage = originalEnqueue;
});

function queueItem(sequence: number, content: string): HomeQueuedMessage {
  const seed = sequence.toString(16);
  return {
    schema_version: "1.0",
    queue_item_id: queueId(seed),
    queue_sequence: sequence,
    root_session_id: "root-coverage",
    author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
    content,
    content_digest: digest(seed),
    target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
    quote_refs: [],
    private_context_present: false,
    predecessor_queue_item_id: sequence === 1 ? null : queueId((sequence - 1).toString(16)),
    admitted_authority_digest: digest("a"),
    effective_authority_digest: digest("a"),
    state: "queued",
    stale_reason: null,
    admitted_at: "2026-08-28T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
    item_digest: digest(`f${seed}`),
  };
}

function queueSnapshot(items: HomeQueuedMessage[] = []): HomeMessageQueueSnapshot {
  return {
    schema_version: "1.0",
    root_session_id: "root-coverage",
    current_authority_digest: digest("a"),
    max_nonterminal_items: 32,
    items,
  };
}

function queueHarness() {
  const activation = new ActivationEpoch();
  activation.begin("root-coverage");
  const activeRootId = ref<string | null>("root-coverage");
  const online = ref(true);
  const draft = ref("");
  const composerError = ref("");
  const snapshot = shallowRef<HomeMessageQueueSnapshot | null>(queueSnapshot());
  const optimistic = ref<HomeOptimisticQueuedMessage[]>([]);
  const retryable = ref<HomeRetryableQueuedMessage[]>([]);
  const needsAction = ref<HomeNeedsActionQueuedMessage[]>([]);
  const edit = shallowRef<HomeQueuedMessageEditBinding | null>(null);
  const editSaving = ref(false);
  const sendAsNew = ref(false);
  const announcement = ref("");
  const composerFocusEpoch = ref(0);
  const runtime = createHomeMessageQueueRuntime({
    activation,
    activeRootId,
    online,
    draft,
    composerError,
    snapshot,
    optimistic,
    retryable,
    needsAction,
    edit,
    editSaving,
    sendAsNew,
    announcement,
    composerFocusEpoch,
    refreshQueue: async () => true,
  });
  const admission = (content: string, options: { discard?: boolean; restore?: boolean } = {}) => ({
    content,
    target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
    quote_refs: [],
    private_context_present: false,
    clearIfCurrent() {
      if (draft.value === content) draft.value = "";
    },
    restoreIfVacant() {
      if (options.restore === false || draft.value !== "") return false;
      draft.value = content;
      return true;
    },
    async discardRetained() {
      return options.discard ?? true;
    },
  });
  return {
    activation,
    activeRootId,
    online,
    draft,
    composerError,
    snapshot,
    optimistic,
    retryable,
    needsAction,
    announcement,
    runtime,
    admission,
  };
}

function laneEntry(
  root: string,
  clientInstanceId: string,
  clientOrder: number,
  projectionOrder: number,
): HomeQueueAdmissionEntry {
  return {
    root,
    generation: 1,
    request: {
      schema_version: "1.0",
      idempotency_key: `queue-${projectionOrder}`,
      expected_authority_digest: digest("a"),
      client_instance_id: clientInstanceId,
      client_order: clientOrder,
      content: `message-${projectionOrder}`,
      target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
      quote_refs: [],
      private_context_present: false,
    },
    projection: {
      kind: HOME_QUEUED_MESSAGE_PROJECTION_KIND.OPTIMISTIC,
      projection_key: `projection-${projectionOrder}`,
      root_session_id: root,
      client_order: projectionOrder,
      content: `message-${projectionOrder}`,
      target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
      quote_refs: [],
      private_context_present: false,
    },
    admission: {
      content: `message-${projectionOrder}`,
      target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
      quote_refs: [],
      private_context_present: false,
      clearIfCurrent() {},
      restoreIfVacant: () => true,
      discardRetained: async () => true,
    },
    controller: new AbortController(),
  };
}

describe("Home coordination queue coverage repair", () => {
  test("local projections wait, abandoned FIFO entries rebind, and rejected transports release", async () => {
    expect(
      isHomeQueuedMessageProjectionWaiting({
        kind: HOME_QUEUED_MESSAGE_PROJECTION_KIND.OPTIMISTIC,
      } as HomeOptimisticQueuedMessage),
    ).toBeTrue();
    expect(
      isHomeQueuedMessageProjectionWaiting({
        kind: HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE,
        item: queueItem(1, "authoritative"),
      }),
    ).toBeTrue();

    const lanes = new HomeMessageQueueClientLanes();
    const first = lanes.allocate("root-coverage");
    const second = lanes.allocate("root-coverage");
    const failed = laneEntry(
      "root-coverage",
      first.clientInstanceId,
      first.wireClientOrder,
      first.projectionOrder,
    );
    const later = laneEntry(
      "root-coverage",
      second.clientInstanceId,
      second.wireClientOrder,
      second.projectionOrder,
    );
    lanes.rotateAfterOfflineInterruption("root-coverage", 2);
    lanes.rebindAfterAbandonment(failed, [later]);
    expect(later.request.client_instance_id).not.toBe(first.clientInstanceId);
    expect(later.request.client_order).toBe(1);
    expect(lanes.allocate("root-coverage").wireClientOrder).toBe(2);

    const sequencer = new HomeMessageQueueTransportSequencer();
    await expect(
      sequencer.schedule("root-coverage", async () => {
        throw new Error("transport failed");
      }),
    ).rejects.toThrow("transport failed");
    await expect(sequencer.schedule("root-coverage", async () => true)).resolves.toBeTrue();
  });

  test("cleanup refusal retains the exact needs-action message", async () => {
    conversationHomeApi.enqueueMessage = (async () => {
      throw new ConversationHomeApiError(400, {
        code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.INVALID_REQUEST,
        message: "The queued request needs editing.",
        retryable: false,
        recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT,
        details: null,
      });
    }) as typeof conversationHomeApi.enqueueMessage;
    const value = queueHarness();
    try {
      value.draft.value = "retain me";
      const sending = value.runtime.enqueue(
        value.admission("retain me", { discard: false, restore: false }),
      );
      value.draft.value = "newer draft";
      expect(await sending).toBeFalse();
      const projectionKey = value.needsAction.value[0]?.projection_key;
      expect(projectionKey).toBeString();
      expect(await value.runtime.dismissNeedsAction(projectionKey ?? "")).toBeFalse();
      expect(value.needsAction.value).toHaveLength(1);
      expect(value.announcement.value).toContain("cleanup was not confirmed");
    } finally {
      value.runtime.dispose();
      value.activation.close();
    }
  });

  test("restoring an interrupted blocker rebinds and resumes the next FIFO request", async () => {
    const requests: Array<{ client_instance_id: string; client_order: number; content: string }> =
      [];
    let call = 0;
    conversationHomeApi.enqueueMessage = ((_root, request, signal) => {
      call += 1;
      requests.push({
        client_instance_id: request.client_instance_id,
        client_order: request.client_order,
        content: request.content,
      });
      if (call === 1)
        return new Promise<HomeQueuedMessage>((_resolve, reject) => {
          if (!signal) throw new Error("queue transport signal is required");
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            {
              once: true,
            },
          );
        });
      if (call === 2)
        return Promise.reject(
          new ConversationHomeApiError(400, {
            code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.INVALID_REQUEST,
            message: "Interrupted request needs editing.",
            retryable: false,
            recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT,
            details: null,
          }),
        );
      return Promise.resolve(queueItem(1, request.content));
    }) as typeof conversationHomeApi.enqueueMessage;
    const value = queueHarness();
    try {
      value.draft.value = "A";
      const first = value.runtime.enqueue(value.admission("A"));
      value.draft.value = "B";
      const second = value.runtime.enqueue(value.admission("B"));
      expect(requests).toHaveLength(1);
      const interruptedLane = requests[0]?.client_instance_id;
      value.online.value = false;
      value.runtime.goOffline();
      expect(await Promise.all([first, second])).toEqual([false, false]);

      value.online.value = true;
      value.runtime.adoptSnapshot(queueSnapshot(), "root-coverage");
      for (let turn = 0; turn < 20 && value.needsAction.value.length === 0; turn += 1)
        await Promise.resolve();
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
      const blockerKey = value.needsAction.value[0]?.projection_key;
      if (!blockerKey) throw new Error("expected interrupted blocker projection");
      expect(value.runtime.restoreNeedsAction(blockerKey)).toBeTrue();
      for (let turn = 0; turn < 20 && requests.length < 3; turn += 1) await Promise.resolve();
      expect(requests).toHaveLength(3);
      expect(requests[2]).toMatchObject({ content: "B", client_order: 1 });
      expect(requests[2]?.client_instance_id).not.toBe(interruptedLane);
    } finally {
      value.runtime.dispose();
      value.activation.close();
    }
  });

  test("the store computes composer vacancy from all public composer authorities", () => {
    setActivePinia(createPinia());
    const store = useConversationHomeStore();
    try {
      expect(store.queueRecoveryComposerVacant).toBeTrue();
      store.draft = "occupied";
      expect(store.queueRecoveryComposerVacant).toBeFalse();
    } finally {
      store.$dispose();
    }
  });
});
