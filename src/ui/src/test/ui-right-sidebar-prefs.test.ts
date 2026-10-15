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
// wiring" test at the bottom of this file. The payload is deliberately a
// legacy one (no `width`), so it also pins the width default.
const seededStorage = {
  getItem: (key: string) =>
    key === STORAGE_KEY ? JSON.stringify({ open: true, tab: "files" }) : null,
  setItem: () => undefined,
};
(globalThis as { localStorage?: unknown }).localStorage = seededStorage;

const prefs = await import("../right-sidebar-prefs.js");
const initialOpen = prefs.rightSidebarOpen.value;
const initialTab = prefs.rightSidebarTab.value;
const initialWidth = prefs.rightSidebarWidth.value;
const {
  RIGHT_SIDEBAR_TABS,
  RIGHT_SIDEBAR_WIDTH,
  persistRightSidebarPrefs,
  readRightSidebarPrefs,
  rightSidebarOpen,
  rightSidebarTab,
  rightSidebarWidth,
  setRightSidebarWidth,
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

function seededPrefs(payload: unknown, key = STORAGE_KEY): StorageStub {
  return makeStorage({ [key]: JSON.stringify(payload) });
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
  test("defaults OPEN on the changes tab at the default width when nothing is stored", () => {
    expect(RIGHT_SIDEBAR_TABS).toEqual(["files", "changes", "resources"]);
    expect(Object.isFrozen(RIGHT_SIDEBAR_TABS)).toBe(true);
    expect(RIGHT_SIDEBAR_WIDTH).toEqual({ DEFAULT: 320, MIN: 240, MAX: 560 });
    expect(Object.isFrozen(RIGHT_SIDEBAR_WIDTH)).toBe(true);
    expect(readRightSidebarPrefs(makeStorage())).toEqual({
      open: true,
      tab: "changes",
      width: 320,
    });
    // A stored literal "null" (key present, JSON null) is the same default.
    expect(readRightSidebarPrefs(makeStorage({ [STORAGE_KEY]: "null" }))).toEqual({
      open: true,
      tab: "changes",
      width: 320,
    });
  });

  test("a stored tab is honored (including the global default-parameter read)", () => {
    const seeded = { [STORAGE_KEY]: JSON.stringify({ open: true, tab: "files" }) };
    expect(readRightSidebarPrefs(makeStorage(seeded))).toEqual({
      open: true,
      tab: "files",
      width: 320,
    });
    storage = installStorage(seeded);
    expect(readRightSidebarPrefs()).toEqual({ open: true, tab: "files", width: 320 });
  });

  test("a legacy payload with no width keeps the default width", () => {
    const s = seededPrefs({ open: true, tab: "files" });
    expect(readRightSidebarPrefs(s)).toEqual({ open: true, tab: "files", width: 320 });
  });

  test("a stored width is honored and clamped to [240, 560]", () => {
    const cases: [unknown, number][] = [
      [500, 500],
      [300.6, 301],
      [999999, 560],
      [10, 240],
      ["wide", 320],
      [null, 320],
      [{}, 320],
    ];
    for (const [width, expected] of cases) {
      const s = seededPrefs({ open: true, tab: "changes", width });
      expect(readRightSidebarPrefs(s).width).toBe(expected);
    }
  });

  test("an explicit stored open:false is the only way to close", () => {
    expect(readRightSidebarPrefs(seededPrefs({ open: false, tab: "files", width: 500 }))).toEqual({
      open: false,
      tab: "files",
      width: 500,
    });
  });

  test("an unknown stored tab falls back to 'changes'", () => {
    const s = seededPrefs({ open: true, tab: "nope" });
    expect(readRightSidebarPrefs(s)).toEqual({ open: true, tab: "changes", width: 320 });
  });

  test("corrupted JSON falls back to defaults (catch path)", () => {
    const s = makeStorage({ [STORAGE_KEY]: "{not json" });
    expect(readRightSidebarPrefs(s)).toEqual({ open: true, tab: "changes", width: 320 });
  });

  test("a non-boolean open falls back to the default (open)", () => {
    const s = seededPrefs({ open: "yes", tab: 7 });
    expect(readRightSidebarPrefs(s)).toEqual({ open: true, tab: "changes", width: 320 });
  });

  test("readRightSidebarPrefs(undefined) defaults when no storage global exists", () => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    expect(readRightSidebarPrefs(undefined)).toEqual({
      open: true,
      tab: "changes",
      width: 320,
    });
    expect(readRightSidebarPrefs()).toEqual({ open: true, tab: "changes", width: 320 });
  });

  test("persist writes {open, tab, width} under the storage key", () => {
    const s = makeStorage();
    persistRightSidebarPrefs(s, true, "changes", 320);
    expect(persisted(s)).toEqual({ open: true, tab: "changes", width: 320 });
    persistRightSidebarPrefs(s, false, "files", 500);
    expect(persisted(s)).toEqual({ open: false, tab: "files", width: 500 });
  });

  test("a throwing setItem is swallowed (best-effort persistence)", () => {
    const s = makeStorage({}, { throwOnSet: true });
    expect(() => persistRightSidebarPrefs(s, true, "changes", 320)).not.toThrow();
    expect(s.store.size).toBe(0);
  });

  test("persist without storage is a no-op", () => {
    expect(() => persistRightSidebarPrefs(undefined, true, "changes", 320)).not.toThrow();
  });
});

