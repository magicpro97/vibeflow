// This suite must import the module EXACTLY ONCE — no `?case=N` cache-busted
// re-imports. Under bun 1.4.0 (CI), per-instance module coverage is kept and
// merged differently than bun 1.4.3 (local): the surviving record was the last
// cache-busted instance (the no-localStorage case), so the storage-present
// branches showed as uncovered and tripped the per-file 100% gate. Storage
// logic is therefore exercised through the exported seams
// (readRightSidebarPrefs / persistRightSidebarPrefs) instead of re-importing
// the module per scenario.
const { afterEach, beforeEach, describe, expect, test } = await import(String("bun:test"));
const { nextTick } = await import(String("vue"));

const STORAGE_KEY = "vf-right-sidebar";

// Seed the storage global BEFORE the module is imported: the module reads its
// initial prefs at load time, so the file-scope values captured below must
// reflect this stored state. This pins the module-load wiring — replacing the
// read with a hard-coded default object must fail the "module-load prefs
// wiring" test at the bottom of this file.
const seededStorage = {
  getItem: (key: string) =>
    key === STORAGE_KEY ? JSON.stringify({ open: true, tab: "files" }) : null,
  setItem: () => undefined,
};
(globalThis as { localStorage?: unknown }).localStorage = seededStorage;

const prefs = await import("../right-sidebar-prefs.js");
const initialOpen = prefs.rightSidebarOpen.value;
const initialTab = prefs.rightSidebarTab.value;
const {
  RIGHT_SIDEBAR_TABS,
  persistRightSidebarPrefs,
  readRightSidebarPrefs,
  rightSidebarOpen,
  rightSidebarTab,
  toggleRightSidebar,
} = prefs;

type StorageStub = {
  store: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function makeStorage(
  seed: Record<string, string> = {},
  opts: { throwOnSet?: boolean } = {},
): StorageStub {
  const store = new Map(Object.entries(seed));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      store.set(key, value);
    },
  };
}

function installStorage(
  seed: Record<string, string> = {},
  opts: { throwOnSet?: boolean } = {},
): StorageStub {
  const stub = makeStorage(seed, opts);
  (globalThis as { localStorage?: unknown }).localStorage = stub;
  return stub;
}

function persisted(storage: StorageStub): unknown {
  return JSON.parse(storage.store.get(STORAGE_KEY) ?? "null");
}

// Capture the prior global in beforeEach (never at module scope) and restore
// it in afterEach — the repo's global-stub discipline.
let previousLocalStorage: unknown;
let storage: StorageStub;

beforeEach(() => {
  previousLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  storage = installStorage();
});

afterEach(() => {
  // biome noDelete: `= undefined` is the repo's restore form; the subject
  // code treats an undefined global and an absent one identically.
  (globalThis as { localStorage?: unknown }).localStorage = previousLocalStorage;
});

