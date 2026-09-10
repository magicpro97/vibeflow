import { ref } from "vue";
import type { Engine } from "../../core/agent-contract.js";
import { api } from "./api.js";

/** Shared attachment chip state for the composer: the toolbar attach
 * button uploads into it and the chip row renders from it. Removing a
 * chip deletes the uploaded file too, so the next dispatch's attachment
 * sync never re-attaches a discarded file. */
const attachmentNames = ref<string[]>([]);
const attachmentEngine = ref<Engine | null>(null);

export function getHomeAttachmentEngine(): Engine | null {
  return attachmentEngine.value;
}

export function setHomeAttachmentEngine(engine: Engine): void {
  attachmentEngine.value = engine;
}
export function useHomeAttachments() {
  function add(name: string): void {
    attachmentNames.value.push(name);
  }
  async function remove(
    name: string,
    deleter: (name: string) => Promise<unknown> = api.deleteAttachment,
  ): Promise<void> {
    attachmentNames.value = attachmentNames.value.filter((n) => n !== name);
    if (!attachmentNames.value.length) attachmentEngine.value = null;
    await deleter(name).catch(() => {
      // Keep the chip removed even if the server file lingers; the next
      // removal attempt still retries the delete.
    });
  }
  return { attachmentNames, add, remove };
}
