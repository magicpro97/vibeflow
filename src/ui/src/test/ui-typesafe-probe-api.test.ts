/**
 * The probe's wire shape. The route compares `expectRepo` against the process-global active repo, so
 * the client must send the repository its view was read from - a body without it is refused, and the
 * "Test connection" button would fail on every install.
 */
const { describe, expect, test } = await import(String("bun:test"));
import { api } from "../api.js";

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      path: String(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return handler(String(url), init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("the System One probe client", () => {
  test("sends the repository the view was read from, on the probe path", async () => {
    const { calls, restore } = stubFetch(() => Response.json({ ok: true }));
    try {
      await api.typesafe.test("repo-a");
    } finally {
      restore();
    }
    expect(calls).toEqual([
      { path: "/api/typesafe/test", method: "POST", body: { expectRepo: "repo-a" } },
    ]);
  });
});
