import type { Ref } from "vue";
import { conversationHomeApi } from "./conversation-home-api.js";
import { assertHomePrivateContextPresence } from "./conversation-home-private-context-authority.js";
import type {
  HomeDiscardDraftPrivateContextRequest,
  HomeDiscardMessagePrivateContextRequest,
  HomePrivateContextCapture,
  HomePrivateRangeSelectionRequest,
} from "./conversation-home-private-context-types.js";
import { createHomeActionKey, readableHomeError } from "./conversation-home-runtime.js";

type PrivateContextScope = { kind: "draft" } | { kind: "message"; root_session_id: string };

interface PrivateContextSelection {
  scope: PrivateContextScope;
  command_key: string;
}

interface PrivateContextDiscardTask {
  selection: PrivateContextSelection;
  idempotency_key: string;
  running: Promise<boolean> | null;
}

interface HomePrivateContextRuntimeInput {
  activeRootId: Ref<string | null>;
  online: Ref<boolean>;
  present: Ref<boolean>;
  discardBusy: Ref<boolean>;
  composerError: Ref<string>;
  announcement: Ref<string>;
  composerFocusEpoch: Ref<number>;
}

const scopeKey = (scope: PrivateContextScope): string =>
  scope.kind === "draft" ? "draft" : `message:${scope.root_session_id}`;

const sameSelection = (
  left: PrivateContextSelection | undefined,
  right: PrivateContextSelection,
): boolean =>
  left?.command_key === right.command_key && scopeKey(left.scope) === scopeKey(right.scope);

const messageKey = () => `home-message.${createHomeActionKey()}`.slice(0, 128);
const createKey = () => `home-create.${createHomeActionKey()}`.slice(0, 128);
const discardKey = () => `home-private-discard.${createHomeActionKey()}`.slice(0, 128);

