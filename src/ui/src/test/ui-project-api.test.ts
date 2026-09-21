/**
 * The project API client: the wire shapes the rail, the chip, and the settings panel depend on.
 *
 * The guards are the point of this half. A registry response missing `projects`, or a
 * classification response missing `project_id`, must fail loudly here rather than render an
 * undefined project name; and each write path must send exactly the body its route parses.
 */
const { describe, expect, test } = await import(String("bun:test"));
import type { HomeProjectRow } from "../conversation-home-projects.js";
import { conversationProjectApi } from "../conversation-project-api.js";

interface Call {
  path: string;
  method: string;
  body: unknown;
}

/** Stub `fetch`; the handler answers per path and records every call. */
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
  const restore = () => {
    globalThis.fetch = original;
  };
  return { calls, restore };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ROW: HomeProjectRow = {
  id: "alpha",
  name: "alpha-service",
  goal: "Ship the alpha",
  engine: { cli: "codex", model: null, thinking: "high" },
};

describe("conversation project API client", () => {
  test("the registry read parses rows and drops nothing the rail renders", async () => {
    const stub = stubFetch(() => json({ schema_version: "1.0", projects: [ROW] }));
    try {
      expect(await conversationProjectApi.listProjects()).toEqual([ROW]);
      expect(stub.calls[0]).toEqual({
        path: "/api/conversation-projects",
        method: "GET",
        body: undefined,
      });
    } finally {
      stub.restore();
    }
  });

  test("an unreadable registry response fails loudly instead of yielding empty rows", async () => {
    const stub = stubFetch(() => json({ schema_version: "1.0" }));
    try {
      await expect(conversationProjectApi.listProjects()).rejects.toThrow(
        "project registry response is unreadable",
      );
    } finally {
      stub.restore();
    }
  });

  test("classification carries the verdict verbatim and sends only the message", async () => {
    const stub = stubFetch(() =>
      json({ schema_version: "1.0", project_id: "alpha", confidence: 0.31, reason: "fts" }),
    );
    try {
      expect(
        await conversationProjectApi.classifyMessage({ message: "ship it", project_id: "idea" }),
      ).toEqual({ project_id: "alpha", confidence: 0.31, reason: "fts" });
      expect(stub.calls[0]?.body).toEqual({ message: "ship it" });
    } finally {
      stub.restore();
    }
  });

  test("a classification response missing its project_id is refused, never half-read", async () => {
    const stub = stubFetch(() => json({ schema_version: "1.0", reason: "fts" }));
    try {
      await expect(
        conversationProjectApi.classifyMessage({ message: "x", project_id: "idea" }),
      ).rejects.toThrow("classification response is unreadable");
    } finally {
      stub.restore();
    }
  });

  test("the engine override PATCHes the encoded project id with the engine body", async () => {
    const stub = stubFetch(() => json({ schema_version: "1.0" }));
    try {
      await conversationProjectApi.updateProjectEngine("alpha beta", ROW.engine);
      expect(stub.calls[0]).toEqual({
        path: "/api/conversation-projects/alpha%20beta",
        method: "PATCH",
        body: { engine: ROW.engine },
      });
    } finally {
      stub.restore();
    }
  });

  test("the move POSTs the session and project pair the route parses", async () => {
    const stub = stubFetch(() => json({ schema_version: "1.0", moved: true }, 202));
    try {
      await conversationProjectApi.moveConversation({
        root_session_id: "root-1",
        project_id: "alpha",
      });
      expect(stub.calls[0]).toEqual({
        path: "/api/conversation-projects/move",
        method: "POST",
        body: { root_session_id: "root-1", project_id: "alpha" },
      });
    } finally {
      stub.restore();
    }
  });

  test("a refused move surfaces the server's own reason", async () => {
    const stub = stubFetch(() =>
      json(
        {
          schema_version: "1.0",
          error: {
            code: "service_unavailable",
            message: "A revision operation is already in flight for this conversation.",
            correlation_id: "vf-http-1",
            retryable: true,
            recovery_action: "retry",
            details: null,
          },
        },
        503,
      ),
    );
    try {
      await expect(
        conversationProjectApi.moveConversation({ root_session_id: "r", project_id: "alpha" }),
      ).rejects.toThrow(/in flight/u);
    } finally {
      stub.restore();
    }
  });

  test("settings read and write use the settings document, block in and out", async () => {
    const stored = {
      enabled: true,
      engine: { cli: null, model: null, thinking: null },
    };
    const stub = stubFetch(() => json({ settings: { projectClassification: stored }, tools: [] }));
    try {
      expect(await conversationProjectApi.readProjectSettings()).toEqual(stored);
      expect(stub.calls[0]?.path).toBe("/api/settings");
      expect(
        await conversationProjectApi.writeProjectSettings({ ...stored, enabled: false }),
      ).toEqual(stored);
      expect(stub.calls[1]).toEqual({
        path: "/api/settings",
        method: "POST",
        body: { projectClassification: { ...stored, enabled: false } },
      });
    } finally {
      stub.restore();
    }
  });

  test("a settings document without the block reads as null, not as a fabricated default", async () => {
    const stub = stubFetch(() => json({ settings: {}, tools: [] }));
    try {
      expect(await conversationProjectApi.readProjectSettings()).toBeNull();
    } finally {
      stub.restore();
    }
  });
});
