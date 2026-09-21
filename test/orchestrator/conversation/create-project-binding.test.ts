/**
 * Create-time project binding: the deterministic tiers actually run.
 *
 * The review flagged that `repo`/`mention` were unreachable end to end — the claim "the
 * conversation was already bound at creation" had no code behind it. These tests pin the two
 * tiers that make it true, and pin the deliberate exclusion of the inferred ones: a `repo` or
 * `@mention` match files the conversation before its first message, while `fts`/`ai` never do.
 */
import { expect, test } from "bun:test";
import { CONVERSATION_DEFAULT_PROJECT_ID } from "../../../src/orchestrator/conversation/conversation-catalog-contract.js";
import { resolveConversationProjectId } from "../../../src/orchestrator/conversation/conversation-project-binding.js";
import type { ClassifierProject } from "../../../src/orchestrator/conversation/project-classifier.js";

const ALPHA: ClassifierProject = {
  id: "alpha",
  name: "Alpha Service",
  repos: ["/work/alpha"],
  goal: "Ship the alpha",
};

const projects = {
  get: (id: string) => (id === ALPHA.id ? ALPHA : undefined),
  list: () => [ALPHA],
};

test("a conversation opened inside a project's repo is bound to it at creation", () => {
  expect(
    resolveConversationProjectId(projects, undefined, {
      topic: "Fix the flaky test",
      repo_root: "/work/alpha/services/api",
    }),
  ).toBe("alpha");
});

test("a topic naming a project binds it at creation", () => {
  expect(
    resolveConversationProjectId(projects, undefined, {
      topic: "please look at @alpha's retries",
      repo_root: "/somewhere/unrelated",
    }),
  ).toBe("alpha");
});

test("neither deterministic tier matching leaves the conversation unclassified", () => {
  expect(
    resolveConversationProjectId(projects, undefined, {
      topic: "just some words",
      repo_root: "/somewhere/unrelated",
    }),
  ).toBe(CONVERSATION_DEFAULT_PROJECT_ID);
});

test("a caller-supplied project_id wins over the deterministic tiers", () => {
  expect(
    resolveConversationProjectId(projects, "alpha", {
      topic: "nothing to infer",
      repo_root: "/somewhere/unrelated",
    }),
  ).toBe("alpha");
  expect(() =>
    resolveConversationProjectId(projects, "ghost", {
      topic: "nothing to infer",
      repo_root: "/work/alpha",
    }),
  ).toThrow("unknown project ghost");
});

test("a runtime without a registry list never auto-binds, it fails closed to the default", () => {
  // The narrow `get`-only port (the home-create broker) has no candidates to classify against.
  const narrow = { get: (id: string) => (id === "alpha" ? ALPHA : undefined) };
  expect(
    resolveConversationProjectId(narrow, undefined, {
      topic: "@alpha please",
      repo_root: "/work/alpha",
    }),
  ).toBe(CONVERSATION_DEFAULT_PROJECT_ID);
});
