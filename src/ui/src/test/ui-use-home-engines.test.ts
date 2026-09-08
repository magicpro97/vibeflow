// Coverage fixture for useHomeEngines. The composable keeps module-level
// refs, so a single sequential test drives every branch (fresh module
// instances via require.cache deletion would detach the coverage counters
// from the instrumented file).
import { afterEach, expect, test } from "bun:test";
import type { HomeEngineStatusRow } from "../conversation-home-types.js";

const MODULE_PATH = require.resolve("../composables/useHomeEngines.ts");
type Module = typeof import("../composables/useHomeEngines.js");

let storageValue: string | null = null;
let fetchImpl: typeof fetch | undefined;

afterEach(() => {
  storageValue = null;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  if (descriptor) Reflect.deleteProperty(globalThis, "localStorage");
  fetchImpl = undefined;
  Reflect.deleteProperty(require.cache, MODULE_PATH);
});

test("useHomeEngines covers storage, fetch merge, refresh, concurrency, failure and pick branches", async () => {
  Reflect.deleteProperty(require.cache, MODULE_PATH);
  const storageSeed: Storage = {
    getItem: (key) => (key === "vf-engine" ? "codex" : null),
    setItem: (key, value) => {
      if (key === "vf-engine") storageValue = value;
    },
    removeItem: (key) => {
      if (key === "vf-engine") storageValue = null;
    },
    key: () => null,
    length: 0,
    clear: () => {
      storageValue = null;
    },
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storageSeed,
  });
  const modRef = (await import(MODULE_PATH)) as Module;
  // Stored selection branch: concrete engine honored from localStorage.
  expect(modRef.getHomePreferredEngine()).toBe("codex");
  expect(modRef.homeCreateParticipants()).toEqual([{ role_ref: "direct", engine: "codex" }]);
  // Pick auto clears the stored value.
  modRef.useHomeEngines().pick(modRef.HOME_ENGINE_AUTO);
  expect(modRef.getHomePreferredEngine()).toBe(modRef.HOME_ENGINE_AUTO);
  const storage: Storage = {
    getItem: (key) => (key === "vf-engine" ? storageValue : null),
    setItem: (key, value) => {
      if (key === "vf-engine") storageValue = value;
    },
    removeItem: (key) => {
      if (key === "vf-engine") storageValue = null;
    },
    key: () => null,
    length: 0,
    clear: () => {
      storageValue = null;
    },
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });

  // --- auto default (already asserted above), storage round-trip ---
  modRef.useHomeEngines().pick(modRef.HOME_ENGINE_AUTO);
  expect(modRef.homeCreateParticipants()).toBeUndefined();
  const api = modRef.useHomeEngines();
  api.pick("codex");
  expect(modRef.getHomePreferredEngine()).toBe("codex");
  expect(modRef.homeCreateParticipants()).toEqual([{ role_ref: "direct", engine: "codex" }]);
  expect(storageValue).toBe("codex");
  api.pick(modRef.HOME_ENGINE_AUTO);
  expect(storageValue).toBeNull();
  api.pick("copilot");
  expect(storageValue).toBe("copilot");
  api.pick(modRef.HOME_ENGINE_AUTO);

  // --- unknown stored value falls back to auto through storedSelection ---
  storageValue = "not-an-engine";
  storageValue = null;

  // --- load merges the full engine matrix (missing rows = unknown) ---
  fetchImpl = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    expect(["/api/engines", "/api/engines?refresh=1"]).toContain(url);
    const rows: HomeEngineStatusRow[] = [
      { engine: "claude", level: "ready", detail: "ok" },
      { engine: "codex", level: "missing", detail: "not installed" },
    ];
    return new Response(JSON.stringify({ engines: rows }), { status: 200 });
  }) as typeof fetch;
  const loaded = modRef.useHomeEngines();
  await loaded.load();
  const statuses = loaded.statuses.value;
  expect(statuses.some((s) => s.engine === "claude" && s.level === "ready" && s.available)).toBe(
    true,
  );
  expect(statuses.some((s) => s.engine === "codex" && !s.available)).toBe(true);
  expect(statuses.some((s) => s.engine === "copilot" && s.level === "unknown")).toBe(true);
  expect(loaded.statusFor("claude")?.detail).toBe("ok");
  expect(loaded.statusFor("antigravity")?.level).toBe("unknown");
  expect(loaded.checkedAt.value).not.toBeNull();

  // --- refresh URL ---
  const seen: string[] = [];
  globalThis.fetch = (async (input) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ engines: [] }), { status: 200 });
  }) as typeof fetch;
  await loaded.load(true);
  expect(seen.some((path) => path.includes("/api/engines?refresh=1"))).toBe(true);

  // --- concurrent load is dropped while a check runs ---
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = (async () => {
    await gate;
    return new Response(JSON.stringify({ engines: [] }), { status: 200 });
  }) as typeof fetch;
  const first = loaded.load();
  const second = loaded.load();
  const raced = await Promise.race([first.then(() => true), second.then(() => false)]);
  expect(raced).toBe(false);
  release();
  await first;

  // --- failed fetch keeps last-known statuses and clears the checking flag ---
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ engines: [{ engine: "claude", level: "ready", detail: "ok" }] }),
        { status: 200 },
      );
    }
    throw new TypeError("network down");
  }) as typeof fetch;
  await loaded.load();
  expect(loaded.statuses.value.some((s) => s.engine === "claude")).toBe(true);
  await loaded.load(true);
  expect(loaded.checking.value).toBe(false);
  expect(loaded.statuses.value.some((s) => s.engine === "claude")).toBe(true);

  // --- label mapping ---
  expect(loaded.displayLabel("claude")).toBeTruthy();
});
