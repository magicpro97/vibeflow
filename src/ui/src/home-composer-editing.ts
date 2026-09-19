import {
  type ComposerCaretRemoval,
  removeComposerMentionAtCaret,
} from "./home-composer-highlight.js";

export function removeMentionAtKey(
  event: KeyboardEvent,
  draft: string,
  element: Pick<HTMLTextAreaElement, "selectionStart" | "selectionEnd"> | null,
): ComposerCaretRemoval | null {
  if (
    (event.key !== "Backspace" && event.key !== "Delete") ||
    !element ||
    element.selectionStart !== element.selectionEnd
  )
    return null;
  const removal = removeComposerMentionAtCaret(
    draft,
    element.selectionStart,
    event.key === "Backspace" ? "backward" : "forward",
  );
  if (!removal) return null;
  event.preventDefault();
  return removal;
}
