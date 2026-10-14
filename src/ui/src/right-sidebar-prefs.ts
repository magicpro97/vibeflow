import { ref, watch } from "vue";

const RIGHT_SIDEBAR_STORAGE_KEY = "vf-right-sidebar";
export const RIGHT_SIDEBAR_TABS = Object.freeze(["files", "changes", "resources"] as const);
export type RightSidebarTab = (typeof RIGHT_SIDEBAR_TABS)[number];

export const RIGHT_SIDEBAR_WIDTH = Object.freeze({
  DEFAULT: 320,
  MIN: 240,
  MAX: 560,
} as const);

const clampRightSidebarWidth = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(RIGHT_SIDEBAR_WIDTH.MAX, Math.max(RIGHT_SIDEBAR_WIDTH.MIN, Math.round(value)))
    : RIGHT_SIDEBAR_WIDTH.DEFAULT;

// Storage is a parameter (test seam) so the read logic can be exercised
// directly; callers that omit it keep reading the real global, unchanged.
// Defaults are OPEN (the real app's default: closing is an explicit user
// action, persisted as open:false — never inferred from missing state).
export function readRightSidebarPrefs(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): { open: boolean; tab: RightSidebarTab; width: number } {
  if (!storage) return { open: true, tab: "changes", width: RIGHT_SIDEBAR_WIDTH.DEFAULT };
  try {
    const raw = JSON.parse(storage.getItem(RIGHT_SIDEBAR_STORAGE_KEY) ?? "null") as {
      open?: unknown;
      tab?: unknown;
      width?: unknown;
    } | null;
    const tab = RIGHT_SIDEBAR_TABS.find((t) => t === raw?.tab) ?? "changes";
    return { open: raw?.open !== false, tab, width: clampRightSidebarWidth(raw?.width) };
  } catch {
    return { open: true, tab: "changes", width: RIGHT_SIDEBAR_WIDTH.DEFAULT };
  }
}

export function persistRightSidebarPrefs(
  storage: Pick<Storage, "setItem"> | undefined,
  open: boolean,
  tab: RightSidebarTab,
  width: number,
): void {
  if (!storage) return;
  try {
    storage.setItem(RIGHT_SIDEBAR_STORAGE_KEY, JSON.stringify({ open, tab, width }));
  } catch {
    // Storage full / private browsing — persistence is best-effort, UI unaffected.
  }
}

const prefs = readRightSidebarPrefs();

export const rightSidebarOpen = ref(prefs.open);
export const rightSidebarTab = ref<RightSidebarTab>(prefs.tab);
export const rightSidebarWidth = ref(prefs.width);

export function toggleRightSidebar(tab?: RightSidebarTab): void {
  if (tab) {
    rightSidebarTab.value = tab;
    rightSidebarOpen.value = true;
  } else {
    rightSidebarOpen.value = !rightSidebarOpen.value;
  }
}

export function setRightSidebarWidth(value: number): void {
  rightSidebarWidth.value = clampRightSidebarWidth(value);
}

watch([rightSidebarOpen, rightSidebarTab, rightSidebarWidth], () => {
  persistRightSidebarPrefs(
    globalThis.localStorage,
    rightSidebarOpen.value,
    rightSidebarTab.value,
    rightSidebarWidth.value,
  );
});
