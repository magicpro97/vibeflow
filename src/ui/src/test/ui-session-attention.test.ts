// "bun:test" is imported dynamically (String(...)) so vue-tsc (src/ui build)
// never sees the module dependency — repo pattern, same as ui-use-home-engines.test.ts.
const { describe, expect, test } = await import(String("bun:test"));
import {
  clearAttention,
  isAttentionLifecycle,
  mergeAttention,
  readAttention,
  writeAttention,
} from "../lib/session-attention.js";

const fact = (id: string, lifecycle: string | null) => ({ root_session_id: id, lifecycle });

describe("session attention", () => {
  test("marks only newly-terminal, non-active sessions", () => {
    const previous = [fact("a", "ACTIVE"), fact("b", "ACTIVE"), fact("c", "ACTIVE")];
    const next = [fact("a", "COMPLETED"), fact("b", "COMPLETED"), fact("c", "ACTIVE")];
    const merged = mergeAttention({}, previous, next, "b");
    expect(merged).toEqual({ a: true }); // b is active; c unchanged; first load marks nothing
  });

  test("a first refresh with no prior observation marks nothing", () => {
    expect(mergeAttention({}, [], [fact("a", "COMPLETED")], null)).toEqual({});
  });

  test("keeps previously held attention and drops vanished sessions", () => {
    expect(
      mergeAttention({ a: true }, [fact("a", "COMPLETED")], [fact("a", "COMPLETED")], null),
    ).toEqual({ a: true });
    expect(mergeAttention({ gone: true }, [], [], null)).toEqual({});
  });

  test("clears on selection and validates lifecycle membership", () => {
    expect(isAttentionLifecycle("COMPLETED")).toBe(true);
    expect(isAttentionLifecycle("NEEDS_INPUT")).toBe(true);
    expect(isAttentionLifecycle("ACTIVE")).toBe(false);
    expect(isAttentionLifecycle(null)).toBe(false);
    expect(clearAttention({ a: true, b: true }, "a")).toEqual({ b: true });
  });

  test("storage round-trip is defensive", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    writeAttention(storage, { a: true });
    expect(readAttention(storage)).toEqual({ a: true });
    store.set("vf-attention", "{not json");
    expect(readAttention(storage)).toEqual({});
    store.set("vf-attention", JSON.stringify({ a: "yes", long: "x".repeat(300) }));
    expect(readAttention(storage)).toEqual({});
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readAttention(throwing)).toEqual({});
    // Degradation path: a blocked/full storage must NOT throw out of writeAttention.
    const throwingWrite = {
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => writeAttention(throwingWrite, { a: true })).not.toThrow();
  });
});
