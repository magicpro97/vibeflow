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

  test("a slow earlier selection cannot overwrite a newer selection's preview", async () => {
    const resolvers = new Map<
      string,
      (res: { ok: boolean; content?: string; reason?: string }) => void
    >();
    const store = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [], truncated: false }),
      readFile: (path: string) =>
        new Promise((resolve) => {
          resolvers.set(path, resolve);
        }),
    });
    const slowFirst = store.select("a.txt");
    const second = store.select("b.txt");
    resolvers.get("b.txt")?.({ ok: true, content: "body of b" });
    await second;
    expect(store.state.preview).toBe("body of b");
    expect(store.state.previewLoading).toBe(false);
    resolvers.get("a.txt")?.({ ok: true, content: "body of a" });
    await slowFirst;
    expect(store.state.preview).toBe("body of b"); // the late earlier response is ignored
    expect(store.state.previewError).toBeNull();
    expect(store.state.previewLoading).toBe(false);
    expect(store.state.selected).toBe("b.txt");
  });

  test("a late failure of an earlier selection cannot poison the newer preview", async () => {
    const pending = new Map<
      string,
      {
        resolve: (res: { ok: boolean; content?: string; reason?: string }) => void;
        reject: (error: unknown) => void;
      }
    >();
    const store = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [], truncated: false }),
      readFile: (path: string) =>
        new Promise((resolve, reject) => {
          pending.set(path, { resolve, reject });
        }),
    });
    const failing = store.select("broken.txt");
    const good = store.select("good.txt");
    pending.get("good.txt")?.resolve({ ok: true, content: "body of good" });
    await good;
    pending.get("broken.txt")?.reject(new Error("boom"));
    await failing;
    expect(store.state.preview).toBe("body of good");
    expect(store.state.previewError).toBeNull(); // the stale failure is dropped
    expect(store.state.selected).toBe("good.txt");
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

  test("stage refetches the tree on success", async () => {
    let treeCalls = 0;
    const staged: string[][] = [];
    const store = createFilesStore({
      fetchTree: async () => {
        treeCalls++;
        return { ok: true, entries: [{ path: "a.txt" }], truncated: false };
      },
      readFile: async () => ({ ok: false, reason: "not found" }),
      stagePaths: async (paths: string[]) => {
        staged.push(paths);
        return { ok: true };
      },
    });
    await store.load();
    expect(treeCalls).toBe(1);
    await store.stage(["a.txt"]);
    expect(staged).toEqual([["a.txt"]]);
    expect(treeCalls).toBe(2);
    expect(store.state.staging).toBe(false);
    expect(store.state.error).toBeNull();
  });

  test("stage failure sets the error, skips the refetch, and resets staging for retry", async () => {
    let treeCalls = 0;
    let attempt = 0;
    const store = createFilesStore({
      fetchTree: async () => {
        treeCalls++;
        return { ok: true, entries: [], truncated: false };
      },
      readFile: async () => ({ ok: false, reason: "not found" }),
      stagePaths: async () => {
        attempt++;
        return attempt === 1 ? { ok: false, reason: "read-only workspace" } : { ok: true };
      },
    });
    await store.load();
    await store.stage(["a.txt"]);
    expect(store.state.error).toBe("read-only workspace");
    expect(treeCalls).toBe(1);
    expect(store.state.staging).toBe(false);
    await store.stage(["a.txt"]);
    expect(treeCalls).toBe(2);
    expect(store.state.error).toBeNull();
  });

  test("a thrown stage dep surfaces its message and resets staging", async () => {
    const store = createFilesStore({
      fetchTree: async () => ({ ok: true, entries: [], truncated: false }),
      readFile: async () => ({ ok: false, reason: "not found" }),
      stagePaths: async () => {
        throw new Error("Server error 403");
      },
    });
    await store.load();
    await store.stage(["a.txt"]);
    expect(store.state.error).toBe("Server error 403");
    expect(store.state.staging).toBe(false);
  });

  test("unstage mirrors stage: refetch on success, error without refetch on failure", async () => {
    let treeCalls = 0;
    const seen: string[][] = [];
    const store = createFilesStore({
      fetchTree: async () => {
        treeCalls++;
        return { ok: true, entries: [], truncated: false };
      },
      readFile: async () => ({ ok: false, reason: "not found" }),
      unstagePaths: async (paths: string[]) => {
        seen.push(paths);
        return seen.length === 1 ? { ok: true } : { ok: false, reason: "index locked" };
      },
    });
    await store.load();
    await store.unstage(["a.txt", "b.txt"]);
    expect(seen).toEqual([["a.txt", "b.txt"]]);
    expect(treeCalls).toBe(2);
    await store.unstage(["a.txt"]);
    expect(store.state.error).toBe("index locked");
    expect(treeCalls).toBe(2);
    expect(store.state.staging).toBe(false);
  });

  test("a second stage call while busy is ignored", async () => {
    const resolvers: Array<(res: { ok: boolean }) => void> = [];
    let treeCalls = 0;
    const store = createFilesStore({
      fetchTree: async () => {
        treeCalls++;
        return { ok: true, entries: [], truncated: false };
      },
      readFile: async () => ({ ok: false, reason: "not found" }),
      stagePaths: () => new Promise((resolve) => resolvers.push(resolve)),
    });
    await store.load();
    const first = store.stage(["a.txt"]);
    const second = store.stage(["b.txt"]);
    expect(store.state.staging).toBe(true);
    expect(resolvers.length).toBe(1);
    resolvers[0]?.({ ok: true });
    await Promise.all([first, second]);
    expect(treeCalls).toBe(2);
    expect(store.state.staging).toBe(false);
  });

  test("stage and toggleDiff without an injected dep are no-ops", async () => {
    let treeCalls = 0;
    const store = createFilesStore({
      fetchTree: async () => {
        treeCalls++;
        return { ok: true, entries: [], truncated: false };
      },
      readFile: async () => ({ ok: false, reason: "not found" }),
    });
    await store.load();
    await store.stage(["a.txt"]);
    await store.toggleDiff("a.txt", false);
    expect(treeCalls).toBe(1);
    expect(store.state.staging).toBe(false);
    expect(store.state.diffFor).toBeNull();
    expect(store.state.diff).toBeNull();
    expect(store.state.error).toBeNull();
  });
});
