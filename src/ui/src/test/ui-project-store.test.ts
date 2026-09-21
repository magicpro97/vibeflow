/**
 * The classification store: the durable switch, and how a proposal reaches the composer.
 *
 * Two behaviours here are the review's Criticals rather than decoration. The switch is read at
 * store construction (not when a preferences panel happens to mount), so OFF survives a reload;
 * and a proposal is announced through the composer's *existing* polite region instead of adding
 * a second live region.
 */
const { beforeEach, describe, expect, test } = await import(String("bun:test"));
import { createPinia, setActivePinia } from "pinia";
import type { HomeProjectRow } from "../conversation-home-projects.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import { useProjectClassificationStore } from "../project-classification-store.js";

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

const STORED = { enabled: true, engine: { cli: null, model: null, thinking: null } };

/** A fetch handler covering the three surfaces the store touches. */
const routes = (overrides: { settings?: unknown; move?: () => Response } = {}) => {
  return (url: string) => {
    if (url.endsWith("/move")) return overrides.move?.() ?? json({ schema_version: "1.0" }, 202);
    if (url === "/api/settings")
      return json({
        settings: { projectClassification: overrides.settings ?? STORED },
        tools: [],
      });
    if (url === "/api/conversation-projects")
      return json({ schema_version: "1.0", projects: [ROW] });
    return json({ schema_version: "1.0", project_id: "alpha", confidence: 0.9, reason: "ai" });
  };
};

