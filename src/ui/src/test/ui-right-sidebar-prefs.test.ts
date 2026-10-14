const { beforeEach, describe, expect, test } = await import(String("bun:test"));
const { nextTick } = await import(String("vue"));

type PrefsModule = typeof import("../right-sidebar-prefs.js");

const STORAGE_KEY = "vf-right-sidebar";
const MODULE_SPECIFIER = "../right-sidebar-prefs.js";

type StorageStub = {
  store: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function installStorage(
  seed: Record<string, string> = {},
  opts: { throwOnSet?: boolean } = {},
): StorageStub {
  const store = new Map(Object.entries(seed));
  const stub: StorageStub = {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      store.set(key, value);
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = stub;
  return stub;
}

let importCounter = 0;
// Module-level prefs read runs once per import — cache-bust so each case sees its own seed.
async function loadPrefs(): Promise<PrefsModule> {
  importCounter += 1;
  return (await import(`${MODULE_SPECIFIER}?case=${importCounter}`)) as PrefsModule;
}

function persisted(storage: StorageStub): unknown {
  return JSON.parse(storage.store.get(STORAGE_KEY) ?? "null");
}

describe("right-sidebar-prefs", () => {
  beforeEach(() => {
    installStorage();
  });

  test("defaults closed on the changes tab when nothing is stored", async () => {
    const prefs = await loadPrefs();
    expect(prefs.RIGHT_SIDEBAR_TABS).toEqual(["files", "changes", "resources"]);
    expect(Object.isFrozen(prefs.RIGHT_SIDEBAR_TABS)).toBe(true);
    expect(prefs.rightSidebarOpen.value).toBe(false);
    expect(prefs.rightSidebarTab.value).toBe("changes");
  });

  test("toggle flips visibility and persists {open, tab}", async () => {
    const storage = installStorage();
    const prefs = await loadPrefs();
    prefs.toggleRightSidebar();
    expect(prefs.rightSidebarOpen.value).toBe(true);
    await nextTick();
    expect(persisted(storage)).toEqual({ open: true, tab: "changes" });
    prefs.toggleRightSidebar();
    expect(prefs.rightSidebarOpen.value).toBe(false);
    await nextTick();
    expect(persisted(storage)).toEqual({ open: false, tab: "changes" });
  });

  test("toggleRightSidebar('files') switches the tab and opens the sidebar", async () => {
    const storage = installStorage();
    const prefs = await loadPrefs();
    prefs.toggleRightSidebar("files");
    expect(prefs.rightSidebarTab.value).toBe("files");
    expect(prefs.rightSidebarOpen.value).toBe(true);
    await nextTick();
    expect(persisted(storage)).toEqual({ open: true, tab: "files" });
  });

  test("a stored tab is honored; an unknown one falls back to 'changes'", async () => {
    installStorage({ [STORAGE_KEY]: JSON.stringify({ open: true, tab: "files" }) });
    const honored = await loadPrefs();
    expect(honored.rightSidebarTab.value).toBe("files");
    expect(honored.rightSidebarOpen.value).toBe(true);

    installStorage({ [STORAGE_KEY]: JSON.stringify({ open: true, tab: "nope" }) });
    const fallback = await loadPrefs();
    expect(fallback.rightSidebarTab.value).toBe("changes");
    expect(fallback.rightSidebarOpen.value).toBe(true);
  });

  test("corrupted JSON and non-boolean open both fall back to defaults", async () => {
    installStorage({ [STORAGE_KEY]: "{not json" });
    const corrupted = await loadPrefs();
    expect(corrupted.rightSidebarOpen.value).toBe(false);
    expect(corrupted.rightSidebarTab.value).toBe("changes");

    installStorage({ [STORAGE_KEY]: JSON.stringify({ open: "yes", tab: 7 }) });
    const wrongTypes = await loadPrefs();
    expect(wrongTypes.rightSidebarOpen.value).toBe(false);
    expect(wrongTypes.rightSidebarTab.value).toBe("changes");
  });

  test("a throwing setItem does not break toggling", async () => {
    installStorage({}, { throwOnSet: true });
    const prefs = await loadPrefs();
    prefs.toggleRightSidebar();
    expect(prefs.rightSidebarOpen.value).toBe(true);
    await nextTick(); // the persistence watcher swallowed the storage error
    expect(prefs.rightSidebarOpen.value).toBe(true);
  });

  test("without a localStorage global the module still defaults and toggles", async () => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    const prefs = await loadPrefs();
    expect(prefs.rightSidebarOpen.value).toBe(false);
    expect(prefs.rightSidebarTab.value).toBe("changes");
    prefs.toggleRightSidebar("resources");
    expect(prefs.rightSidebarTab.value).toBe("resources");
    expect(prefs.rightSidebarOpen.value).toBe(true);
    await nextTick(); // watcher early-returns without storage
    expect(prefs.rightSidebarOpen.value).toBe(true);
  });
});
