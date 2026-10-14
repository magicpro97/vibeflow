const { describe, expect, test } = await import(String("bun:test"));
const { createFilesStore } = await import("../files-store.js");

describe("files-store diff", () => {
  test("toggleDiff opens a row through the injected dep and closes it without refetching", async () => {
    const seen: Array<[string, boolean, boolean]> = [];
    const store = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [], truncated: false }),
      readFile: async () => ({ ok: false, reason: "not found" }),
      diffPaths: async (path: string, staged: boolean, untracked: boolean) => {
        seen.push([path, staged, untracked]);
        return {
          ok: true,
          kind: "diff",
          text: "@@ -1 +1 @@\n-a\n+b",
          truncated: false,
          binary: false,
        };
      },
    });
    await store.toggleDiff("a.txt", false);
    expect(seen).toEqual([["a.txt", false, false]]);
    expect(store.state.diffFor).toEqual({ path: "a.txt", staged: false });
    expect(store.state.diff?.text).toBe("@@ -1 +1 @@\n-a\n+b");
    expect(store.state.diffLoading).toBe(false);
    expect(store.state.diffError).toBeNull();
    await store.toggleDiff("a.txt", false);
    expect(store.state.diffFor).toBeNull();
    expect(store.state.diff).toBeNull();
    expect(seen.length).toBe(1); // closing a row never refetches
  });

  test("toggleDiff forwards untracked and treats the staged flag as row identity", async () => {
    const seen: Array<[string, boolean, boolean]> = [];
    const store = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [], truncated: false }),
      readFile: async () => ({ ok: false, reason: "not found" }),
      diffPaths: async (path: string, staged: boolean, untracked: boolean) => {
        seen.push([path, staged, untracked]);
        return { ok: true, kind: "untracked", text: "", truncated: false, binary: false };
      },
    });
    await store.toggleDiff("new.txt", false, true);
    expect(seen).toEqual([["new.txt", false, true]]);
    expect(store.state.diff?.kind).toBe("untracked");
    await store.toggleDiff("new.txt", true, true);
    expect(seen).toEqual([
      ["new.txt", false, true],
      ["new.txt", true, true],
    ]);
    expect(store.state.diffFor).toEqual({ path: "new.txt", staged: true });
  });

  test("diff failures surface the reason or the thrown message and leave no text", async () => {
    const notOk = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [], truncated: false }),
      readFile: async () => ({ ok: false, reason: "not found" }),
      diffPaths: async () => ({ ok: false, reason: "no such path" }),
    });
    await notOk.toggleDiff("gone.txt", false);
    expect(notOk.state.diff).toBeNull();
    expect(notOk.state.diffError).toBe("no such path");
    expect(notOk.state.diffLoading).toBe(false);

    const throws = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [], truncated: false }),
      readFile: async () => ({ ok: false, reason: "not found" }),
      diffPaths: async () => {
        throw new Error("Server error 403");
      },
    });
    await throws.toggleDiff("huge.txt", false);
    expect(throws.state.diff).toBeNull();
    expect(throws.state.diffError).toBe("Server error 403");
    expect(throws.state.diffLoading).toBe(false);
  });

  test("a stale diff response never lands on the newer row", async () => {
    const pending = new Map<
      string,
      {
        resolve: (res: {
          ok: boolean;
          kind?: "diff" | "empty" | "untracked";
          text?: string;
          truncated?: boolean;
          binary?: boolean;
          reason?: string;
        }) => void;
        reject: (error: unknown) => void;
      }
    >();
    const store = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [], truncated: false }),
      readFile: async () => ({ ok: false, reason: "not found" }),
      diffPaths: (path: string) =>
        new Promise((resolve, reject) => {
          pending.set(path, { resolve, reject });
        }),
    });
    const slow = store.toggleDiff("slow.txt", false);
    const newer = store.toggleDiff("new.txt", false);
    pending.get("new.txt")?.resolve({
      ok: true,
      kind: "diff",
      text: "B",
      truncated: true,
      binary: true,
    });
    await newer;
    expect(store.state.diff).toEqual({ kind: "diff", text: "B", truncated: true, binary: true });
    expect(store.state.diffLoading).toBe(false);
    pending.get("slow.txt")?.reject(new Error("boom"));
    await slow;
    expect(store.state.diff?.text).toBe("B"); // the late earlier response is ignored
    expect(store.state.diffError).toBeNull();
    expect(store.state.diffLoading).toBe(false);
    expect(store.state.diffFor).toEqual({ path: "new.txt", staged: false });
  });

  test("a tree refetch closes the open diff and drops its state", async () => {
    let treeCalls = 0;
    const store = createFilesStore({
      fetchTree: async () => {
        treeCalls++;
        return { ok: true, entries: [{ path: "a.txt" }], truncated: false };
      },
      readFile: async () => ({ ok: false, reason: "not found" }),
      diffPaths: async () => ({
        ok: true,
        kind: "diff",
        text: "@@ -1 +1 @@\n-a\n+b",
        truncated: false,
        binary: false,
      }),
    });
    await store.load();
    await store.toggleDiff("a.txt", false);
    expect(store.state.diffFor).toEqual({ path: "a.txt", staged: false });
    await store.load();
    expect(treeCalls).toBe(2);
    expect(store.state.diffFor).toBeNull();
    expect(store.state.diff).toBeNull();
    expect(store.state.diffError).toBeNull();
  });

  test("an in-flight diff fetch cannot land after a tree refetch", async () => {
    const pending = new Map<
      string,
      (res: {
        ok: boolean;
        kind?: "diff" | "empty" | "untracked";
        text?: string;
        truncated?: boolean;
        binary?: boolean;
        reason?: string;
      }) => void
    >();
    const store = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [{ path: "a.txt" }], truncated: false }),
      readFile: async () => ({ ok: false, reason: "not found" }),
      diffPaths: () =>
        new Promise((resolve) => {
          pending.set("a.txt", resolve);
        }),
    });
    await store.load();
    const inflight = store.toggleDiff("a.txt", false);
    await store.load();
    pending.get("a.txt")?.({ ok: true, kind: "diff", text: "late", truncated: false });
    await inflight;
    expect(store.state.diffFor).toBeNull();
    expect(store.state.diff).toBeNull();
    expect(store.state.diffLoading).toBe(false);
  });
});
