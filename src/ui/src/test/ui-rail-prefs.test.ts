// This suite must import the module EXACTLY ONCE — no `?case=N` cache-busted
// re-imports. Same discipline as ui-right-sidebar-prefs.test.ts: under bun
// 1.4.0 (CI), per-instance module coverage is kept and merged differently than
// bun 1.4.3 (local), so the surviving record was the last cache-busted instance
// and the other branches showed as uncovered, tripping the per-file 100% gate.
// Storage logic is therefore exercised through the exported seams
// (readRailPrefs / persistRailPrefs) instead of re-importing the module per
// scenario.
const { afterEach, beforeEach, describe, expect, test } = await import(String("bun:test"));
const { nextTick } = await import(String("vue"));

const STORAGE_KEY = "vf-rail";

// Seed the storage global BEFORE the module is imported: the module reads its
// initial width at load time, so the file-scope value captured below must
// reflect this stored state. The seeded width (432) is deliberately different
// from RAIL_WIDTH.DEFAULT, pinning both the module-load read wiring and that a
// persisted width is honored at load: a hard-coded `ref(RAIL_WIDTH.DEFAULT)`
// fails the "module-load wiring" test at the bottom of this file.
const seededStorage = {
  getItem: (key: string) => (key === STORAGE_KEY ? JSON.stringify({ width: 432 }) : null),
  setItem: () => undefined,
};
(globalThis as { localStorage?: unknown }).localStorage = seededStorage;

const prefs = await import("../rail-prefs.js");
const initialWidth = prefs.railWidth.value;
const { RAIL_STORAGE_KEY, RAIL_WIDTH, persistRailPrefs, railWidth, readRailPrefs, setRailWidth } =
  prefs;

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
  (globalThis as { localStorage?: unknown }).localStorage = previousLocalStorage;
});

describe("rail-prefs — read/persist seams", () => {
  test("defaults to 280 with no stored state (frozen bounds + storage key)", () => {
    expect(RAIL_STORAGE_KEY).toBe("vf-rail");
    expect(RAIL_WIDTH).toEqual({ DEFAULT: 280, MIN: 220, MAX: 500 });
    expect(Object.isFrozen(RAIL_WIDTH)).toBe(true);
    expect(readRailPrefs(makeStorage())).toEqual({ width: 280 });
    // A stored literal "null" (key present, JSON null) is the same default.
    expect(readRailPrefs(makeStorage({ [STORAGE_KEY]: "null" }))).toEqual({ width: 280 });
  });

  test("corrupt, blank, non-object, and non-numeric stored payloads fall back to 280", () => {
    for (const raw of ["{not json", "   ", "5", "[]", "true"]) {
      expect(readRailPrefs(makeStorage({ [STORAGE_KEY]: raw }))).toEqual({ width: 280 });
    }
    for (const payload of [{}, { width: "wide" }, { width: null }, { width: [] }]) {
      expect(readRailPrefs(seededPrefs(payload))).toEqual({ width: 280 });
    }
    // JSON `1e999` parses to Infinity: a number, but not finite.
    expect(readRailPrefs(makeStorage({ [STORAGE_KEY]: '{"width":1e999}' }))).toEqual({
      width: 280,
    });
  });

  test("a stored width is rounded + clamped to [220, 500]", () => {
    const cases: [unknown, number][] = [
      [9999, 500],
      [10, 220],
      [280.6, 281],
      [279.4, 279],
      [432, 432],
    ];
    for (const [width, expected] of cases) {
      expect(readRailPrefs(seededPrefs({ width })).width).toBe(expected);
    }
  });

  test("readRailPrefs(undefined) defaults when no storage global exists", () => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    expect(readRailPrefs(undefined)).toEqual({ width: 280 });
    expect(readRailPrefs()).toEqual({ width: 280 });
  });

  test("persist writes the clamped width and round-trips through readRailPrefs", () => {
    const s = makeStorage();
    persistRailPrefs(s, 700);
    expect(persisted(s)).toEqual({ width: 500 });
    expect(readRailPrefs(s)).toEqual({ width: 500 });

    persistRailPrefs(s, 10);
    expect(persisted(s)).toEqual({ width: 220 });
    expect(readRailPrefs(s)).toEqual({ width: 220 });

    persistRailPrefs(s, 280.6);
    expect(persisted(s)).toEqual({ width: 281 });
    expect(readRailPrefs(s)).toEqual({ width: 281 });
  });

  test("a throwing setItem is swallowed (best-effort persistence)", () => {
    const s = makeStorage({}, { throwOnSet: true });
    expect(() => persistRailPrefs(s, 300)).not.toThrow();
    expect(s.store.size).toBe(0);
  });

  test("persist without storage is a no-op", () => {
    expect(() => persistRailPrefs(undefined, 300)).not.toThrow();
  });
});

describe("rail-prefs — module integration (single instance)", () => {
  test("setRailWidth clamps + rounds and the watcher persists the width", async () => {
    railWidth.value = RAIL_WIDTH.DEFAULT;
    await nextTick();
    storage.store.clear();

    setRailWidth(9999);
    expect(railWidth.value).toBe(500);
    await nextTick();
    expect(persisted(storage)).toEqual({ width: 500 });

    setRailWidth(230.4);
    expect(railWidth.value).toBe(230);
    await nextTick();
    expect(persisted(storage)).toEqual({ width: 230 });

    setRailWidth(Number.NaN);
    expect(railWidth.value).toBe(280);
    await nextTick();
    expect(persisted(storage)).toEqual({ width: 280 });
  });

  test("without a localStorage global the setter still works (watcher no-ops)", async () => {
    railWidth.value = RAIL_WIDTH.DEFAULT;
    await nextTick();
    storage.store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = undefined;

    setRailWidth(300);
    expect(railWidth.value).toBe(300);
    await nextTick(); // watcher's persist early-returns without storage
    expect(storage.store.size).toBe(0);
  });
});

// The module-load read runs exactly once, at import time — and it must go
// through storage. The seeded storage installed at the top of this file is
// still in place when the module is imported, so the file-scope value captured
// right after the import pins the load-time wiring (a hard-coded
// `ref(RAIL_WIDTH.DEFAULT)` initial ref fails here: 432 ≠ 280) as well as the
// "a persisted width is honored at load" behavior. Runs against the captured
// file-scope value, so the beforeEach replacement of the global does not
// affect it.
describe("rail-prefs — module-load wiring", () => {
  test("the initial ref value honors the storage seeded before import", () => {
    expect(initialWidth).toBe(432);
  });
});
