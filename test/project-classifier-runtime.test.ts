/**
 * Coverage for the composition seams the route tests cannot reach: the classifier runtime's
 * FTS/AI wiring, the browser-route dispatch of the project namespace, and the error paths.
 *
 * These are the branches a real runtime takes and a stubbed test does not: an unavailable
 * `bun:sqlite` (the Node bundle), a retrieval port that throws, a supplier that rejects, and the
 * reset path when classification is switched off mid-session.
 */
import { describe, expect, test } from "bun:test";
import { openProjectIndex } from "../src/orchestrator/conversation/project-fts.js";
import {
  applyProjectClassificationSettings,
  coerceProjectClassificationSettings,
  mergeProjectClassificationSettings,
  resolveProjectClassificationEngine,
} from "../src/project-classification-settings.js";
import { handleConversationBrowserRoute } from "../src/server/conversation-browser-route.js";
import {
  CONVERSATION_PROJECT_ROUTE,
  handleConversationProjectRoute,
} from "../src/server/conversation-project-route.js";
import { projectClassifier } from "../src/skills/project-classifier-runtime.js";
import { createHomeProjectRuntime } from "../src/ui/src/conversation-home-projects.js";
import { groupConversationsByProject } from "../src/ui/src/project-rail-group.js";
import {
  buildProjectClassificationPatch,
  projectOverrideRows,
} from "../src/ui/src/project-settings-form.js";

/** Minimal catalog row: grouping reads only these four fields. */
function session(rootSessionId: string, projectId: string, sortUpdatedAt: string) {
  return {
    root_session_id: rootSessionId,
    sort_updated_at: sortUpdatedAt,
    root: { project_id: projectId },
    active: null,
  };
}

const PROJECTS = [
  {
    id: "alpha",
    name: "alpha-service",
    goal: "Ship the alpha release for the checkout flow",
    context: "checkout",
    repos: [] as string[],
  },
  {
    id: "beta",
    name: "beta-service",
    goal: "Unrelated billing work",
    context: "billing",
    repos: [] as string[],
  },
];

