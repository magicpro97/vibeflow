import { type Ref, nextTick, onScopeDispose, reactive, ref, toRef, watch } from "vue";
import { api } from "../api.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import type { HomePrivateFileRangeBinding } from "../conversation-home-types.js";

interface HomePrivateRangeComposerOptions {
  activeRootId?: Ref<string | null>;
  composerEpoch?: Ref<number>;
  privateFileRange: Ref<HomePrivateFileRangeBinding | null>;
  setPrivateFileRange(binding: HomePrivateFileRangeBinding): void;
}

interface FocusableInput {
  focus(): void;
  isConnected?: boolean;
}

export function useHomePrivateRangeComposer(options: HomePrivateRangeComposerOptions) {
  const store = options.activeRootId && options.composerEpoch ? null : useConversationHomeStore();
  const fallbackRootId = ref<string | null>(null);
  const fallbackComposerEpoch = ref(0);
  const privatePathInput = ref<FocusableInput | null>(null);
  const privateRangeOpen = ref(false);
  const privateRangeBusy = ref(false);
  const privateRangeError = ref("");
  const activeRootId =
    options.activeRootId ?? (store ? toRef(store, "activeRootId") : fallbackRootId);
  const composerEpoch =
    options.composerEpoch ?? (store ? toRef(store, "composerEpoch") : fallbackComposerEpoch);
  let stageGeneration = 0;
  let stageAbortController: AbortController | null = null;
  let restorePrivateRangeFocus: FocusableInput | null = null;
  const privateRangeDraft = reactive({
    path: "",
    startLine: "",
    endLine: "",
  });

  const abortPrivateRangeStage = () => {
    stageAbortController?.abort();
    stageAbortController = null;
  };

  watch(
    options.privateFileRange,
    (binding) => {
      if (!binding) return;
      privateRangeDraft.path = binding.repo_relative_path;
      privateRangeDraft.startLine = String(binding.start_line);
      privateRangeDraft.endLine = String(binding.end_line);
    },
    { immediate: true },
  );
  watch(
    [activeRootId, composerEpoch],
    () => {
      const wasOpen = privateRangeOpen.value;
      const focusTarget = restorePrivateRangeFocus;
      stageGeneration += 1;
      abortPrivateRangeStage();
      privateRangeBusy.value = false;
      privateRangeOpen.value = false;
      restorePrivateRangeFocus = null;
      resetPrivateRangeForm();
      if (wasOpen)
        nextTick(() => {
          if (focusTarget && focusTarget.isConnected !== false) focusTarget.focus();
          else {
            const environment = globalThis as unknown as {
              document?: { querySelector(selector: string): FocusableInput | null };
            };
            environment.document?.querySelector("#home-composer")?.focus();
          }
        });
    },
    { flush: "sync" },
  );
  onScopeDispose(() => {
    stageGeneration += 1;
    abortPrivateRangeStage();
    privateRangeBusy.value = false;
    restorePrivateRangeFocus = null;
  });

  const resetPrivateRangeForm = () => {
    const binding = options.privateFileRange.value;
    if (binding) {
      privateRangeDraft.path = binding.repo_relative_path;
      privateRangeDraft.startLine = String(binding.start_line);
      privateRangeDraft.endLine = String(binding.end_line);
    } else {
      privateRangeDraft.path = "";
      privateRangeDraft.startLine = "";
      privateRangeDraft.endLine = "";
    }
    privateRangeError.value = "";
  };

  const restorePanelFocus = () => {
    const target = restorePrivateRangeFocus;
    restorePrivateRangeFocus = null;
    nextTick(() => target?.focus());
  };

  const closePrivateRangePanel = () => {
    privateRangeOpen.value = false;
    privateRangeError.value = "";
    restorePanelFocus();
  };

  const openPrivateRangePanel = (reset = false) => {
    if (!privateRangeOpen.value) {
      const environment = globalThis as typeof globalThis & {
        document?: { activeElement?: Partial<FocusableInput> | null };
      };
      const activeElement = environment.document?.activeElement;
      restorePrivateRangeFocus =
        activeElement && typeof activeElement.focus === "function"
          ? (activeElement as FocusableInput)
          : null;
    }
    if (!privateRangeOpen.value || reset) resetPrivateRangeForm();
    privateRangeOpen.value = true;
    nextTick(() => privatePathInput.value?.focus());
  };

  const requirePositiveLine = (value: string | number, field: "start" | "end"): number | null => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) {
      privateRangeError.value = `Enter a ${field} line number.`;
      return null;
    }
    const line = Number(trimmed);
    if (!Number.isSafeInteger(line) || line < 1) {
      privateRangeError.value = `${field === "start" ? "Start" : "End"} line must be a whole number above 0.`;
      return null;
    }
    return line;
  };

  const readablePrivateRangeError = (error: unknown): string => {
    const detail = error instanceof Error ? error.message : "";
    switch (detail) {
      case "forbidden":
        return "Choose a repo-relative path inside this workspace.";
      case "not_found":
        return "That file could not be found from the current repo root.";
      case "too_large":
        return "Choose a smaller file. Home private ranges reject oversized files.";
      case "binary":
        return "Choose a text file so VibeFlow can stage an exact excerpt.";
      case "changed":
        return "That file changed while VibeFlow was reading it. Retry the selection.";
      case "invalid_range":
        return "Those line numbers run past the end of the file.";
      case "invalid_request":
        return "Check the path and line numbers, then try again.";
      default:
        return detail || "VibeFlow could not stage that private file range.";
    }
  };

  const stagePrivateRange = async () => {
    privateRangeError.value = "";
    const path = privateRangeDraft.path.trim();
    if (!path) {
      privateRangeError.value = "Enter a repo-relative path.";
      return;
    }
    const startLine = requirePositiveLine(privateRangeDraft.startLine, "start");
    if (startLine === null) return;
    const endLine = requirePositiveLine(privateRangeDraft.endLine, "end");
    if (endLine === null) return;
    if (endLine < startLine) {
      privateRangeError.value = "End line must be greater than or equal to the start line.";
      return;
    }
    const requestGeneration = ++stageGeneration;
    const rootSessionId = activeRootId.value;
    const requestEpoch = composerEpoch.value;
    const controller = new AbortController();
    stageAbortController = controller;
    privateRangeBusy.value = true;
    try {
      const binding = await api.stagePrivateFileRange(path, startLine, endLine, controller.signal);
      if (
        requestGeneration !== stageGeneration ||
        activeRootId.value !== rootSessionId ||
        composerEpoch.value !== requestEpoch
      )
        return;
      options.setPrivateFileRange(binding);
      closePrivateRangePanel();
    } catch (error) {
      if (
        requestGeneration !== stageGeneration ||
        activeRootId.value !== rootSessionId ||
        composerEpoch.value !== requestEpoch
      )
        return;
      privateRangeError.value = readablePrivateRangeError(error);
    } finally {
      if (stageAbortController === controller) stageAbortController = null;
      if (requestGeneration === stageGeneration) privateRangeBusy.value = false;
    }
  };

  return {
    privatePathInput,
    privateRangeOpen,
    privateRangeBusy,
    privateRangeError,
    privateRangeDraft,
    resetPrivateRangeForm,
    closePrivateRangePanel,
    openPrivateRangePanel,
    stagePrivateRange,
  };
}