describe("project classification store", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("the switch is read at store construction, not when a panel mounts", async () => {
    const stub = stubFetch(routes({ settings: { ...STORED, enabled: false } }));
    try {
      const store = useProjectClassificationStore();
      await store.loadSettings();
      expect(store.classificationEnabled).toBe(false);
      // OFF is the durable gate: no classification request is made at all.
      await store.classifyMessage("ship it");
      expect(stub.calls.some((call) => call.path.endsWith("/classify"))).toBe(false);
    } finally {
      stub.restore();
    }
  });

  test("toggling persists the block and keeps the stored engine fields", async () => {
    const stored = { enabled: true, engine: { cli: "codex", model: "gpt-5", thinking: "high" } };
    let saved: unknown = null;
    const stub = stubFetch((url, init) => {
      if (url === "/api/settings" && init.method === "POST") {
        saved = JSON.parse(String(init.body));
        return json({ settings: saved, tools: [] });
      }
      return routes({ settings: stored })(url);
    });
    try {
      const store = useProjectClassificationStore();
      await store.loadSettings();
      expect(store.classificationEnabled).toBe(true);
      expect(await store.setEnabled(false)).toBe(true);
      expect(store.classificationEnabled).toBe(false);
      expect(saved).toEqual({ projectClassification: { enabled: false, engine: stored.engine } });
    } finally {
      stub.restore();
    }
  });

  test("a refused settings write reverts the switch instead of claiming the value", async () => {
    const stub = stubFetch((url, init) => {
      if (url === "/api/settings" && init.method === "POST")
        return json(
          {
            schema_version: "1.0",
            error: {
              code: "invalid_request",
              message: "nope",
              correlation_id: "vf-1",
              retryable: false,
              recovery_action: null,
              details: null,
            },
          },
          400,
        );
      return routes()(url);
    });
    try {
      const store = useProjectClassificationStore();
      await store.loadSettings();
      expect(await store.setEnabled(false)).toBe(false);
      expect(store.classificationEnabled).toBe(true);
      expect(store.settingsError).not.toBe("");
    } finally {
      stub.restore();
    }
  });

  test("a failed settings read reports a reason and keeps classification on", async () => {
    const stub = stubFetch((url) => {
      if (url === "/api/settings")
        return json(
          {
            schema_version: "1.0",
            error: {
              code: "service_unavailable",
              message: "settings unavailable",
              correlation_id: "vf-2",
              retryable: true,
              recovery_action: "retry",
              details: null,
            },
          },
          503,
        );
      return routes()(url);
    });
    try {
      const store = useProjectClassificationStore();
      await store.loadSettings();
      // The message text is the settings client's own; this module's contract is "a reason and
      // the safe default", not the envelope's wording.
      expect(store.classificationEnabled).toBe(true);
      expect(store.settingsError).not.toBe("");
      // A second call is a no-op: the store reads once per process.
      await store.loadSettings();
      expect(store.settingsLoaded).toBe(true);
    } finally {
      stub.restore();
    }
  });

  test("a live proposal is announced through the composer region, with the registry name", async () => {
    const stub = stubFetch(routes());
    try {
      const home = useConversationHomeStore();
      const store = useProjectClassificationStore();
      await store.loadSettings();
      await store.refreshProjects();
      home.activeRootId = "root-1";
      store.propose({ project_id: "alpha", confidence: 0.9, reason: "ai" });
      expect(home.queueAnnouncement).toContain("alpha-service");
    } finally {
      stub.restore();
    }
  });

  test("a confirmed move announces the target and a failure leaves the text alone", async () => {
    let failing = false;
    const stub = stubFetch(
      routes({
        move: () =>
          failing
            ? json(
                {
                  schema_version: "1.0",
                  error: {
                    code: "service_unavailable",
                    message: "in flight",
                    correlation_id: "vf-3",
                    retryable: true,
                    recovery_action: "retry",
                    details: null,
                  },
                },
                503,
              )
            : json({ schema_version: "1.0", project_id: "alpha", moved: true }, 202),
      }),
    );
    try {
      const home = useConversationHomeStore();
      const store = useProjectClassificationStore();
      await store.loadSettings();
      await store.refreshProjects();
      home.activeRootId = "root-1";
      store.propose({ project_id: "alpha", confidence: 0.9, reason: "ai" });
      expect(await store.confirmSuggestion()).toBe(true);
      expect(home.queueAnnouncement).toBe("Đã chuyển sang alpha-service");

      failing = true;
      store.propose({ project_id: "alpha", confidence: 0.9, reason: "ai" });
      const before = home.queueAnnouncement;
      expect(await store.confirmSuggestion()).toBe(false);
      // The chip stays on screen with its reason, so its announcement must not be replaced.
      expect(home.queueAnnouncement).toBe(before);
    } finally {
      stub.restore();
    }
  });

  test("saving the whole block persists it and reports a refusal", async () => {
    let failing = false;
    let saved: unknown = null;
    const stub = stubFetch((url, init) => {
      if (url === "/api/settings" && init.method === "POST") {
        if (failing)
          return json(
            {
              schema_version: "1.0",
              error: {
                code: "invalid_request",
                message: "nope",
                correlation_id: "vf-4",
                retryable: false,
                recovery_action: null,
                details: null,
              },
            },
            400,
          );
        saved = JSON.parse(String(init.body));
        return json({ settings: saved, tools: [] });
      }
      return routes()(url);
    });
    const block = {
      enabled: false,
      engine: { cli: "codex" as const, model: null, thinking: "low" },
    };
    try {
      const store = useProjectClassificationStore();
      await store.loadSettings();
      expect(await store.saveSettings(block)).toBe(true);
      expect(saved).toEqual({ projectClassification: block });
      expect(store.classificationEnabled).toBe(false);

      failing = true;
      const prior = store.settings;
      expect(await store.saveSettings({ ...block, enabled: true })).toBe(false);
      // A refused write keeps the last known block rather than claiming the new one.
      expect(store.settings).toEqual(prior);
      expect(store.settingsError).not.toBe("");
    } finally {
      stub.restore();
    }
  });

  test("dismissing clears the announcement so a stale proposal is not read aloud", async () => {
    const stub = stubFetch(routes());
    try {
      const home = useConversationHomeStore();
      const store = useProjectClassificationStore();
      await store.loadSettings();
      await store.refreshProjects();
      home.activeRootId = "root-1";
      store.propose({ project_id: "alpha", confidence: 0.9, reason: "ai" });
      expect(home.queueAnnouncement).not.toBe("");
      store.dismissSuggestion();
      expect(home.queueAnnouncement).toBe("");
    } finally {
      stub.restore();
    }
  });
});
