// test/notify.test.ts
//
// Unit coverage for the #559 best-effort desktop notifier. Every branch is
// driven through the injected seams (spawn/has/env/platform) so no real OS
// notification ever fires and the suite stays hermetic on macOS + Linux.

import { expect, test } from "bun:test";
import { notify } from "../src/notify.js";

/** Collect the (cmd, args) a spawn seam is called with. */
function spawnSpy() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return { calls, spawn: (cmd: string, args: string[]) => calls.push({ cmd, args }) };
}

test("VF_NO_NOTIFY=1 is an early return — nothing is spawned", () => {
  const { calls, spawn } = spawnSpy();
  notify("t", "b", {
    env: { VF_NO_NOTIFY: "1" },
    spawn,
    has: () => true,
    platform: "darwin",
  });
  expect(calls).toEqual([]);
});

test("darwin + osascript present → osascript display notification", () => {
  const { calls, spawn } = spawnSpy();
  notify("Title", "Body", {
    env: {},
    spawn,
    has: (c) => c === "osascript",
    platform: "darwin",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.cmd).toBe("osascript");
  expect(calls[0]?.args).toEqual(["-e", 'display notification "Body" with title "Title"']);
});

test("darwin WITHOUT osascript → no-op (falls through, notify-send also absent)", () => {
  const { calls, spawn } = spawnSpy();
  notify("t", "b", { env: {}, spawn, has: () => false, platform: "darwin" });
  expect(calls).toEqual([]);
});

test("linux + notify-send present → notify-send title body", () => {
  const { calls, spawn } = spawnSpy();
  notify("Title", "Body", {
    env: {},
    spawn,
    has: (c) => c === "notify-send",
    platform: "linux",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.cmd).toBe("notify-send");
  expect(calls[0]?.args).toEqual(["Title", "Body"]);
});

test("linux WITHOUT notify-send → silent no-op", () => {
  const { calls, spawn } = spawnSpy();
  notify("t", "b", { env: {}, spawn, has: () => false, platform: "linux" });
  expect(calls).toEqual([]);
});

test("a throwing spawn is caught — notify never throws (best-effort)", () => {
  expect(() =>
    notify("t", "b", {
      env: {},
      has: () => true,
      platform: "darwin",
      spawn: () => {
        throw new Error("boom");
      },
    }),
  ).not.toThrow();
});

test("asStr escapes backslash and double-quote in both title and body", () => {
  const { calls, spawn } = spawnSpy();
  notify('a"b\\c', 'x"y\\z', {
    env: {},
    spawn,
    has: (c) => c === "osascript",
    platform: "darwin",
  });
  // \  → \\  and  " → \"  inside the AppleScript string literals.
  expect(calls[0]?.args[1]).toBe('display notification "x\\"y\\\\z" with title "a\\"b\\\\c"');
});

test("default spawn seam shells the notifier (real defaultSpawn path)", () => {
  // Exercise the NON-injected spawn branch (defaultSpawn → node:child_process
  // spawnSync) without a real popup: bun implements node's spawnSync on top of
  // Bun.spawnSync, so patching that intercepts the call. Restored in finally.
  const orig = Bun.spawnSync;
  let called = false;
  (Bun as unknown as { spawnSync: (...a: unknown[]) => unknown }).spawnSync = () => {
    called = true;
    return {
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      exitCode: 0,
      success: true,
    };
  };
  try {
    notify("Title", "Body", { env: {}, has: () => true, platform: "darwin" });
  } finally {
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = orig;
  }
  // defaultSpawn ran through to node:child_process spawnSync (bun → Bun.spawnSync).
  expect(called).toBe(true);
});
