/**
 * Create-time project binding: the deterministic tiers actually run.
 *
 * The review flagged that `repo`/`mention` were unreachable end to end — the claim "the
 * conversation was already bound at creation" had no code behind it. These tests pin the two
 * tiers that make it true, and pin the deliberate exclusion of the inferred ones: a `repo` or
 * `@mention` match files the conversation before its first message, while `fts`/`ai` never do.
 */
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATION_DEFAULT_PROJECT_ID } from "../../../src/orchestrator/conversation/conversation-catalog-contract.js";
import { resolveConversationProjectId } from "../../../src/orchestrator/conversation/conversation-project-binding.js";
import type { ClassifierProject } from "../../../src/orchestrator/conversation/project-classifier.js";
import { ProjectRegistryAuthority } from "../../../src/orchestrator/conversation/project-registry-authority.js";
import { ProjectRegistryCorruptError } from "../../../src/orchestrator/conversation/project-registry-store.js";

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

test("a longer handle that merely starts with a registered slug does not bind", () => {
  // `@alpha_beta` must not bind `alpha` at creation: the user addressed a different handle, and
  // a mention the ladder does not recognize has to leave the conversation in the catch-all.
  expect(
    resolveConversationProjectId(projects, undefined, {
      topic: "hand this to @alpha_beta",
      repo_root: "/somewhere/unrelated",
    }),
  ).toBe(CONVERSATION_DEFAULT_PROJECT_ID);
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

/**
 * The review's reproduction: a *valid* registry whose file mode was widened (any `rsync`,
 * `chmod -R`, or backup restore) is corruption to the store. At create time that must degrade the
 * inferred binding to the catch-all — a conversation is still creatable — instead of taking the
 * whole create funnel down with `ProjectRegistryCorruptError`.
 */
function widenedRegistry(): { root: string; registry: ProjectRegistryAuthority } {
  const root = mkdtempSync(join(tmpdir(), "vf-binding-corrupt-"));
  const registry = new ProjectRegistryAuthority({ root });
  registry.create({
    id: "alpha",
    name: "Alpha",
    goal: "g",
    engine: { cli: "codex", thinking: "medium" },
  });
  chmodSync(join(root, "registry.json"), 0o644);
  return { root, registry };
}

test("a corrupt registry degrades the inferred binding instead of failing the create", () => {
  const { root, registry } = widenedRegistry();
  try {
    expect(() => registry.list()).toThrow(ProjectRegistryCorruptError);
    expect(
      resolveConversationProjectId(registry, undefined, {
        topic: "@alpha please",
        repo_root: "/work/alpha",
      }),
    ).toBe(CONVERSATION_DEFAULT_PROJECT_ID);
    expect(
      resolveConversationProjectId(registry, undefined, {
        topic: "just some words",
        repo_root: "/somewhere/unrelated",
      }),
    ).toBe(CONVERSATION_DEFAULT_PROJECT_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a caller-supplied project_id still fails hard when the registry is corrupt", () => {
  const { root, registry } = widenedRegistry();
  try {
    // An explicit id is a caller claim, not a guess: answering it as the catch-all would file the
    // conversation where the caller did not ask for. The hard failure stays.
    expect(() =>
      resolveConversationProjectId(registry, "alpha", {
        topic: "nothing to infer",
        repo_root: "/somewhere/unrelated",
      }),
    ).toThrow(ProjectRegistryCorruptError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
