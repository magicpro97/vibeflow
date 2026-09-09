import { ref } from "vue";

/** Shared attachment chip state for the composer: the toolbar attach
 * button uploads into it and the chip row renders from it. */
const attachmentNames = ref<string[]>([]);

export function useHomeAttachments() {
  function add(name: string): void {
    attachmentNames.value.push(name);
  }
  function remove(name: string): void {
    attachmentNames.value = attachmentNames.value.filter((n) => n !== name);
  }
  return { attachmentNames, add, remove };
}
