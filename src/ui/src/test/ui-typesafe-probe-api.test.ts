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

  test("a 409 keeps its status on the thrown error, so the drawer can word it as a refusal", async () => {
    // `req` throws on a non-2xx and keeps only the message, discarding the body's `refused: true`.
    // The moved-repository refusal is the route's only 409, and without the status on the error
    // the drawer rendered it as "System One connection failed" — the same defect class its own
    // wording branch was built to close.
    const { restore } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ ok: false, refused: true, error: "the active repository changed" }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    try {
      await api.typesafe.test("repo-a").then(
        () => {
          throw new Error("expected the 409 to throw");
        },
        (cause: unknown) => {
          expect((cause as { status?: number }).status).toBe(409);
          expect((cause as Error).message).toBe("the active repository changed");
        },
      );
    } finally {
      restore();
    }
  });
});
