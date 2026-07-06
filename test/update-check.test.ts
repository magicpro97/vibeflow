import { describe, expect, test } from "bun:test";
import type { Channel } from "../src/logbus.js";
import {
  type UpdateCache,
  cmpSemver,
  fetchLatest,
  isValidVersion,
  notifyUpdate,
  readCache,
  refreshCacheInBackground,
  updateAvailableLine,
  updateCheck,
  updateCheckEnabled,
  writeCache,
} from "../src/update-check.js";

/** Capture out()-style calls without touching the real logbus. */
function makeSink() {
  const lines: string[] = [];
  const outFn = (_c: Channel, ...parts: unknown[]) => {
    lines.push(parts.filter((p) => typeof p === "string").join(" "));
  };
  return { lines, outFn };
}

/** Minimal Response stub for fetchLatest. */
function res(ok: boolean, body: unknown): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe("cmpSemver", () => {
  test("orders major/minor/patch", () => {
    expect(cmpSemver("1.0.0", "0.9.9")).toBe(1);
    expect(cmpSemver("0.12.1", "0.12.2")).toBe(-1);
    expect(cmpSemver("0.12.1", "0.12.1")).toBe(0);
    expect(cmpSemver("0.2.0", "0.1.9")).toBe(1);
  });
  test("ignores prerelease/build suffix and coerces junk to 0", () => {
    expect(cmpSemver("1.0.0-beta.1", "1.0.0")).toBe(0);
    expect(cmpSemver("1.0.0+build", "1.0.0")).toBe(0);
    expect(cmpSemver("x.y.z", "0.0.0")).toBe(0);
    expect(cmpSemver("1.2", "1.2.0")).toBe(0); // missing patch → 0
  });
});

describe("isValidVersion", () => {
  test("accepts plain and suffixed semver", () => {
    for (const v of ["1.2.3", "0.12.1", "1.0.0-rc.1", "1.2.3+build", "10.20.30-beta.2+meta"]) {
      expect(isValidVersion(v)).toBe(true);
    }
  });
  test("rejects ANSI/control chars, junk, and short forms", () => {
    for (const v of ["0.13.0\x1b[31mINJECTED", "\x1b[2Jhack", "1.2", "latest", "", "1.2.x"]) {
      expect(isValidVersion(v)).toBe(false);
    }
  });
});

