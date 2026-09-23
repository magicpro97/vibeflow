/**
 * The composer draft's lifecycle around a send: what an admitted message clears, and what a
 * refused one puts back.
 *
 * Split out of `conversation-home-command-runtime` (which sits at its file-size ceiling) because
 * it is pure draft/quote/private-context bookkeeping: it knows nothing about the transport that
 * admitted or refused the message, so any admission path can share it.
 */
import type { Ref } from "vue";
import { sameHomeQuoteRef } from "./conversation-home-authoring.js";
import type { HomePrivateContextCapture } from "./conversation-home-private-context-types.js";
import type { HomeQuoteReference } from "./conversation-home-types.js";

/** The composer state a submitted send has to be able to clear or restore. */
export interface HomeComposerDraftScope {
  draft: Ref<string>;
  quoteRefs: Ref<HomeQuoteReference[]>;
  privateContext: { present(): boolean };
}

export function createHomeComposerDraftLifecycle(scope: HomeComposerDraftScope) {
  const sameQuoteSelection = (
    left: readonly HomeQuoteReference[],
    right: readonly HomeQuoteReference[],
  ): boolean =>
    left.length === right.length &&
    left.every((item, index) => {
      const candidate = right[index];
      return candidate ? sameHomeQuoteRef(item, candidate) : false;
    });

  /** Clear exactly what this send consumed, and only while the composer still holds it. */
  const clearSubmittedComposer = (
    draft: string,
    quoteRefs: readonly HomeQuoteReference[],
    privateContext: HomePrivateContextCapture | null,
  ) => {
    if (scope.draft.value === draft) scope.draft.value = "";
    if (sameQuoteSelection(scope.quoteRefs.value, quoteRefs)) scope.quoteRefs.value = [];
    privateContext?.clearIfCurrent();
  };

  /** Put a refused send's draft, quotes, and private context back, never over newer input. */
  const restoreSubmittedComposer = (
    draft: string,
    quoteRefs: readonly HomeQuoteReference[],
    privateContext: HomePrivateContextCapture | null,
  ): boolean => {
    if (
      scope.draft.value !== "" ||
      scope.quoteRefs.value.length > 0 ||
      scope.privateContext.present()
    )
      return false;
    if (privateContext && !privateContext.restoreIfVacant()) return false;
    scope.draft.value = draft;
    scope.quoteRefs.value = quoteRefs.map((reference) => structuredClone(reference));
    return true;
  };

  /** A typed action consumes the draft without quoting or private context. */
  const clearSubmittedDraft = (draft: string) => {
    if (scope.draft.value === draft) scope.draft.value = "";
  };

  return { clearSubmittedComposer, restoreSubmittedComposer, clearSubmittedDraft };
}
