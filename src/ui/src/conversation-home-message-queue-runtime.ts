import type { Ref, ShallowRef } from "vue";
import {
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import { conversationHomeApi } from "./conversation-home-api.js";
import { createHomeMessageQueueAdmissionRuntime } from "./conversation-home-message-queue-admission-runtime.js";
import {
  type HomeQueueActivationAuthority,
  assertHomeMessageQueueSnapshot,
  cloneHomeQueueTargets,
  isHomeQueuedMessage,
  latestHomeEditableQueueItem,
  mergeHomeQueuedMessage,
} from "./conversation-home-message-queue-authority.js";
import {
  matchesHomeQueueEditConflict,
  preservesHomeQueueEditAuthority,
  sameHomeQueueEditBinding,
} from "./conversation-home-message-queue-edit-authority.js";
import type {
  HomeMessageQueueSnapshot,
  HomeNeedsActionQueuedMessage,
  HomeOptimisticQueuedMessage,
  HomeQueuedMessage,
  HomeQueuedMessageEditBinding,
  HomeRetryableQueuedMessage,
} from "./conversation-home-message-queue-types.js";
import { createHomeActionKey, readableHomeError } from "./conversation-home-runtime.js";
export type { HomeQueueAdmissionSnapshot } from "./conversation-home-message-queue-admission-runtime.js";

interface HomeMessageQueueRuntimeInput {
  activation: HomeQueueActivationAuthority;
  activeRootId: Ref<string | null>;
  online: Ref<boolean>;
  draft: Ref<string>;
  composerError: Ref<string>;
  snapshot: ShallowRef<HomeMessageQueueSnapshot | null>;
  optimistic: Ref<HomeOptimisticQueuedMessage[]>;
  retryable: Ref<HomeRetryableQueuedMessage[]>;
  needsAction: Ref<HomeNeedsActionQueuedMessage[]>;
  edit: ShallowRef<HomeQueuedMessageEditBinding | null>;
  editSaving: Ref<boolean>;
  sendAsNew: Ref<boolean>;
  announcement: Ref<string>;
  composerFocusEpoch: Ref<number>;
  refreshQueue(): Promise<boolean>;
}

interface SavedRootDraft {
  content: string;
  edit: HomeQueuedMessageEditBinding | null;
  editBaseline: HomeQueuedMessage | null;
  sendAsNew: boolean;
}

interface QueueCommand {
  generation: number;
  root_session_id: string;
}

const snapshotConfirmsCommittedEdit = (
  before: HomeQueuedMessage | null | undefined,
  after: HomeQueuedMessage | undefined,
  binding: HomeQueuedMessageEditBinding,
  desiredContent: string,
): boolean =>
  Boolean(
    before &&
      before.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED &&
      before.item_digest === binding.item_digest &&
      after &&
      after.item_digest !== binding.item_digest &&
      preservesHomeQueueEditAuthority(before, after, desiredContent),
  );

export function createHomeMessageQueueRuntime(input: HomeMessageQueueRuntimeInput) {
  const savedDrafts = new Map<string, SavedRootDraft>();
  let editController: { root: string; token: string; controller: AbortController } | null = null;
  let editToken: string | null = null;

  const current = (command: QueueCommand): boolean =>
    input.activation.isGenerationCurrent(command.generation) &&
    input.activeRootId.value === command.root_session_id;
  const commandFor = (rootSessionId: string): QueueCommand => ({
    generation: input.activation.captureGeneration(),
    root_session_id: rootSessionId,
  });
  const announce = (message: string) => {
    input.announcement.value = message;
  };
  const admissions = createHomeMessageQueueAdmissionRuntime({
    activation: input.activation,
    activeRootId: input.activeRootId,
    online: input.online,
    composerError: input.composerError,
    snapshot: input.snapshot,
    optimistic: input.optimistic,
    retryable: input.retryable,
    needsAction: input.needsAction,
    announcement: input.announcement,
    refreshQueue: input.refreshQueue,
    setSendAsNew(value) {
      input.sendAsNew.value = value;
    },
    focusComposer() {
      input.composerFocusEpoch.value += 1;
    },
  });

  function adoptSnapshot(value: unknown, rootSessionId: string): void {
    assertHomeMessageQueueSnapshot(value, rootSessionId);
    if (input.activeRootId.value !== rootSessionId) return;
    if (admissions.deferRefresh(rootSessionId)) return;
    const previousSnapshot = input.snapshot.value;
    input.snapshot.value = structuredClone(value);
    input.optimistic.value = [];

    const activeEdit = input.edit.value;
    if (activeEdit) {
      const previousItem = previousSnapshot?.items.find(
        (candidate) => candidate.queue_item_id === activeEdit.queue_item_id,
      );
      const item = value.items.find(
        (candidate) => candidate.queue_item_id === activeEdit.queue_item_id,
      );
      const desiredContent = input.draft.value.normalize("NFC");
      const committedEditIsAuthoritative = snapshotConfirmsCommittedEdit(
        previousItem,
        item,
        activeEdit,
        desiredContent,
      );
      if (committedEditIsAuthoritative) {
        editController?.controller.abort();
        editController = null;
        input.edit.value = null;
        input.editSaving.value = false;
        editToken = null;
        input.sendAsNew.value = false;
        input.draft.value = "";
        input.composerError.value = "";
        announce(`Updated queued message ${activeEdit.queue_sequence}.`);
        input.composerFocusEpoch.value += 1;
      } else if (
        !item ||
        item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
        item.item_digest !== activeEdit.item_digest
      ) {
        input.edit.value = null;
        input.editSaving.value = false;
        editToken = null;
        input.sendAsNew.value = true;
        input.composerError.value =
          "That queued message changed. Your replacement is still an unsent draft.";
        announce("Queued message changed. Replacement kept as an unsent draft.");
        input.composerFocusEpoch.value += 1;
      }
    }

    const saved = savedDrafts.get(rootSessionId);
    if (saved && input.draft.value === "") {
      savedDrafts.delete(rootSessionId);
      input.draft.value = saved.content;
      input.sendAsNew.value = saved.sendAsNew;
      if (saved.edit) {
        const item = value.items.find(
          (candidate) => candidate.queue_item_id === saved.edit?.queue_item_id,
        );
        if (
          item?.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED &&
          item.item_digest === saved.edit.item_digest
        ) {
          input.edit.value = structuredClone(saved.edit);
          announce(`Editing queued message ${saved.edit.queue_sequence}.`);
        } else if (
          snapshotConfirmsCommittedEdit(
            saved.editBaseline,
            item,
            saved.edit,
            saved.content.normalize("NFC"),
          )
        ) {
          input.draft.value = "";
          input.sendAsNew.value = false;
          input.composerError.value = "";
          announce(`Updated queued message ${saved.edit.queue_sequence}.`);
        } else {
          input.sendAsNew.value = true;
          input.composerError.value =
            "That queued message changed while you were away. Your replacement is an unsent draft.";
          announce("Queued message changed. Replacement kept as an unsent draft.");
          input.composerFocusEpoch.value += 1;
        }
      }
    }
    admissions.resumeRoot(rootSessionId);
  }

  function switchRoot(previousRootId: string | null, nextRootId: string | null): void {
    if (previousRootId && previousRootId !== nextRootId) {
      const currentEdit = input.edit.value;
      const editBaseline = currentEdit
        ? (input.snapshot.value?.items.find(
            (candidate) =>
              candidate.queue_item_id === currentEdit.queue_item_id &&
              candidate.item_digest === currentEdit.item_digest,
          ) ?? null)
        : null;
      savedDrafts.set(previousRootId, {
        content: input.draft.value,
        edit: currentEdit ? structuredClone(currentEdit) : null,
        editBaseline: editBaseline ? structuredClone(editBaseline) : null,
        sendAsNew: input.sendAsNew.value,
      });
      admissions.interruptRoot(previousRootId);
      if (editController?.root === previousRootId) editController.controller.abort();
    }
    input.snapshot.value = null;
    input.optimistic.value = [];
    input.edit.value = null;
    input.editSaving.value = false;
    input.sendAsNew.value = false;
    editController = null;
    editToken = null;
    input.draft.value = "";
  }

  function beginEdit(queueItemId?: string): boolean {
    const rootSessionId = input.activeRootId.value;
    if (!rootSessionId || input.draft.value !== "" || input.edit.value) return false;
    const latest = latestHomeEditableQueueItem(input.snapshot.value);
    if (!latest || (queueItemId && latest.queue_item_id !== queueItemId)) return false;
    input.edit.value = {
      root_session_id: rootSessionId,
      queue_item_id: latest.queue_item_id,
      item_digest: latest.item_digest,
      queue_sequence: latest.queue_sequence,
      target_participants: cloneHomeQueueTargets(latest.target_participants),
      quote_refs: structuredClone(latest.quote_refs),
      private_context_present: latest.private_context_present,
    };
    input.draft.value = latest.content;
    input.composerError.value = "";
    input.sendAsNew.value = false;
    announce(`Editing queued message ${latest.queue_sequence}.`);
    return true;
  }

  function cancelEdit(): boolean {
    if (!input.edit.value || input.editSaving.value) return false;
    input.edit.value = null;
    input.draft.value = "";
    input.sendAsNew.value = false;
    announce("Queued message edit canceled.");
    input.composerFocusEpoch.value += 1;
    return true;
  }

  async function saveEdit(): Promise<boolean> {
    const binding = input.edit.value;
    const content = input.draft.value.normalize("NFC");
    if (!binding || input.editSaving.value) return false;
    if (!content.trim()) {
      input.composerError.value = "A queued message cannot be empty.";
      return false;
    }
    const before = input.snapshot.value?.items.find(
      (item) => item.queue_item_id === binding.queue_item_id,
    );
    if (
      !before ||
      before.state !== CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
      before.item_digest !== binding.item_digest
    ) {
      input.edit.value = null;
      input.sendAsNew.value = true;
      input.composerError.value =
        "That queued message changed. Your replacement is still an unsent draft.";
      announce("Queued message changed. Replacement kept as an unsent draft.");
      input.composerFocusEpoch.value += 1;
      return false;
    }
    const command = commandFor(binding.root_session_id);
    const token = createHomeActionKey();
    editToken = token;
    input.editSaving.value = true;
    input.composerError.value = "";
    const controller = new AbortController();
    editController = { root: binding.root_session_id, token, controller };
    try {
      const item = await conversationHomeApi.editQueuedMessage(
        binding.root_session_id,
        binding.queue_item_id,
        {
          schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
          idempotency_key: `home-message-edit.${token}`.slice(0, 128),
          expected_item_digest: binding.item_digest,
          content,
        },
        controller.signal,
      );
      if (
        !current(command) ||
        controller.signal.aborted ||
        editToken !== token ||
        !sameHomeQueueEditBinding(input.edit.value, binding)
      )
        return false;
      if (!isHomeQueuedMessage(item) || !preservesHomeQueueEditAuthority(before, item, content))
        throw new Error("The queued message edit response changed immutable queue authority.");
      const currentSnapshot = input.snapshot.value;
      if (!currentSnapshot || currentSnapshot.root_session_id !== binding.root_session_id)
        return false;
      input.snapshot.value = mergeHomeQueuedMessage(currentSnapshot, item);
      input.edit.value = null;
      input.sendAsNew.value = false;
      if (input.draft.value === content) input.draft.value = "";
      announce(`Updated queued message ${binding.queue_sequence}.`);
      input.composerFocusEpoch.value += 1;
      return true;
    } catch (error) {
      if (!current(command) || controller.signal.aborted || editToken !== token) return false;
      if (matchesHomeQueueEditConflict(error, binding)) {
        input.edit.value = null;
        input.sendAsNew.value = true;
        input.composerError.value =
          "That queued message changed before the edit could save. Your replacement is an unsent draft; send it as new when ready.";
        announce("Edit lost the queue race. Replacement kept as an unsent draft.");
        input.composerFocusEpoch.value += 1;
        void input.refreshQueue().catch(() => undefined);
      } else input.composerError.value = readableHomeError(error);
      return false;
    } finally {
      if (editController?.controller === controller) editController = null;
      if (current(command) && editToken === token) {
        input.editSaving.value = false;
        editToken = null;
      }
    }
  }

  function goOffline(): void {
    const rootSessionId = input.activeRootId.value;
    if (!rootSessionId) return;
    const retainedForRetry = admissions.goOffline(rootSessionId);
    const interruptedEdit = input.editSaving.value;
    if (interruptedEdit) {
      editController?.controller.abort();
      input.editSaving.value = false;
      editToken = null;
      editController = null;
      input.sendAsNew.value = false;
    }
    announce(
      interruptedEdit
        ? "Connection lost. The queued edit remains bound and will reconcile before it can be sent as new."
        : retainedForRetry
          ? "Connection lost. Unacknowledged text remains in Message queue and will reconcile after refresh."
          : "Connection lost. Unacknowledged text remains an inert draft.",
    );
  }

  function dispose(): void {
    editController?.controller.abort();
    editController = null;
    admissions.dispose();
  }

  return {
    projections: admissions.projections,
    adoptSnapshot,
    switchRoot,
    enqueue: admissions.enqueue,
    retry: admissions.retry,
    restoreNeedsAction: admissions.restoreNeedsAction,
    dismissNeedsAction: admissions.dismissNeedsAction,
    beginEdit,
    cancelEdit,
    saveEdit,
    goOffline,
    dispose,
  };
}