describe("project classifier runtime", () => {
  test("a distinctive message resolves through retrieval without any AI seam", async () => {
    const authority = projectClassifier(PROJECTS);
    const verdict = await authority.classify({ message: "checkout flow alpha release" });
    expect(verdict.project_id).toBe("alpha");
    expect(verdict.reason).toBe("fts");
  });

  test("a message naming no term falls through to the fallback", async () => {
    const authority = projectClassifier(PROJECTS);
    const verdict = await authority.classify({ message: "zzz" });
    expect(verdict.reason).toBe("fallback");
  });

  test("an exact repo match resolves without retrieval", async () => {
    const authority = projectClassifier([
      { id: "alpha", name: "alpha", repos: ["/work/alpha"], goal: "", context: "" },
    ]);
    const verdict = await authority.classify({ message: "anything", repo_root: "/work/alpha" });
    expect(verdict.reason).toBe("repo");
  });

  test("an @mention resolves without retrieval", async () => {
    const authority = projectClassifier(PROJECTS);
    const verdict = await authority.classify({ message: "please look at @beta now" });
    expect(verdict.reason).toBe("mention");
  });

  test("an empty registry still classifies, to the fallback", async () => {
    const authority = projectClassifier([]);
    const verdict = await authority.classify({ message: "checkout flow" });
    expect(verdict.project_id).toBe("idea");
  });

  test("a runtime with no index classifies without retrieval evidence", async () => {
    const authority = projectClassifier(PROJECTS, { openIndex: () => null });
    const verdict = await authority.classify({ message: "checkout flow alpha release" });
    expect(verdict.reason).toBe("fallback");
  });

  test("an opener that throws is the same as having no index", async () => {
    const authority = projectClassifier(PROJECTS, {
      openIndex: () => {
        throw new Error("bun:sqlite unavailable");
      },
    });
    expect((await authority.classify({ message: "checkout flow" })).reason).toBe("fallback");
  });

  test("a throwing search degrades to no evidence instead of failing the turn", async () => {
    const authority = projectClassifier(PROJECTS, {
      search: () => {
        throw new Error("index corrupt");
      },
    });
    expect((await authority.classify({ message: "checkout flow" })).reason).toBe("fallback");
  });

  test("a graph that cannot be indexed falls back to no retrieval", async () => {
    // A closed handle makes the descriptor transaction throw, which must not escape.
    const authority = projectClassifier(PROJECTS, {
      openIndex: () => {
        const db = openProjectIndex(":memory:");
        db.close();
        return db;
      },
    });
    expect((await authority.classify({ message: "checkout flow" })).reason).toBe("fallback");
  });

  test("an injected proposal seam is consulted only when retrieval is inconclusive", async () => {
    const asked: string[] = [];
    const authority = projectClassifier(PROJECTS, {
      openIndex: () => null,
      propose: async (request) => {
        asked.push(request.message);
        return { project_id: "beta", confidence: 0.8 };
      },
    });
    expect((await authority.classify({ message: "billing" })).reason).toBe("ai");
    expect(asked).toEqual(["billing"]);
  });

  test("a persisted classifier engine is honoured by the AI tier", async () => {
    const spawned: string[] = [];
    const seam = {
      bridge: "fake-bridge",
      openIndex: () => null,
      ownedRoute: async (request: { engine: string }) => {
        spawned.push(request.engine);
        return {
          attemptId: "classify",
          stdout: '{"project_id":"beta","confidence":0.8}',
          stderr: "",
          status: 0,
          timedOut: false,
        };
      },
    };
    // The stored engine reaches the spawned bridge instead of the seam's own fallback.
    const persisted = projectClassifier(PROJECTS, { ...seam, engine: "codex" });
    expect((await persisted.classify({ message: "billing" })).project_id).toBe("beta");
    expect(spawned).toEqual(["codex"]);

    // With no stored opinion the seam keeps its own fallback rather than guessing.
    const absent = projectClassifier(PROJECTS, { ...seam, engine: undefined });
    expect((await absent.classify({ message: "billing" })).reason).toBe("ai");
    expect(spawned).toEqual(["codex", "claude"]);
  });

  test("stored engine resolution prefers the project override over the global block", () => {
    const settings = {
      enabled: true,
      engine: { cli: "codex" as const, model: null, thinking: null },
    };
    expect(
      resolveProjectClassificationEngine({ settings, project: { engine: { cli: "copilot" } } }),
    ).toBe("copilot");
    expect(resolveProjectClassificationEngine({ settings })).toBe("codex");
    // Neither the project nor the global block names an engine: no opinion, not a guess.
    expect(
      resolveProjectClassificationEngine({
        settings: { enabled: true, engine: { cli: null, model: null, thinking: null } },
      }),
    ).toBeUndefined();
  });

  test("a deterministic tier resolves without ever consulting the model seam", async () => {
    const asked: string[] = [];
    const authority = projectClassifier(PROJECTS, {
      propose: async (request) => {
        asked.push(request.message);
        return { project_id: "beta", confidence: 0.9 };
      },
    });
    const verdict = await authority.classify({ message: "anything at @beta" });
    expect(verdict.reason).toBe("mention");
    expect(asked).toEqual([]);
  });
});

