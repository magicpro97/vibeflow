const { describe, expect, test } = await import(String("bun:test"));
const { createFilesStore } = await import("../files-store.js");

describe("files-store", () => {
  test("load stores entries; select fetches a preview via the injected reader", async () => {
    const store = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [{ path: "a.txt" }], truncated: false }),
      readFile: async (path: string) => ({ ok: true, path, content: `body of ${path}` }),
    });
    await store.load();
    expect(store.state.loading).toBe(false);
    expect(store.state.entries.map((e) => e.path)).toEqual(["a.txt"]);
    await store.select("a.txt");
    expect(store.state.preview).toBe("body of a.txt");
    expect(store.state.previewError).toBeNull();
  });

  test("a rejected tree fetch surfaces the error and empty entries", async () => {
    const store = createFilesStore({
      fetchTree: async () => {
        throw new Error("boom");
      },
      readFile: async () => ({ ok: false, reason: "not found" }),
    });
    await store.load();
    expect(store.state.error).toBe("boom");
    expect(store.state.entries).toEqual([]);
  });

  test("ok:false (non-git repo) becomes the empty state, not a crash", async () => {
    const store = createFilesStore({
      fetchTree: async () => ({ ok: false, reason: "not a git repository" }),
      readFile: async () => ({ ok: false, reason: "not found" }),
    });
    await store.load();
    expect(store.state.entries).toEqual([]);
    expect(store.state.error).toBe("not a git repository");
  });

  test("preview failures surface the reason; a thrown read surfaces its message", async () => {
    const notOk = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [{ path: "big.bin" }], truncated: false }),
      readFile: async () => ({ ok: false, reason: "binary" }),
    });
    await notOk.select("big.bin");
    expect(notOk.state.preview).toBeNull();
    expect(notOk.state.previewError).toBe("binary");

    const throws = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [{ path: "huge.txt" }], truncated: false }),
      readFile: async () => {
        throw new Error("Server error 413"); // req() throws on 413/404/403 — real wire behavior
      },
    });
    await throws.select("huge.txt");
    expect(throws.state.preview).toBeNull();
    expect(throws.state.previewError).toBe("Server error 413");
  });

  test("toggle expands and collapses a directory path", async () => {
    const store = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [], truncated: false }),
      readFile: async () => ({ ok: false, reason: "not found" }),
    });
    store.toggle("src");
    expect(store.state.expanded.has("src")).toBe(true);
    store.toggle("src");
    expect(store.state.expanded.has("src")).toBe(false);
  });
});
