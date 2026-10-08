import { ref, watch } from "vue";
import {
  clearAttention,
  mergeAttention,
  readAttention,
  writeAttention,
} from "../lib/session-attention.js";
import type { AttentionFacts } from "../lib/session-attention.js";

/** No-op storage for environments where even READING `window.localStorage`
 * throws (persistence blocked); the rail must still mount. */
const NOOP_STORAGE: Pick<Storage, "getItem" | "setItem"> = {
  getItem: () => null,
  setItem: () => undefined,
};

function safeLocalStorage(): Pick<Storage, "getItem" | "setItem"> {
  try {
    return window.localStorage;
  } catch {
    return NOOP_STORAGE;
  }
}

/** Tracks per-session attention marks; persistence is localStorage with defensive fallbacks. */
export function useSessionAttention(input: {
  sessions: () => readonly AttentionFacts[];
  activeRootId: () => string | null;
  storage?: Pick<Storage, "getItem" | "setItem">;
}) {
  const storage = input.storage ?? safeLocalStorage();
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
