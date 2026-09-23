/**
 * The materializer's project gate: `projectClassification.enabled` must gate *implicit-create*
 * inference.
 *
 * The switch is read by the `/classify` route, but a create is the one path a message turn cannot
 * retry around — so with auto-classify OFF an implicit create has to stay in the catch-all
 * instead of being filed by a tier the user switched off. An explicit `project_id` is a caller
 * claim, not an inference, and keeps its path (including its hard failure on a corrupt registry).
 */
import { expect, test } from "bun:test";
import { CONVERSATION_DEFAULT_PROJECT_ID } from "../../src/orchestrator/conversation/conversation-catalog-contract.js";
import type { RuntimeCreateRequest } from "../../src/orchestrator/conversation/policy-registry.js";
import { ConversationRequestMaterializer } from "../../src/orchestrator/conversation/request-materializer.js";
import type { ConversationRuntimeOptions } from "../../src/orchestrator/conversation/runtime-options.js";
import type { ConversationRuntime } from "../../src/orchestrator/conversation/runtime.js";

const ALPHA = { id: "alpha", name: "Alpha", repos: ["/work/alpha"], goal: "Ship the alpha" };
const PROJECTS = {
  get: (id: string) => (id === ALPHA.id ? ALPHA : undefined),
  list: () => [ALPHA],
};

/** The narrow slice `manifest()` reads off the runtime; the rest is faked out deliberately. */
function materializer(projectClassificationEnabled?: () => boolean) {
  const runtime = { ids: (kind: string) => `${kind}-1` } as unknown as ConversationRuntime;
  const options = {
    projects: PROJECTS,
    ...(projectClassificationEnabled ? { projectClassificationEnabled } : {}),
  } as unknown as ConversationRuntimeOptions;
  return new ConversationRequestMaterializer(runtime, options, () => "2026-09-23T00:00:00.000Z");
}

/** Both deterministic tiers fire here: the topic mentions `alpha` and the root is in its repos. */
function request(projectId?: string): RuntimeCreateRequest {
  return {
    topic: "hand this to @alpha",
    policy: "brainstorm",
    maxRounds: 3,
    repoRoot: "/work/alpha/services/api",
    phase: 1,
    bindings: [],
    ...(projectId === undefined ? {} : { projectId }),
  };
}

test("auto-classify OFF keeps an implicit create in the catch-all", () => {
  expect(materializer(() => false).manifest(request()).project_id).toBe(
    CONVERSATION_DEFAULT_PROJECT_ID,
  );
});

test("auto-classify OFF still honours a caller-supplied project_id", () => {
  expect(materializer(() => false).manifest(request("alpha")).project_id).toBe("alpha");
});

test("auto-classify ON (and a runtime without the seam) binds both deterministic tiers", () => {
  expect(materializer(() => true).manifest(request()).project_id).toBe("alpha");
  expect(materializer().manifest(request()).project_id).toBe("alpha");
});
