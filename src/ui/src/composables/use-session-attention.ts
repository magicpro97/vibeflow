import { ref, watch } from "vue";
import {
  clearAttention,
  mergeAttention,
  readAttention,
  writeAttention,
} from "../lib/session-attention.js";
import type { AttentionFacts } from "../lib/session-attention.js";

/** Tracks per-session attention marks; persistence is localStorage with defensive fallbacks. */
export function useSessionAttention(input: {
  sessions: () => readonly AttentionFacts[];
  activeRootId: () => string | null;
  storage?: Pick<Storage, "getItem" | "setItem">;
}) {
  const storage = input.storage ?? window.localStorage;
  const attention = ref<Record<string, true>>(readAttention(storage));
  let previous: AttentionFacts[] = [];

  watch(
    input.sessions,
    (sessions) => {
      attention.value = mergeAttention(attention.value, previous, sessions, input.activeRootId());
      previous = sessions.map((session) => ({ ...session }));
      writeAttention(storage, attention.value);
    },
    { immediate: true },
  );

  watch(input.activeRootId, (rootId) => {
    attention.value = clearAttention(attention.value, rootId);
    writeAttention(storage, attention.value);
  });

  return { attention };
}
