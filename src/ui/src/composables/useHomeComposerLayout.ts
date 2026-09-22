import { type Ref, computed } from "vue";

export function useHomeComposerLayout(textarea: Ref<HTMLTextAreaElement | null>) {
  function syncHighlightScroll() {
    const element = textarea.value;
    if (!element) return;
    const overlay = document.querySelector<HTMLElement>(".home-composer__highlight");
    if (overlay) overlay.scrollTop = element.scrollTop;
  }
  const suggestionStyle = computed(() => {
    const rect = textarea.value?.getBoundingClientRect();
    return rect
      ? {
          top: `${rect.top}px`,
          left: `${rect.left}px`,
          width: `${rect.width}px`,
          transform: "translateY(-100%) translateY(-0.35rem)",
        }
      : null;
  });
  return { suggestionStyle, syncHighlightScroll };
}
