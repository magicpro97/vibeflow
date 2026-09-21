/**
 * Behaviour of the project runtime: the suggestion gate, dismissal memory, and the confirm path.
 *
 * Redundant with the pure gate test by design. `isProjectSuggestionVisible` proves the *rule*;
 * these tests prove the runtime *applies* it — that a low-confidence `ai` verdict never reaches
 * the composer, that a dismissed proposal stays gone, and that confirm is the only thing that
 * calls the mover.
 */
const { describe, expect, test } = await import(String("bun:test"));
import {
  type HomeProjectClient,
  type HomeProjectRow,
  createHomeProjectRuntime,
} from "../conversation-home-projects.js";

const ROW: HomeProjectRow = {
  id: "alpha",
  name: "alpha-service",
  goal: "Ship the alpha",
  engine: { cli: "codex", model: null, thinking: "high" },
};

function harness(
  overrides: {
    autoClassify?: boolean;
    activeRootId?: string | null;
    activeProjectId?: string;
    classify?: HomeProjectClient["classifyMessage"];
    move?: HomeProjectClient["moveConversation"];
  } = {},
) {
  const moves: Array<{ root_session_id: string; project_id: string }> = [];
  const client: HomeProjectClient = {
    listProjects: async () => [ROW],
    classifyMessage:
      overrides.classify ??
      (async () => ({ project_id: "alpha", confidence: 0.5, reason: "fts" as const })),
    updateProjectEngine: async () => {},
    moveConversation: async (input) => {
      moves.push(input);
      if (overrides.move) await overrides.move(input);
    },
  };
  const activeRootId = "activeRootId" in overrides ? overrides.activeRootId : "root-1";
  const runtime = createHomeProjectRuntime({
    client,
    activeRootId: () => activeRootId ?? null,
    activeProjectId: () => overrides.activeProjectId ?? "idea",
    autoClassify: () => overrides.autoClassify ?? true,
  });
  return { runtime, moves };
}

describe("project suggestion gate", () => {
  test("a low-confidence ai verdict never reaches the chip", () => {
    const { runtime } = harness();
    runtime.propose({ project_id: "alpha", confidence: 0.5, reason: "ai" });
    expect(runtime.suggestion.value).toBeNull();
  });

  test("an ai verdict at the floor is offered", () => {
    const { runtime } = harness();
    runtime.propose({ project_id: "alpha", confidence: 0.6, reason: "ai" });
    expect(runtime.suggestion.value?.project_id).toBe("alpha");
  });

  test("a confident fts verdict at 0.31 is offered", () => {
    const { runtime } = harness();
    runtime.propose({ project_id: "alpha", confidence: 0.31, reason: "fts" });
    expect(runtime.suggestion.value?.project_id).toBe("alpha");
    expect(runtime.suggestion.value?.reason).toBe("fts");
  });

  test("deterministic tiers and the fallback propose nothing", () => {
    for (const reason of ["repo", "mention", "fallback"] as const) {
      const { runtime } = harness();
      runtime.propose({ project_id: "alpha", confidence: 1, reason });
      expect(runtime.suggestion.value).toBeNull();
    }
  });

  test("a verdict naming the conversation's own project is not a move", () => {
    const { runtime } = harness({ activeProjectId: "alpha" });
    runtime.propose({ project_id: "alpha", confidence: 0.9, reason: "ai" });
    expect(runtime.suggestion.value).toBeNull();
  });

  test("the switch being off suppresses every proposal", () => {
    const { runtime } = harness({ autoClassify: false });
    runtime.propose({ project_id: "alpha", confidence: 1, reason: "ai" });
    expect(runtime.suggestion.value).toBeNull();
  });

  test("no open conversation means no proposal", () => {
    const { runtime } = harness({ activeRootId: null });
    runtime.propose({ project_id: "alpha", confidence: 1, reason: "ai" });
    expect(runtime.suggestion.value).toBeNull();
  });

  test("a dismissed proposal does not come back for the same session and project", async () => {
    const { runtime } = harness();
    await runtime.classifyAndPropose("move me");
    expect(runtime.suggestion.value?.project_id).toBe("alpha");
    runtime.dismissSuggestion();
    expect(runtime.suggestion.value).toBeNull();
    await runtime.classifyAndPropose("move me");
    expect(runtime.suggestion.value).toBeNull();
  });

  test("a classification failure proposes nothing instead of erroring", async () => {
    const { runtime } = harness({
      classify: async () => {
        throw new Error("classifier down");
      },
    });
    await runtime.classifyAndPropose("move me");
    expect(runtime.suggestion.value).toBeNull();
  });
});

describe("project suggestion confirm", () => {
  test("confirm is the only path that moves, and it reports what the server did", async () => {
    const { runtime, moves } = harness();
    await runtime.classifyAndPropose("move me");
    expect(moves).toEqual([]);
    expect(await runtime.confirmSuggestion()).toBe(true);
    expect(moves).toEqual([{ root_session_id: "root-1", project_id: "alpha" }]);
    expect(runtime.suggestion.value).toBeNull();
  });

  test("a refused move keeps the chip with the server's own reason", async () => {
    const { runtime } = harness({
      move: async () => {
        throw new Error("This runtime cannot re-bind a conversation to another project yet.");
      },
    });
    await runtime.classifyAndPropose("move me");
    expect(await runtime.confirmSuggestion()).toBe(false);
    expect(runtime.suggestion.value?.project_id).toBe("alpha");
    expect(runtime.suggestionError.value).toContain("cannot re-bind");
    expect(runtime.suggestionBusy.value).toBe(false);
  });
});

describe("project registry read", () => {
  test("a failed registry read leaves the rail without names but does not throw", async () => {
    const runtime = createHomeProjectRuntime({
      client: {
        listProjects: async () => {
          throw new Error("registry unreadable");
        },
        classifyMessage: async () => ({ project_id: "idea", confidence: 0, reason: "fallback" }),
        updateProjectEngine: async () => {},
        moveConversation: async () => {},
      },
      activeRootId: () => "root-1",
      activeProjectId: () => "idea",
      autoClassify: () => true,
    });
    await runtime.loadProjects();
    expect(runtime.projects.value).toEqual([]);
    expect(runtime.projectsLoaded.value).toBe(true);
    expect(runtime.projectsError.value).toContain("registry unreadable");
  });
});