// The fresh-context default is viewport-aware: mobile widths get a CLOSED
// sidebar (it is a full-screen overlay there), desktop keeps OPEN. Only a
// missing/non-boolean stored `open` consults matchMedia; an explicit stored
// boolean always wins. matchMedia is stubbed per test and restored in
// afterEach so the stub cannot leak into the other suites (which assume the
// global is absent, as it is in bun).
describe("right-sidebar-prefs — viewport-aware fresh default", () => {
  let previousMatchMedia: unknown;

  beforeEach(() => {
    previousMatchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
  });

  afterEach(() => {
    (globalThis as { matchMedia?: unknown }).matchMedia = previousMatchMedia;
  });

  const stubMatchMedia = (matches: boolean): void => {
    (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches });
  };

  test("a fresh context without a matchMedia global keeps the desktop default (open)", () => {
    (globalThis as { matchMedia?: unknown }).matchMedia = undefined;
    expect(readRightSidebarPrefs(makeStorage())).toEqual({
      open: true,
      tab: "changes",
      width: 320,
    });
  });

  test("a fresh context at the mobile breakpoint defaults CLOSED", () => {
    stubMatchMedia(true);
    expect(readRightSidebarPrefs(makeStorage())).toEqual({
      open: false,
      tab: "changes",
      width: 320,
    });
  });

  test("a fresh context above the mobile breakpoint defaults open", () => {
    stubMatchMedia(false);
    expect(readRightSidebarPrefs(makeStorage()).open).toBe(true);
  });

  test("a stored open:true still wins at the mobile breakpoint", () => {
    stubMatchMedia(true);
    expect(readRightSidebarPrefs(seededPrefs({ open: true, tab: "files" })).open).toBe(true);
  });

  test("a stored open:false still closes above the mobile breakpoint", () => {
    stubMatchMedia(false);
    expect(readRightSidebarPrefs(seededPrefs({ open: false })).open).toBe(false);
  });
});

describe("right-sidebar-prefs — module integration (single instance)", () => {
  test("toggle flips visibility and the watcher persists {open, tab, width}", async () => {
    rightSidebarOpen.value = false;
    rightSidebarTab.value = "changes";
    rightSidebarWidth.value = 320;
    await nextTick();
    storage.store.clear();

    toggleRightSidebar();
    expect(rightSidebarOpen.value).toBe(true);
    await nextTick();
    expect(persisted(storage)).toEqual({ open: true, tab: "changes", width: 320 });

    toggleRightSidebar();
    expect(rightSidebarOpen.value).toBe(false);
    await nextTick();
    expect(persisted(storage)).toEqual({ open: false, tab: "changes", width: 320 });
  });

  test("toggleRightSidebar('files') switches the tab, opens, and persists", async () => {
    rightSidebarOpen.value = false;
    rightSidebarTab.value = "changes";
    rightSidebarWidth.value = 320;
    await nextTick();
    storage.store.clear();

    toggleRightSidebar("files");
    expect(rightSidebarTab.value).toBe("files");
    expect(rightSidebarOpen.value).toBe(true);
    await nextTick();
    expect(persisted(storage)).toEqual({ open: true, tab: "files", width: 320 });
  });

  test("setRightSidebarWidth rounds + clamps and the watcher persists the width", async () => {
    rightSidebarOpen.value = true;
    rightSidebarTab.value = "changes";
    rightSidebarWidth.value = 320;
    await nextTick();
    storage.store.clear();

    setRightSidebarWidth(700);
    expect(rightSidebarWidth.value).toBe(560);
    await nextTick();
    expect(persisted(storage)).toEqual({ open: true, tab: "changes", width: 560 });

    setRightSidebarWidth(300.6);
    expect(rightSidebarWidth.value).toBe(301);
    setRightSidebarWidth(-5);
    expect(rightSidebarWidth.value).toBe(240);
    setRightSidebarWidth(Number.NaN);
    expect(rightSidebarWidth.value).toBe(320);
    await nextTick();
    expect(persisted(storage)).toEqual({ open: true, tab: "changes", width: 320 });
  });

  test("a throwing setItem does not break toggling", async () => {
    storage = installStorage({}, { throwOnSet: true });
    rightSidebarOpen.value = false;
    rightSidebarTab.value = "changes";
    rightSidebarWidth.value = 320;
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
    rightSidebarWidth.value = 320;
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
    expect(initialWidth).toBe(320);
  });
});
