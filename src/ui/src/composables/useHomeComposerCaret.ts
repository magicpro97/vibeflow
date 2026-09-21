import { type Ref, ref } from "vue";
import { composerMentionAtCaret } from "../home-composer-highlight.js";

export function useHomeComposerCaret(
  textarea: Ref<HTMLTextAreaElement | null>,
  draft: () => string,
) {
  const caretOffset = ref<number | null>(null);
  function syncNativeCaret() {
    const element = textarea.value;
    if (!element) return;
    const hidden =
      caretOffset.value !== null && composerMentionAtCaret(draft(), caretOffset.value) !== null;
    element.style.setProperty("caret-color", hidden ? "transparent" : "var(--home-ink)");
  }
  function syncCaretOffset() {
    caretOffset.value = textarea.value?.selectionStart ?? null;
    syncNativeCaret();
  }
  function setCaretOffset(offset: number) {
    caretOffset.value = offset;
    syncNativeCaret();
  }
  return { caretOffset, setCaretOffset, syncCaretOffset };
}
