import { ref, watch } from "vue";

const RIGHT_SIDEBAR_STORAGE_KEY = "vf-right-sidebar";
export const RIGHT_SIDEBAR_TABS = Object.freeze(["files", "changes", "resources"] as const);
export type RightSidebarTab = (typeof RIGHT_SIDEBAR_TABS)[number];

// Storage is a parameter (test seam) so the read logic can be exercised
// directly; callers that omit it keep reading the real global, unchanged.
export function readRightSidebarPrefs(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): { open: boolean; tab: RightSidebarTab } {
  if (!storage) return { open: false, tab: "changes" };
  try {
    const raw = JSON.parse(storage.getItem(RIGHT_SIDEBAR_STORAGE_KEY) ?? "null") as {
      open?: unknown;
      tab?: unknown;
    } | null;
    const tab = RIGHT_SIDEBAR_TABS.find((t) => t === raw?.tab) ?? "changes";
    return { open: raw?.open === true, tab };
  } catch {
    return { open: false, tab: "changes" };
  }
}

export function persistRightSidebarPrefs(
  storage: Pick<Storage, "setItem"> | undefined,
  open: boolean,
  tab: RightSidebarTab,
): void {
  if (!storage) return;
  try {
    storage.setItem(RIGHT_SIDEBAR_STORAGE_KEY, JSON.stringify({ open, tab }));
  } catch {
    // Storage full / private browsing — persistence is best-effort, UI unaffected.
  }
}

const prefs = readRightSidebarPrefs();

export const rightSidebarOpen = ref(prefs.open);
export const rightSidebarTab = ref<RightSidebarTab>(prefs.tab);

export function toggleRightSidebar(tab?: RightSidebarTab): void {
  if (tab) {
    rightSidebarTab.value = tab;
    rightSidebarOpen.value = true;
  } else {
    rightSidebarOpen.value = !rightSidebarOpen.value;
  }
}

watch([rightSidebarOpen, rightSidebarTab], () => {
  persistRightSidebarPrefs(globalThis.localStorage, rightSidebarOpen.value, rightSidebarTab.value);
});
