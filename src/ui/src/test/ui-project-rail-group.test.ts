const { describe, expect, test } = await import(String("bun:test"));
import { AGENT_ENGINE } from "../../../core/agent-contract.js";
import {
  PROJECT_SUGGESTION_MIN_AI_CONFIDENCE,
  PROJECT_THINKING_VALUE_MAX_LENGTH,
  groupConversationsByProject,
  isProjectSuggestionVisible,
  projectDisplayName,
  projectGoalExcerpt,
  projectRailEntryOrder,
  projectSuggestionConfidenceLabel,
} from "../project-rail-group.js";
import { buildProjectEnginePatch } from "../project-settings-form.js";

const EARLY = "2026-09-20T10:00:00.000Z";
const LATE = "2026-09-20T12:00:00.000Z";

interface RailSession {
  root_session_id: string;
  sort_updated_at: string;
  root: { project_id?: string };
  active: { project_id?: string } | null;
}

function session(
  rootSessionId: string,
  projectId: string | undefined,
  sortUpdatedAt: string,
): RailSession {
  return {
    root_session_id: rootSessionId,
    sort_updated_at: sortUpdatedAt,
    root: projectId === undefined ? {} : { project_id: projectId },
    active: null,
  };
}

const REGISTRY = [
  { id: "hermes", name: "vibeflow-hermes-execution", goal: "Complete Draft v7 brainstorming" },
  { id: "bravo", name: "bravo-service", goal: "" },
  { id: "alpha", name: "alpha-service", goal: "Ship the alpha" },
];

describe("project rail grouping", () => {
  test("empty input renders no folders", () => {
    expect(groupConversationsByProject([], REGISTRY)).toEqual([]);
  });

  test("a session with no project id falls back to the default project", () => {
    const folders = groupConversationsByProject([session("root-1", undefined, EARLY)], REGISTRY);
    expect(folders).toHaveLength(1);
    expect(folders[0]?.project_id).toBe("idea");
    expect(folders[0]?.ideas).toBe(true);
    expect(folders[0]?.name).toBe("Ideas");
    expect(folders[0]?.goal).toBe("Unclassified conversations");
  });

  test("the active revision's project wins over the root revision's", () => {
    const item = session("root-1", "hermes", EARLY);
    item.active = { project_id: "alpha" };
    const folders = groupConversationsByProject([item], REGISTRY);
    expect(folders.map((folder) => folder.project_id)).toEqual(["alpha"]);
  });

  test("groups are ordered by their newest session, ties broken by name", () => {
    const folders = groupConversationsByProject(
      [
        session("root-hermes", "hermes", EARLY),
        session("root-alpha", "alpha", LATE),
        session("root-bravo", "bravo", LATE),
      ],
      REGISTRY,
    );
    expect(folders.map((folder) => folder.project_id)).toEqual(["alpha", "bravo", "hermes"]);
  });

  test("ideas stays last even when it holds the newest session", () => {
    const folders = groupConversationsByProject(
      [session("root-idea", "idea", LATE), session("root-alpha", "alpha", EARLY)],
      REGISTRY,
    );
    expect(folders.map((folder) => folder.project_id)).toEqual(["alpha", "idea"]);
    expect(folders.at(-1)?.ideas).toBe(true);
  });

  test("sessions keep catalog order inside their group", () => {
    const folders = groupConversationsByProject(
      [
        session("root-1", "hermes", LATE),
        session("root-2", "alpha", LATE),
        session("root-3", "hermes", EARLY),
      ],
      REGISTRY,
    );
    const hermes = folders.find((folder) => folder.project_id === "hermes");
    expect(hermes?.sessions.map((item) => item.root_session_id)).toEqual(["root-1", "root-3"]);
  });

  test("folder labels come from the registry and degrade to the slug", () => {
    const folders = groupConversationsByProject(
      [session("root-1", "hermes", LATE), session("root-2", "unregistered", EARLY)],
      REGISTRY,
    );
    const hermes = folders.find((folder) => folder.project_id === "hermes");
    const unknown = folders.find((folder) => folder.project_id === "unregistered");
    expect(hermes?.name).toBe("vibeflow-hermes-execution");
    expect(hermes?.goal).toBe("Complete Draft v7 brainstorming");
    expect(unknown?.name).toBe("unregistered");
    expect(unknown?.goal).toBe("");
    expect(projectDisplayName("idea", REGISTRY)).toBe("Ideas");
    expect(projectGoalExcerpt("alpha", REGISTRY)).toBe("Ship the alpha");
    expect(projectGoalExcerpt("missing", REGISTRY)).toBe("");
  });

  test("all-unparseable stamps still order by name, never by input order", () => {
    // `-Infinity - -Infinity` is NaN; a NaN delta would skip the name tiebreak and leave the
    // group order following map insertion. The documented order must hold regardless.
    const folders = groupConversationsByProject(
      [
        session("root-bravo", "bravo", "not a date"),
        session("root-alpha", "alpha", ""),
        session("root-hermes", "hermes", "2026-13-45T99:99:99.999Z"),
      ],
      REGISTRY,
    );
    expect(folders.map((folder) => folder.project_id)).toEqual(["alpha", "bravo", "hermes"]);
    // Input order reversed must produce the identical grouping order.
    const reversed = groupConversationsByProject(
      [
        session("root-hermes", "hermes", "2026-13-45T99:99:99.999Z"),
        session("root-alpha", "alpha", ""),
        session("root-bravo", "bravo", "not a date"),
      ],
      REGISTRY,
    );
    expect(reversed.map((folder) => folder.project_id)).toEqual(["alpha", "bravo", "hermes"]);
  });

  test("a parsable stamp still outranks an unparsable one on the same name", () => {
    const folders = groupConversationsByProject(
      [session("root-zzz", "zzz-project", "not a date"), session("root-aaa", "aaa-project", LATE)],
      [
        ...REGISTRY,
        { id: "zzz-project", name: "same-name", goal: "" },
        { id: "aaa-project", name: "same-name", goal: "" },
      ],
    );
    // Newest first: the parsable stamp wins even though the names tie.
    expect(folders.map((folder) => folder.project_id)).toEqual(["aaa-project", "zzz-project"]);
  });

  test("an unparsable stamp is treated as oldest, not as newer than a real one", () => {
    const folders = groupConversationsByProject(
      [session("root-old", "bravo", EARLY), session("root-bad", "alpha", "definitely not a date")],
      REGISTRY,
    );
    expect(folders.map((folder) => folder.project_id)).toEqual(["bravo", "alpha"]);
  });

  test("an empty registry groups everything under a single Ideas folder", () => {
    const folders = groupConversationsByProject(
      [session("root-1", "idea", LATE), session("root-2", "idea", EARLY)],
      [],
    );
    expect(folders).toHaveLength(1);
    expect(folders[0]?.sessions).toHaveLength(2);
  });

  test("visible entry order skips collapsed groups", () => {
    const folders = groupConversationsByProject(
      [
        session("root-hermes", "hermes", LATE),
        session("root-alpha", "alpha", EARLY),
        session("root-idea", "idea", EARLY),
      ],
      REGISTRY,
    );
    expect(projectRailEntryOrder(folders, new Set())).toEqual([
      "root-hermes",
      "root-alpha",
      "root-idea",
    ]);
    expect(projectRailEntryOrder(folders, new Set(["hermes", "idea"]))).toEqual(["root-alpha"]);
  });
});