export function createHomePrivateContextRuntime(input: HomePrivateContextRuntimeInput) {
  const selections = new Map<string, PrivateContextSelection>();
  const latestStages = new Map<string, string>();
  const pendingDiscards = new Map<string, PrivateContextDiscardTask>();
  let disposed = false;

  const activeScope = (): PrivateContextScope =>
    input.activeRootId.value
      ? { kind: "message", root_session_id: input.activeRootId.value }
      : { kind: "draft" };
  const syncProjection = () => {
    if (!disposed) input.present.value = selections.has(scopeKey(activeScope()));
  };
  const exactReplay = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return operation();
    }
  };

  async function transportDiscard(task: PrivateContextDiscardTask): Promise<boolean> {
    if (task.running) return task.running;
    const operation = async () => {
      const selection = task.selection;
      const response = await exactReplay(() =>
        selection.scope.kind === "message"
          ? conversationHomeApi.discardMessagePrivateContext(selection.scope.root_session_id, {
              schema_version: "1.0",
              idempotency_key: task.idempotency_key,
              enqueue_idempotency_key: selection.command_key,
              expected_private_context_present: true,
            } satisfies HomeDiscardMessagePrivateContextRequest)
          : conversationHomeApi.discardDraftPrivateContext({
              schema_version: "1.0",
              idempotency_key: task.idempotency_key,
              create_idempotency_key: selection.command_key,
              expected_private_context_present: true,
            } satisfies HomeDiscardDraftPrivateContextRequest),
      );
      assertHomePrivateContextPresence(response, false);
      const key = scopeKey(selection.scope);
      if (sameSelection(selections.get(key), selection)) selections.delete(key);
      pendingDiscards.delete(`${key}\0${selection.command_key}`);
      syncProjection();
      return true;
    };
    task.running = operation().finally(() => {
      task.running = null;
    });
    return task.running;
  }

  function discardTask(selection: PrivateContextSelection): PrivateContextDiscardTask {
    const key = `${scopeKey(selection.scope)}\0${selection.command_key}`;
    const existing = pendingDiscards.get(key);
    if (existing) return existing;
    const task: PrivateContextDiscardTask = {
      selection,
      idempotency_key: discardKey(),
      running: null,
    };
    pendingDiscards.set(key, task);
    return task;
  }

  function discardReplaced(selection: PrivateContextSelection): void {
    void transportDiscard(discardTask(selection)).catch((error) => {
      if (disposed || scopeKey(activeScope()) !== scopeKey(selection.scope)) return;
      input.announcement.value =
        "The replacement is ready. Cleanup of the previous private context will retry safely.";
      input.composerError.value = readableHomeError(error);
    });
  }

  async function retryPendingForScope(scope: PrivateContextScope): Promise<void> {
    const key = scopeKey(scope);
    for (const task of pendingDiscards.values()) {
      if (scopeKey(task.selection.scope) !== key) continue;
      try {
        await transportDiscard(task);
      } catch {
        // The exact task and idempotency key remain available for a later retry.
      }
    }
  }

  async function stage(
    selectionRequest: HomePrivateRangeSelectionRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!input.online.value) throw new Error("Reconnect before staging a private file range.");
    const scope = activeScope();
    const key = scopeKey(scope);
    const stageToken = createHomeActionKey();
    const commandKey = scope.kind === "message" ? messageKey() : createKey();
    latestStages.set(key, stageToken);
    void retryPendingForScope(scope);
    const response = await exactReplay(() =>
      scope.kind === "message"
        ? conversationHomeApi.stageMessagePrivateContext(
            scope.root_session_id,
            {
              schema_version: "1.0",
              enqueue_idempotency_key: commandKey,
              source_kind: "private-file-range",
              ...selectionRequest,
            },
            signal,
          )
        : conversationHomeApi.stageDraftPrivateContext(
            {
              schema_version: "1.0",
              create_idempotency_key: commandKey,
              source_kind: "private-file-range",
              ...selectionRequest,
            },
            signal,
          ),
    );
    assertHomePrivateContextPresence(response, true);
    const next: PrivateContextSelection = { scope, command_key: commandKey };
    if (disposed || latestStages.get(key) !== stageToken) {
      discardReplaced(next);
      return false;
    }
    const previous = selections.get(key);
    selections.set(key, next);
    syncProjection();
    if (previous && !sameSelection(previous, next)) discardReplaced(previous);
    return scopeKey(activeScope()) === key;
  }

  async function discardCurrent(): Promise<boolean> {
    const scope = activeScope();
    const selected = selections.get(scopeKey(scope));
    if (!selected || input.discardBusy.value) return false;
    if (!input.online.value) {
      input.composerError.value = "Reconnect before removing this private context.";
      return false;
    }
    input.discardBusy.value = true;
    input.composerError.value = "";
    try {
      const removed = await transportDiscard(discardTask(selected));
      if (removed && scopeKey(activeScope()) === scopeKey(scope)) {
        input.announcement.value = "Private context removed.";
        input.composerFocusEpoch.value += 1;
      }
      return removed;
    } catch (error) {
      if (scopeKey(activeScope()) === scopeKey(scope)) {
        input.composerError.value = readableHomeError(error);
        input.announcement.value = "Private context was not removed. The selection is unchanged.";
      }
      return false;
    } finally {
      if (scopeKey(activeScope()) === scopeKey(scope)) input.discardBusy.value = false;
    }
  }

  function capture(scope: PrivateContextScope): HomePrivateContextCapture | null {
    const selected = selections.get(scopeKey(scope));
    if (!selected) return null;
    return Object.freeze({
      idempotency_key: selected.command_key,
      private_context_present: true as const,
      clearIfCurrent() {
        const key = scopeKey(selected.scope);
        if (sameSelection(selections.get(key), selected)) selections.delete(key);
        syncProjection();
      },
      restoreIfVacant() {
        const key = scopeKey(selected.scope);
        if (selections.has(key)) return false;
        selections.set(key, selected);
        syncProjection();
        return true;
      },
    });
  }

  function captureForMessage(rootSessionId: string): HomePrivateContextCapture | null {
    return capture({ kind: "message", root_session_id: rootSessionId });
  }

  function captureForCreate(): HomePrivateContextCapture | null {
    return capture({ kind: "draft" });
  }

  function switchRoot(): void {
    input.discardBusy.value = false;
    syncProjection();
    void retryPendingForScope(activeScope());
  }

  function dispose(): void {
    disposed = true;
    latestStages.clear();
    pendingDiscards.clear();
    selections.clear();
    input.present.value = false;
  }

  syncProjection();
  return {
    stage,
    discardCurrent,
    captureForMessage,
    captureForCreate,
    switchRoot,
    dispose,
  };
}