describe("project classification settings coercion", () => {
  test("an absent block materializes the defaults", () => {
    expect(coerceProjectClassificationSettings(undefined)).toEqual({
      enabled: true,
      engine: { cli: null, model: null, thinking: null },
    });
  });

  test("the read path materializes a complete block into the settings document", () => {
    // `applyProjectClassificationSettings` is what `readSettings` calls: it must always write a
    // complete block, so a settings document read by an older build still gets a live switch.
    type Holder = Parameters<typeof applyProjectClassificationSettings>[0];
    const out: Holder = {};
    applyProjectClassificationSettings(out, {
      enabled: false,
      engine: { cli: "codex", model: "gpt-5", thinking: "high" },
    });
    expect(out.projectClassification).toEqual({
      enabled: false,
      engine: { cli: "codex", model: "gpt-5", thinking: "high" },
    });
    const empty: Holder = {};
    applyProjectClassificationSettings(empty, undefined);
    expect(empty.projectClassification).toEqual({
      enabled: true,
      engine: { cli: null, model: null, thinking: null },
    });
  });

  test("garbage and blank fields degrade to null rather than a guessed engine", () => {
    expect(
      coerceProjectClassificationSettings({
        enabled: "yes",
        engine: { cli: "nope", model: "   ", thinking: "x".repeat(200) },
      }),
    ).toEqual({ enabled: true, engine: { cli: null, model: null, thinking: null } });
  });

  test("a model is bounded by its own limit, not the thinking length", () => {
    // A model identifier is opaque and engine-owned; reusing the 64-character thinking cap would
    // silently truncate a legitimate model name to null. Both fields coexist under distinct caps.
    const longModel = "m".repeat(100);
    expect(
      coerceProjectClassificationSettings({
        enabled: true,
        engine: { cli: "codex", model: longModel, thinking: "high" },
      }),
    ).toEqual({ enabled: true, engine: { cli: "codex", model: longModel, thinking: "high" } });
    // The thinking cap is unchanged at 64: 65 characters still degrades to null.
    expect(
      coerceProjectClassificationSettings({
        enabled: true,
        engine: { cli: "codex", model: longModel, thinking: "t".repeat(65) },
      }),
    ).toEqual({ enabled: true, engine: { cli: "codex", model: longModel, thinking: null } });
    // And the model's own cap still rejects an absurd name.
    expect(
      coerceProjectClassificationSettings({
        enabled: true,
        engine: { cli: "codex", model: "m".repeat(201), thinking: "high" },
      }),
    ).toEqual({ enabled: true, engine: { cli: "codex", model: null, thinking: "high" } });
  });

  test("a complete block round-trips, including a disabled switch", () => {
    expect(
      coerceProjectClassificationSettings({
        enabled: false,
        engine: { cli: "codex", model: "gpt-5", thinking: "high" },
      }),
    ).toEqual({ enabled: false, engine: { cli: "codex", model: "gpt-5", thinking: "high" } });
  });

  test("an omitted block on write keeps the prior value", () => {
    const current = {
      enabled: false,
      engine: { cli: "claude" as const, model: null, thinking: null },
    };
    expect(mergeProjectClassificationSettings({}, current)).toEqual(current);
    expect(mergeProjectClassificationSettings({ projectClassification: current }, current)).toEqual(
      current,
    );
  });
});

describe("project classification patch", () => {
  test("a complete global fieldset becomes the stored block", () => {
    expect(
      buildProjectClassificationPatch({
        autoClassify: false,
        engine: { cli: "codex", model: "gpt-5", thinking: "high" },
      }),
    ).toEqual({
      projectClassification: {
        enabled: false,
        engine: { cli: "codex", model: "gpt-5", thinking: "high" },
      },
    });
  });

  test("blank fields store null, meaning the engine default rather than a guess", () => {
    expect(
      buildProjectClassificationPatch({
        autoClassify: true,
        engine: { cli: "  ", model: "  ", thinking: "  " },
      }),
    ).toEqual({
      projectClassification: {
        enabled: true,
        engine: { cli: null, model: null, thinking: null },
      },
    });
  });

  test("an unknown CLI and an oversize thinking value are rejected by name", () => {
    expect(
      buildProjectClassificationPatch({
        autoClassify: true,
        engine: { cli: "nope", model: "", thinking: "" },
      }),
    ).toMatch(/CLI/u);
    expect(
      buildProjectClassificationPatch({
        autoClassify: true,
        engine: { cli: "codex", model: "", thinking: "x".repeat(500) },
      }),
    ).toMatch(/Thinking/u);
  });
});

describe("override row ordering", () => {
  test("rows are ordered by name, falling back to id", () => {
    expect(
      projectOverrideRows([
        { id: "zeta", name: "bravo" },
        { id: "alpha", name: "charlie" },
        { id: "missing-name" },
      ]).map((row) => row.id),
    ).toEqual(["zeta", "alpha", "missing-name"]);
  });
});

