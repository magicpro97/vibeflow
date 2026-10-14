import { ref, watch } from "vue";

const RIGHT_SIDEBAR_STORAGE_KEY = "vf-right-sidebar";
export const RIGHT_SIDEBAR_TABS = Object.freeze(["files", "changes", "resources"] as const);
export type RightSidebarTab = (typeof RIGHT_SIDEBAR_TABS)[number];

function readRightSidebarPrefs(): { open: boolean; tab: RightSidebarTab } {
  if (typeof localStorage === "undefined") return { open: false, tab: "changes" };
  try {
    const raw = JSON.parse(localStorage.getItem(RIGHT_SIDEBAR_STORAGE_KEY) ?? "null") as {
      open?: unknown;
      tab?: unknown;
    } | null;
    const tab = RIGHT_SIDEBAR_TABS.find((t) => t === raw?.tab) ?? "changes";
    return { open: raw?.open === true, tab };
  } catch {
    return { open: false, tab: "changes" };
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
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      RIGHT_SIDEBAR_STORAGE_KEY,
      JSON.stringify({ open: rightSidebarOpen.value, tab: rightSidebarTab.value }),
    );
  } catch {
    // Storage full / private browsing — persistence is best-effort, UI unaffected.
  }
});
