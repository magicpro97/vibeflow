import { describe, expect, test } from "bun:test";
import type { HookInput, HookResult } from "../src/core/types.js";
import {
  clearPending,
  getPending,
  listPending,
  onPendingResolved,
  registerPending,
  resolvePending,
} from "../src/server/pending-hooks.js";

const fakeInput: HookInput = { event: "pre-command", tool: "Bash", command: "rm -rf /tmp/test" };
const fakeResult: HookResult = {
  decision: "require_approval",
  risk: "high",
  reasons: ["dangerous"],
};

describe("pending-hooks", () => {
  // Reset state before each test
  function cleanup() {
    clearPending();
  }

  test("registerPending: registers and getPending returns it", () => {
    cleanup();
    registerPending("id1", fakeInput, fakeResult);
    const p = getPending("id1");
    expect(p).toBeDefined();
    expect(p?.id).toBe("id1");
    expect(p?.input.tool).toBe("Bash");
    cleanup();
  });

  test("getPending: returns undefined for unknown id", () => {
    cleanup();
    expect(getPending("nope")).toBeUndefined();
  });

  test("resolvePending: resolves and removes from map", () => {
    cleanup();
    let resolved: string | null = null;
    const promise = registerPending("id2", fakeInput, fakeResult);
    promise.then((d) => {
      resolved = d;
    });
    const ok = resolvePending("id2", "allow");
    expect(ok).toBe(true);
    expect(getPending("id2")).toBeUndefined();
    cleanup();
  });

  test("resolvePending: returns false for unknown id", () => {
    cleanup();
    expect(resolvePending("ghost", "block")).toBe(false);
  });

  test("onPendingResolved: callback fires when resolvePending called", () => {
    cleanup();
    const calls: string[] = [];
    registerPending("id3", fakeInput, fakeResult);
    onPendingResolved("id3", (d) => calls.push(d));
    resolvePending("id3", "block");
    expect(calls).toEqual(["block"]);
    cleanup();
  });

  test("onPendingResolved: fires immediately with block when already resolved (race)", () => {
    cleanup();
    // id not registered → already-resolved race
    const calls: string[] = [];
    onPendingResolved("missing-id", (d) => calls.push(d));
    expect(calls).toEqual(["block"]);
  });

  test("listPending: returns all pending entries", () => {
    cleanup();
    registerPending("a", fakeInput, fakeResult);
    registerPending("b", fakeInput, fakeResult);
    const list = listPending();
    expect(list.length).toBe(2);
    expect(list.map((x) => x.id).sort()).toEqual(["a", "b"]);
    cleanup();
  });

  test("clearPending: removes all entries", () => {
    registerPending("x", fakeInput, fakeResult);
    clearPending();
    expect(listPending()).toHaveLength(0);
    expect(getPending("x")).toBeUndefined();
  });
});
