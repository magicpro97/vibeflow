import { computed } from "vue";
import { conversationHomeApi } from "./conversation-home-api.js";
import {
  type HomeQueueAdmissionEntry,
  type HomeQueueAdmissionRuntimeInput,
  type HomeQueueAdmissionSnapshot,
  createHomeQueueAdmissionEntry,
  homeQueueFailureRecoveryAction,
  isHomeQueueFailureRetryable,
  mergeHomeQueuedMessage,
  projectHomeQueuedMessages,
} from "./conversation-home-message-queue-authority.js";
import { HomeMessageQueueClientLanes } from "./conversation-home-message-queue-client-lanes.js";
import { createHomeQueueFailureProjections } from "./conversation-home-message-queue-failure-projections.js";
import { HomeMessageQueueInterruptedAdmissions } from "./conversation-home-message-queue-interrupted-admissions.js";
import { HomeMessageQueueTransportSequencer } from "./conversation-home-message-queue-transport-sequencer.js";
import type {
  HomeMessageQueueSnapshot,
  HomeOptimisticQueuedMessage,
  HomeQueuedMessage,
} from "./conversation-home-message-queue-types.js";
import { HOME_QUEUED_MESSAGE_PROJECTION_KIND } from "./conversation-home-message-queue-types.js";
import { readableHomeError } from "./conversation-home-runtime.js";

