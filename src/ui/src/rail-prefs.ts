import { ref, watch } from "vue";

// Left-rail width bounds mirror the real Orca left sidebar (drag-resizable
// 220-500, default 280 per its hydration sanitizer). The drag math itself is
// generic and already lives in right-sidebar-resize.ts (clampWidth +
// resizeFromDrag) — this module only owns the persisted preference.
export const RAIL_WIDTH = Object.freeze({ DEFAULT: 280, MIN: 220, MAX: 500 } as const);
export const RAIL_STORAGE_KEY = "vf-rail";

export type RailPrefs = { width: number };

const clampRailWidth = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(RAIL_WIDTH.MAX, Math.max(RAIL_WIDTH.MIN, Math.round(value)))
    : RAIL_WIDTH.DEFAULT;

// Storage is a parameter (test seam) so the read logic can be exercised
// directly; callers that omit it keep reading the real global, unchanged.
// Anything corrupt, absent, non-object, or non-numeric falls back to DEFAULT.
export function readRailPrefs(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): RailPrefs {
  if (!storage) return { width: RAIL_WIDTH.DEFAULT };
  try {
    const raw = JSON.parse(storage.getItem(RAIL_STORAGE_KEY) ?? "null") as {
      width?: unknown;
    } | null;
    return { width: clampRailWidth(raw?.width) };
  } catch {
    return { width: RAIL_WIDTH.DEFAULT };
  }
}

export function persistRailPrefs(
  storage: Pick<Storage, "setItem"> | undefined,
  width: number,
): void {
  if (!storage) return;
  try {
    storage.setItem(RAIL_STORAGE_KEY, JSON.stringify({ width: clampRailWidth(width) }));
  } catch {
    // Storage full / private browsing — persistence is best-effort, UI unaffected.
  }
}

export const railWidth = ref(readRailPrefs().width);

export function setRailWidth(value: number): void {
  railWidth.value = clampRailWidth(value);
}

watch(railWidth, (width) => {
  persistRailPrefs(globalThis.localStorage, width);
});