describe("right-sidebar-prefs — read/persist seams", () => {
  test("defaults closed on the changes tab when nothing is stored", () => {
    expect(RIGHT_SIDEBAR_TABS).toEqual(["files", "changes", "resources"]);
    expect(Object.isFrozen(RIGHT_SIDEBAR_TABS)).toBe(true);
    expect(readRightSidebarPrefs(makeStorage())).toEqual({ open: false, tab: "changes" });
  });

  test("a stored tab is honored (including the global default-parameter read)", () => {
    const seeded = { [STORAGE_KEY]: JSON.stringify({ open: true, tab: "files" }) };
    expect(readRightSidebarPrefs(makeStorage(seeded))).toEqual({ open: true, tab: "files" });
    storage = installStorage(seeded);
    expect(readRightSidebarPrefs()).toEqual({ open: true, tab: "files" });
  });

  test("an unknown stored tab falls back to 'changes'", () => {
    const s = makeStorage({ [STORAGE_KEY]: JSON.stringify({ open: true, tab: "nope" }) });
    expect(readRightSidebarPrefs(s)).toEqual({ open: true, tab: "changes" });
  });

  test("corrupted JSON falls back to defaults (catch path)", () => {
    const s = makeStorage({ [STORAGE_KEY]: "{not json" });
    expect(readRightSidebarPrefs(s)).toEqual({ open: false, tab: "changes" });
  });

  test("a non-boolean open falls back to false", () => {
    const s = makeStorage({ [STORAGE_KEY]: JSON.stringify({ open: "yes", tab: 7 }) });
    expect(readRightSidebarPrefs(s)).toEqual({ open: false, tab: "changes" });
  });

  test("readRightSidebarPrefs(undefined) defaults when no storage global exists", () => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    expect(readRightSidebarPrefs(undefined)).toEqual({ open: false, tab: "changes" });
    expect(readRightSidebarPrefs()).toEqual({ open: false, tab: "changes" });
  });

  test("persist writes {open, tab} under the storage key", () => {
    const s = makeStorage();
    persistRightSidebarPrefs(s, true, "changes");
    expect(persisted(s)).toEqual({ open: true, tab: "changes" });
    persistRightSidebarPrefs(s, false, "files");
    expect(persisted(s)).toEqual({ open: false, tab: "files" });
  });

  test("a throwing setItem is swallowed (best-effort persistence)", () => {
    const s = makeStorage({}, { throwOnSet: true });
    expect(() => persistRightSidebarPrefs(s, true, "changes")).not.toThrow();
    expect(s.store.size).toBe(0);
  });

  test("persist without storage is a no-op", () => {
    expect(() => persistRightSidebarPrefs(undefined, true, "changes")).not.toThrow();
  });
});

describe("right-sidebar-prefs — module integration (single instance)", () => {
  test("toggle flips visibility and the watcher persists {open, tab}", async () => {
    rightSidebarOpen.value = false;
    rightSidebarTab.value = "changes";
    await nextTick();
    storage.store.clear();

    toggleRightSidebar();
    expect(rightSidebarOpen.value).toBe(true);
    await nextTick();
    expect(persisted(storage)).toEqual({ open: true, tab: "changes" });

    toggleRightSidebar();
    expect(rightSidebarOpen.value).toBe(false);
    await nextTick();
    expect(persisted(storage)).toEqual({ open: false, tab: "changes" });
  });

  test("toggleRightSidebar('files') switches the tab, opens, and persists", async () => {
    rightSidebarOpen.value = false;
    rightSidebarTab.value = "changes";
    await nextTick();
    storage.store.clear();

    toggleRightSidebar("files");
    expect(rightSidebarTab.value).toBe("files");
    expect(rightSidebarOpen.value).toBe(true);
    await nextTick();
    expect(persisted(storage)).toEqual({ open: true, tab: "files" });
  });

  test("a throwing setItem does not break toggling", async () => {
    storage = installStorage({}, { throwOnSet: true });
    rightSidebarOpen.value = false;
    rightSidebarTab.value = "changes";
    await nextTick(); // reset persistence also swallows the storage error

    toggleRightSidebar();
    expect(rightSidebarOpen.value).toBe(true);
    await nextTick();
    expect(rightSidebarOpen.value).toBe(true);
    expect(storage.store.size).toBe(0);
  });

  test("without a localStorage global the module still toggles (watcher early-returns)", async () => {
    rightSidebarOpen.value = false;
    rightSidebarTab.value = "changes";
    await nextTick();
    storage.store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = undefined;

    toggleRightSidebar("resources");
    expect(rightSidebarTab.value).toBe("resources");
    expect(rightSidebarOpen.value).toBe(true);
    await nextTick(); // watcher early-returns without storage
    expect(rightSidebarOpen.value).toBe(true);
    expect(storage.store.size).toBe(0);
  });
});

// The module-load read runs exactly once, at import time — and it must go
// through storage. The seeded storage installed at the top of this file is
// still in place when the module is imported, so the file-scope values
// captured right after the import pin the load-time wiring (mutant M7: a
// hard-coded `{open: false, tab: "changes"}` initial object fails here).
// Runs against the captured file-scope values, so the beforeEach replacement
// of the global below/above does not affect it.
describe("right-sidebar-prefs — module-load wiring", () => {
  test("the initial ref values honor the storage seeded before import", () => {
    expect(initialOpen).toBe(true);
    expect(initialTab).toBe("files");
  });
});
