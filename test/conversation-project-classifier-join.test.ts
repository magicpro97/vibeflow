/**
 * The classify join: one registry snapshot + the stored policy → the tier ladder, with the
 * resolved engine forwarded into the classifier's AI seam.
 *
 * The round-2 re-review proved this line was invisible: `resolveProjectClassificationEngine` was
 * pinned in unit and the seam's `engine` spread was pinned in the runtime, but the composition
 * *between* them could be replaced with `projectClassifier(projects, {})` while every one of the
 * 8856 tests stayed green. The join now lives in one named helper, and this file pins it end to
 * end: the engine the helper resolves is the engine the classifier factory receives.
 */
import { describe, expect, test } from "bun:test";
import {
  type ConversationProjectClassifierFactory,
  buildConversationProjectClassifier,
} from "../src/commands/conversation-http.js";
import type { ProjectClassificationSettings } from "../src/project-classification-settings.js";
import type { ProjectClassifierRuntimeSeams } from "../src/skills/project-classifier-runtime.js";

/** Registry rows as the classifier reads them: catalog fields plus the stored engine. */
const ROWS = [
  {
    id: "alpha",
    name: "alpha-service",
    repos: [] as readonly string[],
    engine: { cli: "copilot", model: null, thinking: "high" },
  },
  {
    id: "beta",
    name: "beta-service",
    repos: [] as readonly string[],
    engine: { cli: "claude", model: null, thinking: "high" },
  },
] as const;

const settings = (
  cli: ProjectClassificationSettings["engine"]["cli"],
): ProjectClassificationSettings => ({
  enabled: true,
  engine: { cli, model: null, thinking: null },
});

/** A classifier factory that records the seams it was handed and returns a recognizable verdict. */
function spyFactory() {
  const seen: ProjectClassifierRuntimeSeams[] = [];
  const build: ConversationProjectClassifierFactory = (projects, seams = {}) => {
    seen.push(seams);
    return {
      classify: async () => ({
        project_id: projects[0]?.id ?? "idea",
        confidence: 0.5,
        reason: "ai" as const,
      }),
    };
  };
  return { seen, build };
}

describe("the classifier engine join", () => {
  test("the conversation's own project override wins and reaches the AI seam", async () => {
    const { seen, build } = spyFactory();
    const authority = buildConversationProjectClassifier(
      ROWS,
      { settings: settings("claude"), project_id: "alpha" },
      build,
    );
    expect(seen).toEqual([{ engine: "copilot" }]);
    // The ladder the factory built is the one returned, not a second one built alongside it.
    expect(await authority.classify({ message: "billing" })).toEqual({
      project_id: "alpha",
      confidence: 0.5,
      reason: "ai",
    });
  });

  test("auto-classify OFF answers the fallback without building the ladder at all", async () => {
    const { seen, build } = spyFactory();
    const authority = buildConversationProjectClassifier(
      ROWS,
      { settings: { enabled: false, engine: { cli: "claude", model: null, thinking: null } } },
      build,
    );
    // The gate is server-side: OFF means the classifier — and therefore its AI seam — is never
    // constructed, whatever the browser does. `@alpha` would resolve deterministically if the
    // ladder ran, so this pins "OFF runs no tier", not "OFF runs the cheap tiers first".
    expect(seen).toEqual([]);
    expect(await authority.classify({ message: "@alpha please" })).toEqual({
      project_id: "idea",
      confidence: 0,
      reason: "fallback",
    });
  });

  test("the global classifier block is the fallback when no project is named", () => {
    const { seen, build } = spyFactory();
    buildConversationProjectClassifier(ROWS, { settings: settings("claude") }, build);
    expect(seen).toEqual([{ engine: "claude" }]);
  });

  test("an unknown project id falls back to the global block, not to the row order", () => {
    const { seen, build } = spyFactory();
    buildConversationProjectClassifier(
      ROWS,
      { settings: settings("claude"), project_id: "missing" },
      build,
    );
    expect(seen).toEqual([{ engine: "claude" }]);
  });

  test("neither the project nor the block names an engine: the seam is left unset", () => {
    const { seen, build } = spyFactory();
    buildConversationProjectClassifier(
      // A reachable "absent settings" input: the global block names no engine and no project is
      // forwarded, so the resolver has nothing to forward — the seam keeps its own fallback.
      ROWS,
      { settings: settings(null) },
      build,
    );
    // Not `engine: undefined`: the key is absent, so the seam keeps its own documented fallback
    // (`VF_REVIEW_ENGINE`, then the canonical engine order) instead of pinning a guess.
    expect(seen).toEqual([{}]);
  });
});
