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
  createBrowserProjectDismissalStore,
  createHomeProjectRuntime,
} from "../conversation-home-projects.js";

const ROW: HomeProjectRow = {
  id: "alpha",
  name: "alpha-service",
  goal: "Ship the alpha",
  engine: { cli: "codex", model: null, thinking: "high" },
};

/** A promise whose resolution the test controls; the UI lib target has no `Promise.withResolvers`. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
  const refreshed: string[] = [];
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
    readProjectSettings: async () => null,
    writeProjectSettings: async () => null,
  };
  const activeRootId = "activeRootId" in overrides ? overrides.activeRootId : "root-1";
  const runtime = createHomeProjectRuntime({
    client,
    activeRootId: () => activeRootId ?? null,
    activeProjectId: () => overrides.activeProjectId ?? "idea",
    autoClassify: () => overrides.autoClassify ?? true,
    refreshSessions: () => {
      refreshed.push("sessions");
    },
  });
  return { runtime, moves, refreshed };
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

  test("a landed move re-reads the sessions the rail groups on", async () => {
    const { runtime, moves, refreshed } = harness();
    await runtime.classifyAndPropose("move me");
    expect(refreshed).toEqual([]);
    expect(await runtime.confirmSuggestion()).toBe(true);
    expect(moves).toHaveLength(1);
    // The rail groups `store.sessions`, not the registry: refreshing only the registry would tell
    // the user the move landed while the conversation stays under Ideas.
    expect(refreshed).toEqual(["sessions"]);
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

describe("project suggestion attribution", () => {
  test("a verdict landing after a session switch is dropped, never filed against the new one", async () => {
    let active = "root-1";
    const gate = createDeferred<{
      project_id: string;
      confidence: number;
      reason: "ai";
    }>();
    const runtime = createHomeProjectRuntime({
      client: {
        listProjects: async () => [ROW],
        classifyMessage: () => gate.promise,
        updateProjectEngine: async () => {},
        moveConversation: async () => {},
        readProjectSettings: async () => null,
        writeProjectSettings: async () => null,
      },
      activeRootId: () => active,
      activeProjectId: () => "idea",
      autoClassify: () => true,
    });
    const classification = runtime.classifyAndPropose("from the first conversation");
    // The user switches conversations while the classifier is still in flight.
    active = "root-2";
    gate.resolve({ project_id: "alpha", confidence: 0.9, reason: "ai" });
    await classification;
    // The old message's verdict must not become a proposal for the newly active conversation.
    expect(runtime.suggestion.value).toBeNull();
  });

  test("a verdict landing on the same session is still offered", async () => {
    const runtime = createHomeProjectRuntime({
      client: {
        listProjects: async () => [ROW],
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
    expect(runtime.suggestion.value?.root_session_id).toBe("root-1");
  });
});

describe("project dismissal memory", () => {
  function memory() {
    const values = new Map<string, string>();
    return {
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      },
      store: createBrowserProjectDismissalStore({
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      }),
    };
  }

  test("a dismissal survives a reload instead of returning the ignored proposal", () => {
    const { store } = memory();
    const client = {
      listProjects: async () => [ROW],
      classifyMessage: async () => ({
        project_id: "alpha",
        confidence: 0.9,
        reason: "ai" as const,
      }),
      updateProjectEngine: async () => {},
      moveConversation: async () => {},
      readProjectSettings: async () => null,
      writeProjectSettings: async () => null,
    };
    const first = createHomeProjectRuntime({
      client,
      activeRootId: () => "root-1",
      activeProjectId: () => "idea",
      autoClassify: () => true,
      dismissals: store,
    });
    first.propose({ project_id: "alpha", confidence: 0.9, reason: "ai" });
    first.dismissSuggestion();
    expect(first.suggestion.value).toBeNull();
    // A fresh runtime reads the same memory: the ignored (session, project) pair stays ignored.
    const reloaded = createHomeProjectRuntime({
      client,
      activeRootId: () => "root-1",
      activeProjectId: () => "idea",
      autoClassify: () => true,
      dismissals: store,
    });
    reloaded.propose({ project_id: "alpha", confidence: 0.9, reason: "ai" });
    expect(reloaded.suggestion.value).toBeNull();
  });

  test("a corrupt or non-string memory degrades to no dismissals instead of throwing", () => {
    const store = createBrowserProjectDismissalStore({
      getItem: () => "not json",
      setItem: () => {},
    });
    expect(store.read()).toEqual([]);
    const mixed = createBrowserProjectDismissalStore({
      getItem: () => JSON.stringify(["a\u0000b", 7, null]),
      setItem: () => {},
    });
    expect(mixed.read()).toEqual(["a\u0000b"]);
  });

  test("memory is bounded so a long-lived surface cannot grow the entry without limit", () => {
    let written = "";
    const store = createBrowserProjectDismissalStore({
      getItem: () => null,
      setItem: (_key, value) => {
        written = value;
      },
    });
    store.write(Array.from({ length: 300 }, (_, index) => `k${index}`));
    expect(JSON.parse(written)).toHaveLength(256);
  });

  test("a storage refusal on write does not undo the dismissal", () => {
    const runtime = createHomeProjectRuntime({
      client: {
        listProjects: async () => [ROW],
        classifyMessage: async () => ({ project_id: "alpha", confidence: 0.9, reason: "ai" }),
        updateProjectEngine: async () => {},
        moveConversation: async () => {},
        readProjectSettings: async () => null,
        writeProjectSettings: async () => null,
      },
      activeRootId: () => "root-1",
      activeProjectId: () => "idea",
      autoClassify: () => true,
      dismissals: {
        read: () => [],
        write: () => {
          throw new Error("storage full");
        },
      },
    });
    runtime.propose({ project_id: "alpha", confidence: 0.9, reason: "ai" });
    runtime.dismissSuggestion();
    expect(runtime.suggestion.value).toBeNull();
    // In-memory memory is still authoritative for this session.
    runtime.propose({ project_id: "alpha", confidence: 0.9, reason: "ai" });
    expect(runtime.suggestion.value).toBeNull();
  });

  test("memory is per (session, project): another conversation still gets its proposal", () => {
    const { store } = memory();
    const runtime = createHomeProjectRuntime({
      client: {
        listProjects: async () => [ROW],
        classifyMessage: async () => ({ project_id: "alpha", confidence: 0.9, reason: "ai" }),
        updateProjectEngine: async () => {},
        moveConversation: async () => {},
        readProjectSettings: async () => null,
        writeProjectSettings: async () => null,
      },
      activeRootId: () => "root-1",
      activeProjectId: () => "idea",
      autoClassify: () => true,
      dismissals: store,
    });
    runtime.propose({ project_id: "alpha", confidence: 0.9, reason: "ai" });
    runtime.dismissSuggestion();
    const other = createHomeProjectRuntime({
      client: {
        listProjects: async () => [ROW],
        classifyMessage: async () => ({ project_id: "alpha", confidence: 0.9, reason: "ai" }),
        updateProjectEngine: async () => {},
        moveConversation: async () => {},
        readProjectSettings: async () => null,
        writeProjectSettings: async () => null,
      },
      activeRootId: () => "root-2",
      activeProjectId: () => "idea",
      autoClassify: () => true,
      dismissals: store,
    });
    other.propose({ project_id: "alpha", confidence: 0.9, reason: "ai" });
    expect(other.suggestion.value?.root_session_id).toBe("root-2");
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
        readProjectSettings: async () => null,
        writeProjectSettings: async () => null,
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