describe("fetchLatest", () => {
  test("returns the version string on a 2xx JSON body", async () => {
    const v = await fetchLatest({ fetch: async () => res(true, { version: "9.9.9" }) });
    expect(v).toBe("9.9.9");
  });
  test("returns null on non-2xx", async () => {
    expect(await fetchLatest({ fetch: async () => res(false, {}) })).toBeNull();
  });
  test("returns null when version is missing/non-string", async () => {
    expect(await fetchLatest({ fetch: async () => res(true, { version: 1 }) })).toBeNull();
  });
  test("returns null when version is a string but not valid semver (ANSI-injection guard)", async () => {
    expect(
      await fetchLatest({ fetch: async () => res(true, { version: "0.13.0\x1b[31mX" }) }),
    ).toBeNull();
  });
  test("requests the URL-encoded scoped-package path (%40scope%2Fname)", async () => {
    const urls: string[] = [];
    await fetchLatest({
      fetch: async (url) => {
        urls.push(url);
        return res(true, { version: "1.0.0" });
      },
    });
    expect(urls[0]).toBe("https://registry.npmjs.org/%40magicpro97%2Fvibeflow/latest");
  });
  test("returns null when fetch throws (network/timeout)", async () => {
    expect(
      await fetchLatest({
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).toBeNull();
  });
});

describe("readCache / writeCache", () => {
  test("readCache parses a valid cache", () => {
    const cache = readCache({
      readFileSync: () => JSON.stringify({ checkedAt: 5, latest: "1.2.3" }),
    });
    expect(cache).toEqual({ checkedAt: 5, latest: "1.2.3" });
  });
  test("readCache returns null on malformed JSON", () => {
    expect(readCache({ readFileSync: () => "not-json" })).toBeNull();
  });
  test("readCache returns null on wrong shape", () => {
    expect(readCache({ readFileSync: () => JSON.stringify({ latest: 1 }) })).toBeNull();
  });
  test("readCache returns null on a poisoned non-semver latest (ANSI-injection guard)", () => {
    expect(
      readCache({
        readFileSync: () => JSON.stringify({ checkedAt: 5, latest: "9.9.9\x1b[31mX" }),
      }),
    ).toBeNull();
  });
  test("readCache returns null when checkedAt is not a finite number (corrupt-cache guard)", () => {
    // A corrupt/hand-edited cache can carry a null/string/NaN checkedAt. A bare
    // `typeof === "number"` would still pass NaN and wedge the TTL math
    // (now - NaN > TTL === false → refresh never fires); Number.isFinite rejects
    // null, NaN, and Infinity alike.
    expect(readCache({ readFileSync: () => '{"checkedAt": null, "latest": "1.2.3"}' })).toBeNull();
    expect(
      readCache({ readFileSync: () => '{"checkedAt": "oops", "latest": "1.2.3"}' }),
    ).toBeNull();
  });
  test("readCache returns null when the file is missing (read throws)", () => {
    expect(
      readCache({
        readFileSync: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBeNull();
  });
  test("writeCache persists via the injected writer", () => {
    const calls: Array<[string, string]> = [];
    writeCache(
      { checkedAt: 1, latest: "2.0.0" },
      {
        writeFileSafe: (p: string, data: string) => {
          calls.push([p, data]);
        },
      },
    );
    expect(calls[0]?.[0]).toContain("update-check.json");
    expect(JSON.parse(calls[0]?.[1] ?? "")).toEqual({ checkedAt: 1, latest: "2.0.0" });
  });
  test("writeCache swallows writer errors (best-effort)", () => {
    expect(() =>
      writeCache(
        { checkedAt: 1, latest: "2.0.0" },
        {
          writeFileSafe: () => {
            throw new Error("EROFS");
          },
        },
      ),
    ).not.toThrow();
  });
});

describe("updateAvailableLine", () => {
  test("names both versions and the install command", () => {
    const line = updateAvailableLine("0.12.1", "0.13.0");
    expect(line).toContain("0.12.1");
    expect(line).toContain("0.13.0");
    expect(line).toContain("npm i -g @magicpro97/vibeflow");
  });
});

describe("updateCheck (vf update-check)", () => {
  test("reports up-to-date when latest <= current and caches the result", async () => {
    const { lines, outFn } = makeSink();
    const caches: UpdateCache[] = [];
    const code = await updateCheck({
      fetch: async () => res(true, { version: "0.12.1" }),
      writeFileSafe: (_p: string, data: string) => {
        caches.push(JSON.parse(data));
      },
      now: () => 42,
      current: "0.12.1",
      outFn,
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("up to date");
    expect(caches[0]).toEqual({ checkedAt: 42, latest: "0.12.1" });
  });
  test("reports an update when latest > current", async () => {
    const { lines, outFn } = makeSink();
    const code = await updateCheck({
      fetch: async () => res(true, { version: "1.0.0" }),
      writeFileSafe: () => {},
      current: "0.12.1",
      outFn,
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Update available");
  });
  test("returns 1 and warns when the registry is unreachable", async () => {
    const { lines, outFn } = makeSink();
    const code = await updateCheck({
      fetch: async () => res(false, {}),
      current: "0.12.1",
      outFn,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Could not reach");
  });
});

describe("updateCheckEnabled", () => {
  test("enabled on an interactive shell with no opt-out", () => {
    expect(updateCheckEnabled({}, true)).toBe(true);
  });
  test("disabled via VIBEFLOW_NO_UPDATE_CHECK", () => {
    expect(updateCheckEnabled({ VIBEFLOW_NO_UPDATE_CHECK: "1" }, true)).toBe(false);
  });
  test("disabled in CI", () => {
    expect(updateCheckEnabled({ CI: "true" }, true)).toBe(false);
  });
  test("disabled on a non-TTY (piped) stdout", () => {
    expect(updateCheckEnabled({}, false)).toBe(false);
  });
});

describe("refreshCacheInBackground", () => {
  test("writes the cache when a version is fetched", async () => {
    const written: UpdateCache[] = [];
    await refreshCacheInBackground({
      fetch: async () => res(true, { version: "3.0.0" }),
      writeCache: (cache) => {
        written.push(cache);
      },
      now: () => 7,
    });
    expect(written[0]).toEqual({ checkedAt: 7, latest: "3.0.0" });
  });
  test("does nothing when the fetch fails", async () => {
    const writes: true[] = [];
    await refreshCacheInBackground({
      fetch: async () => res(false, {}),
      writeCache: () => {
        writes.push(true);
      },
    });
    expect(writes.length).toBe(0);
  });
});

describe("notifyUpdate (passive banner)", () => {
  const enabledEnv = {};
  test("prints the nudge from a fresh cache with a newer version", () => {
    const { lines, outFn } = makeSink();
    const refreshes: true[] = [];
    notifyUpdate({
      env: enabledEnv,
      isTTY: true,
      now: () => 1000,
      current: "0.12.1",
      readCache: () => ({ checkedAt: 900, latest: "0.13.0" }),
      refresh: () => {
        refreshes.push(true);
      },
      outFn,
    });
    expect(lines.join("\n")).toContain("Update available");
    expect(refreshes.length).toBe(0); // cache fresh → no refresh
  });
  test("stays silent when the cache shows we are current", () => {
    const { lines, outFn } = makeSink();
    notifyUpdate({
      env: enabledEnv,
      isTTY: true,
      now: () => 1000,
      current: "0.13.0",
      readCache: () => ({ checkedAt: 900, latest: "0.13.0" }),
      refresh: () => {},
      outFn,
    });
    expect(lines.join("\n")).toBe("");
  });
  test("kicks a background refresh when the cache is stale", () => {
    const { outFn } = makeSink();
    const refreshes: true[] = [];
    notifyUpdate({
      env: enabledEnv,
      isTTY: true,
      now: () => 100_000_000,
      current: "0.12.1",
      readCache: () => ({ checkedAt: 0, latest: "0.12.1" }),
      refresh: () => {
        refreshes.push(true);
      },
      outFn,
    });
    expect(refreshes.length).toBe(1);
  });
  test("kicks a refresh when there is no cache at all", () => {
    const refreshes: true[] = [];
    notifyUpdate({
      env: enabledEnv,
      isTTY: true,
      current: "0.12.1",
      readCache: () => null,
      refresh: () => {
        refreshes.push(true);
      },
      outFn: () => {},
    });
    expect(refreshes.length).toBe(1);
  });
  test("is a no-op when disabled (opt-out env)", () => {
    const { lines, outFn } = makeSink();
    const refreshes: true[] = [];
    notifyUpdate({
      env: { VIBEFLOW_NO_UPDATE_CHECK: "1" },
      isTTY: true,
      readCache: () => ({ checkedAt: 0, latest: "9.9.9" }),
      refresh: () => {
        refreshes.push(true);
      },
      outFn,
    });
    expect(lines.join("\n")).toBe("");
    expect(refreshes.length).toBe(0);
  });
});

// Default-argument coverage: exercise the real `?? default` fallbacks so the
// injected-vs-default branches are both hit. These use the real network-free
// defaults but never assert on network behavior.
describe("default fallbacks", () => {
  test("updateCheckEnabled reads process env/TTY defaults without throwing", () => {
    expect(typeof updateCheckEnabled()).toBe("boolean");
  });
  test("notifyUpdate with default env is a safe no-op on a non-TTY", () => {
    // isTTY:false disables deterministically (no network, no output) while
    // leaving `env` to its process.env default — covering the default-arg arm.
    expect(() => notifyUpdate({ isTTY: false })).not.toThrow();
  });
  test("notifyUpdate default refresh arm runs the real background refresh (production wiring)", async () => {
    // opencode P2: every other test injects `refresh`, so the real default
    // `() => void refreshCacheInBackground()` arm — the one that could delay
    // exit — was never executed. Here we let it run with an injected fetch and
    // a stale/absent cache, then confirm it neither throws nor blocks.
    const fetched: string[] = [];
    // Stub the module-level fetch so the default refresh hits no network.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched.push("hit");
      return res(true, { version: "0.0.1" });
    }) as unknown as typeof fetch;
    try {
      // No `refresh` inject → the default arm fires refreshCacheInBackground().
      // No `readCache` inject with a stale-but-newer cache → stale (checkedAt 0)
      // so the refresh branch is taken; readCache stub returns a current cache
      // so no banner prints.
      notifyUpdate({
        env: {},
        isTTY: true,
        now: () => Number.MAX_SAFE_INTEGER,
        current: "0.0.1",
        readCache: () => ({ checkedAt: 0, latest: "0.0.1" }),
        outFn: () => {},
      });
      // The default refresh is fire-and-forget; give the microtask/await a tick.
      await new Promise((r) => setTimeout(r, 20));
      expect(fetched.length).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
