import { ref, watch } from "vue";

const RIGHT_SIDEBAR_STORAGE_KEY = "vf-right-sidebar";
export const RIGHT_SIDEBAR_TABS = Object.freeze(["files", "changes", "resources"] as const);
export type RightSidebarTab = (typeof RIGHT_SIDEBAR_TABS)[number];

// Fresh-context default: at mobile widths the panel is a full-screen overlay
// (drawer + backdrop), so starting it open would cover the whole shell. Mirror
// the @media (max-width: 47.5rem) home.css breakpoint and start closed there.
const MOBILE_RIGHT_SIDEBAR_QUERY = "(max-width: 47.5rem)";

type MatchMediaLike = (query: string) => { matches: boolean };

function defaultRightSidebarOpen(): boolean {
  const matchMedia = (globalThis as { matchMedia?: MatchMediaLike }).matchMedia;
  return typeof matchMedia === "function" ? !matchMedia(MOBILE_RIGHT_SIDEBAR_QUERY).matches : true; // non-browser runtimes (unit tests, SSR) keep the desktop default
}

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
// With no usable stored preference the viewport default applies (open on
// desktop, closed at mobile widths — the panel is a full overlay there).
export function readRightSidebarPrefs(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): { open: boolean; tab: RightSidebarTab; width: number } {
  if (!storage) {
    return {
      open: defaultRightSidebarOpen(),
      tab: "changes",
      width: RIGHT_SIDEBAR_WIDTH.DEFAULT,
    };
  }
  try {
    const raw = JSON.parse(storage.getItem(RIGHT_SIDEBAR_STORAGE_KEY) ?? "null") as {
      open?: unknown;
      tab?: unknown;
      width?: unknown;
    } | null;
    const tab = RIGHT_SIDEBAR_TABS.find((t) => t === raw?.tab) ?? "changes";
    // An explicit stored boolean always wins (stored false keeps closing,
    // stored true keeps opening even on mobile); only a missing/non-boolean
    // open falls back to the viewport default.
    const open = typeof raw?.open === "boolean" ? raw.open : defaultRightSidebarOpen();
    return { open, tab, width: clampRightSidebarWidth(raw?.width) };
  } catch {
    return {
      open: defaultRightSidebarOpen(),
      tab: "changes",
      width: RIGHT_SIDEBAR_WIDTH.DEFAULT,
    };
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
