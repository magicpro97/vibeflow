import type { Ref } from "vue";

/** The composer state the Escape handling reads and writes (all lazily read). */
export interface HomeComposerSuggestionEscapeInput {
  readDraft(): string;
  writeDraft(value: string): void;
  textarea: Ref<HTMLTextAreaElement | null>;
  visibleSuggestionCount(): number;
  suggestionDraftSnapshot: Ref<string>;
  pendingEscapeDraft: Ref<string | null>;
  suggestionsDismissed: Ref<boolean>;
  resize(): void;
}

/**
 * Escape handling for the composer suggestion popover: the first Escape
 * preserves the draft the user was typing and dismisses the list; the next
 * Escape (before the draft changes) restores that preserved draft.
 */
export function useHomeComposerSuggestionEscape(input: HomeComposerSuggestionEscapeInput) {
  function restorePreservedDraft(preservedDraft: string) {
    if (input.readDraft() !== preservedDraft) input.writeDraft(preservedDraft);
    const element = input.textarea.value;
    if (element && element.value !== preservedDraft) {
      element.value = preservedDraft;
      element.setSelectionRange(preservedDraft.length, preservedDraft.length);
      input.resize();
    }
  }

  function dismissSuggestionsWithEscape(event: KeyboardEvent): boolean {
    if (event.key !== "Escape" || !input.visibleSuggestionCount()) return false;
    const preservedDraft = input.suggestionDraftSnapshot.value.length
      ? input.suggestionDraftSnapshot.value
      : input.readDraft();
    input.pendingEscapeDraft.value = preservedDraft;
    input.suggestionsDismissed.value = true;
    restorePreservedDraft(preservedDraft);
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function restoreDismissedDraft(event: KeyboardEvent) {
    if (event.key !== "Escape" || input.pendingEscapeDraft.value === null) return;
    restorePreservedDraft(input.pendingEscapeDraft.value);
    input.pendingEscapeDraft.value = null;
    event.preventDefault();
    event.stopPropagation();
  }

  return { dismissSuggestionsWithEscape, restoreDismissedDraft };
}