describe("rail tie-breaking", () => {
  test("groups with equal recency and equal names fall back to the project id", () => {
    const at = "2026-09-20T12:00:00.000Z";
    const folders = groupConversationsByProject(
      [session("root-b", "bravo", at), session("root-a", "alpha", at)],
      // Both projects report the same display name, so only the id can break the tie.
      [
        { id: "alpha", name: "same", goal: "" },
        { id: "bravo", name: "same", goal: "" },
      ],
    );
    expect(folders.map((folder) => folder.project_id)).toEqual(["alpha", "bravo"]);
  });
});

describe("project namespace dispatch through the browser route", () => {
  const authority = (overrides: Record<string, unknown> = {}) => ({
    sessions: { authorize: () => true },
    csrf: () => true,
    projects: {
      listProjects: () => [],
      ...overrides,
    },
  });

  test("a project path is served before the catalog namespace is parsed", async () => {
    const response = await handleConversationBrowserRoute(
      authority() as never,
      new Request(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.LIST}`, { method: "GET" }),
      new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.LIST}`),
    );
    expect(response?.status).toBe(200);
  });

  test("without a project authority the path falls through to the rest of the router", async () => {
    const response = await handleConversationBrowserRoute(
      { sessions: { authorize: () => true } } as never,
      new Request(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.LIST}`, { method: "GET" }),
      new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.LIST}`),
    );
    expect(response).toBeNull();
  });

  test("a mutation without CSRF is refused by the shared queue guard", async () => {
    const response = await handleConversationBrowserRoute(
      { sessions: { authorize: () => true }, projects: { listProjects: () => [] } } as never,
      new Request(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.MOVE}`, {
        method: "POST",
        body: JSON.stringify({ root_session_id: "root-1", project_id: "alpha" }),
        headers: { "content-type": "application/json" },
      }),
      new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.MOVE}`),
    );
    expect(response?.status).toBe(403);
  });

  test("a supplier that rejects is reported as a public error, not a crash", async () => {
    const response = await handleConversationProjectRoute(
      {
        sessions: { authorize: () => true },
        csrf: () => true,
        listProjects: () => [],
        moveProject: () => {
          throw new Error("re-bind failed");
        },
      },
      new Request(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.MOVE}`, {
        method: "POST",
        body: JSON.stringify({ root_session_id: "root-1", project_id: "alpha" }),
        headers: { "content-type": "application/json" },
      }),
      new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.MOVE}`),
    );
    expect(response?.status).toBeGreaterThanOrEqual(400);
    expect(response?.status).toBeLessThan(500);
  });

  test("a slug-shaped but unroutable path is left alone", async () => {
    const url = new URL("http://127.0.0.1/api/conversation-projects/not%2Fa%2Fslug");
    const response = await handleConversationBrowserRoute(
      authority() as never,
      new Request(url.href, { method: "PATCH" }),
      url,
    );
    expect(response).toBeNull();
  });

  test("a path segment that cannot be decoded is not a project id", async () => {
    // `%zz` is not valid percent-encoding, so decodeURIComponent throws inside the parser.
    const url = new URL("http://127.0.0.1/api/conversation-projects/%zz");
    const response = await handleConversationBrowserRoute(
      authority() as never,
      new Request(url.href, { method: "PATCH" }),
      url,
    );
    expect(response).toBeNull();
  });
});

describe("project runtime reset", () => {
  test("reset clears the chip and its error", async () => {
    const runtime = createHomeProjectRuntime({
      client: {
        listProjects: async () => [],
        classifyMessage: async () => ({ project_id: "alpha", confidence: 0.9, reason: "ai" }),
        updateProjectEngine: async () => {},
        moveConversation: async () => {},
        readProjectSettings: async () => null,
        writeProjectSettings: async () => null,
      },
      activeRootId: () => "root-1",
      activeProjectId: () => "idea",
      autoClassify: () => true,
    });
    await runtime.classifyAndPropose("move me");
    expect(runtime.suggestion.value).not.toBeNull();
    runtime.reset();
    expect(runtime.suggestion.value).toBeNull();
    expect(runtime.suggestionError.value).toBe("");
  });
});
