import { onUnmounted, ref } from "vue";

export function usePoller<T>(
  fn: () => Promise<T | null>,
  intervalMs = 2000,
  options: { lazy?: boolean } = {},
) {
  const data = ref<T | null>(null);
  const error = ref<string | null>(null);
  let active = true; // abort flag — prevents state mutation after unmount

  async function tick() {
    if (!active) return;
    if (document.visibilityState === "hidden") return; // skip while tab hidden
    try {
      const result = await fn();
      if (!active) return; // component unmounted while awaiting — discard
      data.value = result;
      if (result !== null) error.value = null; // clear stale error on success
    } catch (e) {
      if (!active) return;
      error.value = String(e);
    }
  }

  // lazy: skip initial tick — first poll fires after intervalMs instead of immediately.
  // Use when the polling condition is known to be false on mount (e.g. anyRunning === false).
  if (!options.lazy) tick();
  const id = setInterval(tick, intervalMs);
  onUnmounted(() => {
    active = false;
    clearInterval(id);
  });

  return { data, error };
}