export type { HomeQueueAdmissionSnapshot } from "./conversation-home-message-queue-authority.js";
export function createHomeMessageQueueAdmissionRuntime(input: HomeQueueAdmissionRuntimeInput) {
  const active = new Map<string, HomeQueueAdmissionEntry>();
  const interrupted = new HomeMessageQueueInterruptedAdmissions<HomeQueueAdmissionEntry>();
  const failures = createHomeQueueFailureProjections(input.retryable, input.needsAction);
  const refreshDeferred = new Set<string>();
  const transportSequencer = new HomeMessageQueueTransportSequencer();
  const clientLanes = new HomeMessageQueueClientLanes();
  let composerErrorLease: { owner: string; expected: string } | null = null;
  const stopOnlineWatch = interrupted.watchOffline(input.online, input.activeRootId, interruptRoot);

  const isCurrent = (entry: HomeQueueAdmissionEntry): boolean =>
    input.activation.isGenerationCurrent(entry.generation) &&
    input.activeRootId.value === entry.root;
  const rootHasActive = (root: string): boolean =>
    [...active.values()].some((entry) => entry.root === root);
  const hasLaterAdmission = (entry: HomeQueueAdmissionEntry): boolean =>
    [...active.values(), ...interrupted.list(entry.root)].some(
      (candidate) =>
        candidate.root === entry.root &&
        candidate.projection.client_order > entry.projection.client_order,
    );
  const removeOptimistic = (projectionKey: string) => {
    input.optimistic.value = input.optimistic.value.filter(
      (item) => item.projection_key !== projectionKey,
    );
  };
  const ownsComposerError = (entry: HomeQueueAdmissionEntry): boolean => {
    const lease = composerErrorLease;
    if (!lease || lease.owner !== entry.projection.projection_key) return false;
    if (input.composerError.value === lease.expected) return true;
    composerErrorLease = null;
    return false;
  };
  const claimComposerError = (entry: HomeQueueAdmissionEntry) => {
    input.composerError.value = "";
    composerErrorLease = { owner: entry.projection.projection_key, expected: "" };
  };
  const setOwnedComposerError = (entry: HomeQueueAdmissionEntry, message: string): boolean => {
    if (!ownsComposerError(entry)) return false;
    input.composerError.value = message;
    composerErrorLease = { owner: entry.projection.projection_key, expected: message };
    return true;
  };
  const releaseComposerError = (entry: HomeQueueAdmissionEntry) => {
    if (ownsComposerError(entry)) composerErrorLease = null;
  };
  const setUnownedComposerError = (message: string) => {
    composerErrorLease = null;
    input.composerError.value = message;
  };
  const projections = computed(() =>
    projectHomeQueuedMessages({
      snapshot: input.snapshot.value,
      optimistic: input.optimistic.value,
      retryable: input.retryable.value,
      needsAction: input.needsAction.value,
      activeRootId: input.activeRootId.value,
    }),
  );

  function makeEntry(root: string, admission: HomeQueueAdmissionSnapshot): HomeQueueAdmissionEntry {
    const lane = clientLanes.allocate(root);
    return createHomeQueueAdmissionEntry({
      root,
      generation: input.activation.captureGeneration(),
      authorityDigest: input.snapshot.value?.current_authority_digest ?? "",
      ...lane,
      admission,
    });
  }

  async function transport(entry: HomeQueueAdmissionEntry): Promise<boolean> {
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
      if (!input.online.value) interrupted.invalidate(entry.root);
      if (!isCurrent(entry) || entry.controller.signal.aborted) return false;
      const currentSnapshot = input.snapshot.value;
      if (!currentSnapshot || currentSnapshot.root_session_id !== entry.root) return false;
      input.snapshot.value = mergeHomeQueuedMessage(currentSnapshot, item);
      removeOptimistic(entry.projection.projection_key);
      failures.removeRetryable(entry.projection.projection_key);
      failures.removeNeedsAction(entry.projection.projection_key);
      releaseComposerError(entry);
      input.announcement.value = `Queued message ${item.queue_sequence}.`;
      return true;
    } catch (error) {
      if (!isCurrent(entry) || entry.controller.signal.aborted) return false;
      clientLanes.rotateAfterFailure(entry, active.values());
      removeOptimistic(entry.projection.projection_key);
      const failureMessage = readableHomeError(error);
      setOwnedComposerError(entry, failureMessage);
      if (!hasLaterAdmission(entry) && entry.admission.restoreIfVacant()) {
        failures.removeRetryable(entry.projection.projection_key);
        failures.removeNeedsAction(entry.projection.projection_key);
        input.announcement.value = "Message was not queued. Draft restored to the composer.";
      } else if (isHomeQueueFailureRetryable(error)) {
        failures.retainRetryable(entry, failureMessage);
        input.announcement.value =
          "Message was not queued. It remains in Message queue for an explicit retry.";
      } else {
        failures.retainNeedsAction(entry, failureMessage, homeQueueFailureRecoveryAction(error));
        setOwnedComposerError(entry, "");
        releaseComposerError(entry);
        input.announcement.value =
          "Message was not queued. Its exact payload needs an explicit recovery choice.";
      }
      return false;
    } finally {
      if (active.get(entry.request.idempotency_key) === entry)
        active.delete(entry.request.idempotency_key);
      if (isCurrent(entry) && !rootHasActive(entry.root) && refreshDeferred.delete(entry.root))
        void input.refreshQueue().catch(() => undefined);
    }
  }

  function scheduleTransport(entry: HomeQueueAdmissionEntry, visible: boolean): Promise<boolean> {
    active.set(entry.request.idempotency_key, entry);
    if (visible) input.optimistic.value = [...input.optimistic.value, entry.projection];
    const run = () =>
      entry.controller.signal.aborted || active.get(entry.request.idempotency_key) !== entry
        ? Promise.resolve(false)
        : transport(entry);
    return transportSequencer.schedule(entry.root, run);
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
    input.setSendAsNew(false);
    admission.clearIfCurrent();
    return scheduleTransport(entry, true);
  }

  async function retry(projectionKey: string): Promise<boolean> {
    const prior = failures.retryableEntry(projectionKey);
    const root = input.activeRootId.value;
    if (!prior || !root || prior.root !== root || input.snapshot.value?.root_session_id !== root)
      return false;
    if (!input.online.value) {
      const failureMessage = "Reconnect before retrying this queued message.";
      setOwnedComposerError(prior, failureMessage);
      failures.retainRetryable(prior, failureMessage);
      input.announcement.value = failureMessage;
      return false;
    }
    if (active.has(prior.request.idempotency_key)) return false;
    const entry: HomeQueueAdmissionEntry = {
      ...prior,
      generation: input.activation.captureGeneration(),
      controller: new AbortController(),
    };
    setOwnedComposerError(entry, "");
    failures.retainRetryable(entry, "Retrying the exact queued message request.", true);
    const succeeded = await scheduleTransport(entry, false);
    if (succeeded && interrupted.releaseBlocker(root, entry.request.idempotency_key))
      resumeRoot(root);
    return succeeded;
  }

  function releaseInterruptedBlocker(entry: HomeQueueAdmissionEntry): void {
    if (!interrupted.releaseBlocker(entry.root, entry.request.idempotency_key)) return;
    clientLanes.rebindAfterAbandonment(entry, interrupted.list(entry.root));
    resumeRoot(entry.root);
  }

  function restoreNeedsAction(projectionKey: string, sendAsNew = false): boolean {
    const entry = failures.needsActionEntry(projectionKey);
    const root = input.activeRootId.value;
    if (!entry || !root || entry.root !== root || active.has(entry.request.idempotency_key))
      return false;
    if (!entry.admission.restoreIfVacant()) {
      input.announcement.value =
        "Keep the newer composer draft, quotes, or private context before restoring this message.";
      return false;
    }
    failures.removeNeedsAction(projectionKey);
    setOwnedComposerError(entry, "");
    releaseComposerError(entry);
    releaseInterruptedBlocker(entry);
    input.setSendAsNew(sendAsNew);
    input.focusComposer();
    input.announcement.value = "Failed message restored to the composer for editing.";
    return true;
  }

  async function dismissNeedsAction(projectionKey: string): Promise<boolean> {
    const entry = failures.needsActionEntry(projectionKey);
    const root = input.activeRootId.value;
    if (!entry || !root || entry.root !== root || active.has(entry.request.idempotency_key))
      return false;
    try {
      if (!(await entry.admission.discardRetained())) {
        input.announcement.value =
          "Private context cleanup was not confirmed. The failed message remains unsent.";
        return false;
      }
    } catch {
      input.announcement.value =
        "Private context cleanup failed. The failed message remains available for recovery.";
      return false;
    }
    if (
      failures.needsActionEntry(projectionKey) !== entry ||
      input.activeRootId.value !== root ||
      active.has(entry.request.idempotency_key)
    )
      return false;
    failures.removeNeedsAction(projectionKey);
    setOwnedComposerError(entry, "");
    releaseComposerError(entry);
    releaseInterruptedBlocker(entry);
    input.announcement.value = "Failed message dismissed without sending.";
    return true;
  }

  function deferRefresh(root: string): boolean {
    if (!rootHasActive(root)) return false;
    refreshDeferred.add(root);
    return true;
  }

  function interruptRoot(root: string): void {
    interrupted.invalidate(root);
    const saved: HomeQueueAdmissionEntry[] = [];
    for (const [key, entry] of active) {
      if (entry.root !== root) continue;
      entry.controller.abort();
      active.delete(key);
      removeOptimistic(entry.projection.projection_key);
      saved.push(entry);
    }
    interrupted.retain(
      root,
      saved,
      (left, right) => left.projection.client_order - right.projection.client_order,
    );
    refreshDeferred.delete(root);
    transportSequencer.detach(root);
  }

  function resumeRoot(root: string): void {
    const pendingCount = interrupted.count(root);
    if (
      !pendingCount ||
      interrupted.blockedBy(root) ||
      !input.online.value ||
      input.activeRootId.value !== root
    )
      return;
    const resumeEpoch = interrupted.begin(root);
    input.announcement.value = `Reconciling ${pendingCount} interrupted message${pendingCount === 1 ? "" : "s"}.`;
    const prior = interrupted.claim(root);
    if (!prior) return;
    const entry: HomeQueueAdmissionEntry = {
      ...prior,
      generation: input.activation.captureGeneration(),
      controller: new AbortController(),
    };
    failures.retainRetryable(entry, "Reconciling the exact interrupted queue request.", true);
    void scheduleTransport(entry, false).then((succeeded) => {
      if (!succeeded) {
        if (
          interrupted.epoch(root) !== resumeEpoch ||
          input.activeRootId.value !== root ||
          !input.online.value
        )
          return;
        if (
          failures.hasRetryable(entry.projection.projection_key) ||
          failures.hasNeedsAction(entry.projection.projection_key)
        )
          interrupted.block(root, entry.request.idempotency_key);
        return;
      }
      if (
        interrupted.epoch(root) === resumeEpoch &&
        input.activeRootId.value === root &&
        input.online.value
      )
        resumeRoot(root);
    });
  }
  function goOffline(root: string): boolean {
    interruptRoot(root);
    const retained = interrupted.list(root);
    clientLanes.rotateAfterOfflineInterruption(root, retained.length);
    for (const entry of retained) {
      failures.retainRetryable(
        entry,
        "Connection lost before queue admission was confirmed. The exact request will reconcile after refresh.",
        true,
      );
    }
    refreshDeferred.delete(root);
    transportSequencer.detach(root);
    return retained.length > 0;
  }

  function dispose(): void {
    stopOnlineWatch();
    for (const entry of active.values()) entry.controller.abort();
    active.clear();
    interrupted.clear();
    failures.clear();
    refreshDeferred.clear();
    transportSequencer.clear();
    clientLanes.clear();
    composerErrorLease = null;
  }

  return {
    projections,
    enqueue,
    retry,
    restoreNeedsAction,
    dismissNeedsAction,
    deferRefresh,
    interruptRoot,
    resumeRoot,
    goOffline,
    dispose,
  };
}