describe("project suggestion gate", () => {
  test("the UI mirrors the classifier's acceptance floors", () => {
    // Values pinned against the orchestrator authorities in
    // test/project-ui-rail-authority.test.ts — the UI module cannot import them here
    // because the classifier and registry modules resolve `node:*`.
    expect(PROJECT_SUGGESTION_MIN_AI_CONFIDENCE).toBe(0.6);
    expect(PROJECT_THINKING_VALUE_MAX_LENGTH).toBe(64);
  });

  test("a confident fts hit is proposable at any confidence above zero", () => {
    expect(
      isProjectSuggestionVisible({
        reason: "fts",
        confidence: 0.31,
        project_id: "alpha",
        current_project_id: "idea",
      }),
    ).toBe(true);
  });

  test("an ai verdict below the floor is never proposable", () => {
    expect(
      isProjectSuggestionVisible({
        reason: "ai",
        confidence: 0.5,
        project_id: "alpha",
        current_project_id: "idea",
      }),
    ).toBe(false);
    expect(
      isProjectSuggestionVisible({
        reason: "ai",
        confidence: 0.6,
        project_id: "alpha",
        current_project_id: "idea",
      }),
    ).toBe(true);
  });

  test("deterministic tiers and the fallback never propose a move", () => {
    for (const reason of ["repo", "mention", "fallback"] as const) {
      expect(
        isProjectSuggestionVisible({
          reason,
          confidence: 1,
          project_id: "alpha",
          current_project_id: "idea",
        }),
      ).toBe(false);
    }
  });

  test("a suggestion naming the conversation's own project is not a move", () => {
    expect(
      isProjectSuggestionVisible({
        reason: "fts",
        confidence: 0.5,
        project_id: "alpha",
        current_project_id: "alpha",
      }),
    ).toBe(false);
  });

  test("only the ai tier carries a confidence trail", () => {
    expect(projectSuggestionConfidenceLabel({ reason: "ai", confidence: 0.72 })).toBe(
      "· 72% chắc chắn",
    );
    expect(projectSuggestionConfidenceLabel({ reason: "fts", confidence: 0.31 })).toBe("");
  });
});

describe("project engine override draft", () => {
  test("an empty row inherits and persists nothing", () => {
    expect(buildProjectEnginePatch({ id: "alpha", cli: "", model: "", thinking: "" })).toBeNull();
  });

  test("a complete row builds the engine patch", () => {
    expect(
      buildProjectEnginePatch({
        id: "alpha",
        cli: AGENT_ENGINE.CODEX,
        model: "gpt-5",
        thinking: "high",
      }),
    ).toEqual({ engine: { cli: "codex", model: "gpt-5", thinking: "high" } });
  });

  test("a blank model means the engine default, not an empty string", () => {
    expect(
      buildProjectEnginePatch({
        id: "alpha",
        cli: AGENT_ENGINE.CLAUDE,
        model: "   ",
        thinking: "low",
      }),
    ).toEqual({ engine: { cli: "claude", model: null, thinking: "low" } });
  });

  test("a partial row is rejected by field name", () => {
    expect(
      buildProjectEnginePatch({ id: "alpha", cli: AGENT_ENGINE.CODEX, model: "", thinking: "" }),
    ).toMatch(/thinking/iu);
    expect(
      buildProjectEnginePatch({ id: "alpha", cli: "", model: "gpt-5", thinking: "high" }),
    ).toMatch(/cli/iu);
    const oversize = buildProjectEnginePatch({
      id: "alpha",
      cli: AGENT_ENGINE.CODEX,
      model: "",
      thinking: "x".repeat(PROJECT_THINKING_VALUE_MAX_LENGTH + 1),
    });
    expect(oversize).toMatch(/thinking/iu);
    expect(
      buildProjectEnginePatch({ id: "alpha", cli: "nope", model: "", thinking: "high" }),
    ).toMatch(/cli/iu);
  });
});
