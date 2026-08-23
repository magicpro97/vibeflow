import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentBinding,
  type MaterializeAgentBindingOptions,
  materializeAgentBinding,
  materializeWorkflowAgentBinding,
  previewAgentBinding,
} from "../src/agents/binding.js";
import type { Skill } from "../src/core.js";
import { filterEnv } from "../src/dispatch/env-filter.js";
import {
  createDockerRuntimeInspector,
  createIsolationLease,
  releaseIsolationLease,
} from "../src/dispatch/isolation.js";
import { isCanonicalSpawnOptionsProjection } from "../src/dispatch/session-types.js";
import { ConversationArtifactStore } from "../src/orchestrator/conversation/artifact-store.js";
import { DirectConversationPolicy } from "../src/orchestrator/conversation/direct-policy.js";
import { ConversationPolicyRegistry } from "../src/orchestrator/conversation/policy-registry.js";
import { ConversationOrchestrator } from "../src/orchestrator/conversation/service.js";
import { DurableArtifactRegistry } from "../src/orchestrator/trace/artifacts.js";
import { TraceStore } from "../src/orchestrator/trace/store.js";
import * as canonicalPreflight from "../src/preflight.js";
import { discoverSkills } from "../src/skills/discovery.js";

const realPreflightAll = canonicalPreflight.preflightAll;
let bindingProbeReady = true;
const bindingProbeOptions: Array<Parameters<typeof realPreflightAll>[1]> = [];
mock.module("../src/preflight.js", () => ({
  ...canonicalPreflight,
  preflightAll: (
    engines: Parameters<typeof realPreflightAll>[0],
    options: Parameters<typeof realPreflightAll>[1],
  ) => {
    if (!options?.cacheKey?.includes("vf-binding-")) return realPreflightAll(engines, options);
    bindingProbeOptions.push(options);
    return engines.map((engine) => ({
      engine,
      level:
        bindingProbeReady &&
        (options.probe === false || (options.probe === true && options.skipCache === true))
          ? ("ready" as const)
          : ("probe-failed" as const),
      detail: "hermetic binding preflight",
      checkedAt: "2026-08-22T00:00:00.000Z",
    }));
  },
}));

const roots: string[] = [];
const originalSkillsHome = process.env.VF_SKILLS_HOME;
afterEach(() => {
  bindingProbeReady = true;
  bindingProbeOptions.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalSkillsHome === undefined) Reflect.deleteProperty(process.env, "VF_SKILLS_HOME");
  else process.env.VF_SKILLS_HOME = originalSkillsHome;
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "vf-binding-"));
  roots.push(root);
  mkdirSync(join(root, ".vibeflow", "roles"), { recursive: true });
  process.env.VF_SKILLS_HOME = join(root, "test-home");
  return root;
}

const direct = (overrides: Partial<AgentBinding> = {}): AgentBinding => ({
  roleRef: "direct",
  engine: "claude",
  sessionMode: "replay",
  ...overrides,
});

function options(
  repoRoot: string,
  overrides: Partial<MaterializeAgentBindingOptions> = {},
): MaterializeAgentBindingOptions {
  // The two legacy properties keep the pre-repair implementation executable during RED.
  // The repaired binding ignores unknown caller authority and uses canonical discovery/readiness.
  return {
    repoRoot,
    phase: 1,
    taskText: "answer directly",
    engineVerified: true,
    skills: [],
    ...overrides,
  } as unknown as MaterializeAgentBindingOptions;
}

function containerLease(repoRoot: string, associatedRepo = repoRoot) {
  const containerId = `binding-${roots.length}`;
  const runtimeInspector = createDockerRuntimeInspector({
    run: () => ({
      Id: containerId,
      State: { Running: true },
      Mounts: [{ Source: associatedRepo, Destination: "/workspace" }],
    }),
  });
  return createIsolationLease({
    kind: "container",
    root: "/workspace",
    cwd: "/workspace",
    repoRoot: associatedRepo,
    evidence_ref: `binding-${Date.now()}`,
    containerId,
    runtimeInspector,
  });
}

function skillFile(root: string, relativeRoot: string, name: string, body: string): string {
  const dir = join(root, relativeRoot, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(
    path,
    [
      "---",
      `name: ${name}`,
      `description: ${name} test skill`,
      "status: verified",
      "triggers: [fabricated]",
      "---",
      "",
      body,
    ].join("\n"),
  );
  return path;
}

describe("AgentBinding materialization", () => {
  test("workflow materialization preserves the executable prompt and selected skill names exactly", () => {
    const root = repo();
    skillFile(root, join(".agents", "skills"), "fabricated", "disk authority");
    const prompt = "  byte-exact workflow prompt\r\nwith trailing whitespace  \n";
    const out = materializeWorkflowAgentBinding(
      {
        roleRef: "dispatch-runner",
        engine: "claude",
        sessionMode: "fresh",
        additionalSkillRefs: ["fabricated"],
      },
      options(root, { phase: 2, taskText: prompt }),
    );
    expect(out.spawn.rendered_prompt).toBe(prompt);
    expect(out.resolved.skills.map((skill) => skill.ref)).toEqual(["fabricated"]);
    expect(out.resolved.isolation).toBeNull();
    expect(bindingProbeOptions).toEqual([]);
  });

  test("workflow admits a default repo skill without opt-in isolation while conversation stays strict", () => {
    const root = repo();
    const dir = join(root, ".agents", "skills", "repo-law");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      [
        "---",
        "name: repo-law",
        "description: Always-on repository law",
        "status: verified",
        "type: repo",
        "---",
        "",
        "repo law body",
      ].join("\n"),
    );
    const binding: AgentBinding = {
      roleRef: "dispatch-runner",
      engine: "claude",
      sessionMode: "fresh",
    };
    const workflow = materializeWorkflowAgentBinding(
      binding,
      options(root, { phase: 2, taskText: "ordinary workflow task" }),
    );
    expect(workflow.resolved.skills.map((skill) => skill.ref)).toEqual(["repo-law"]);
    expect(workflow.spawn.rendered_prompt).toBe("ordinary workflow task");
    expect(() =>
      materializeAgentBinding(binding, options(root, { phase: 2, taskText: "ordinary task" })),
    ).toThrow(/live canonical isolation/i);
  });

  test.each(["opencode", "antigravity"] as const)(
    "workflow keeps %s compatibility without weakening conversation admission",
    (engine) => {
      const root = repo();
      const binding: AgentBinding = {
        roleRef: "dispatch-runner",
        engine,
        sessionMode: "fresh",
      };
      const workflow = materializeWorkflowAgentBinding(
        binding,
        options(root, { phase: 2, taskText: `workflow-${engine}` }),
      );
      expect(workflow.spawn.rendered_prompt).toBe(`workflow-${engine}`);
      expect(workflow.spawn.rendered_tools).toEqual([]);
      expect(workflow.spawn.sandbox).toBeNull();
      expect(() =>
        materializeAgentBinding(
          { ...binding, roleRef: "direct" },
          options(root, { phase: 2, taskText: "conversation" }),
        ),
      ).toThrow(/cannot enforce/i);
    },
  );

  test("preserves session mode, applies model override, and projects renderer authority", () => {
    const out = materializeAgentBinding(
      direct({ modelOverride: "claude-sonnet-4-5" }),
      options(repo()),
    );
    expect(out.resolved.sessionMode).toBe("replay");
    expect(out.spawn.sessionMode).toBe("replay");
    expect(out.resolved.model).toBe("claude-sonnet-4-5");
    expect(out.spawn.model).toBe("claude-sonnet-4-5");
    expect(out.resolved.tool_intents).toEqual(["read", "grep", "glob", "web"]);
    expect(out.spawn.rendered_tools).toEqual(["Read", "Grep", "Glob", "WebFetch"]);
    expect(out.spawn.sandbox).toBe("read-only");
    expect(out.spawn.rendered_prompt).toContain("direct");
    expect(out.spawn.provenance).toEqual(out.resolved.provenance);
    expect(out.spawn.trace_metadata).toEqual(out.resolved.trace_metadata);
    expect(out.spawn.env_policy.selectedEngine).toBe("claude");
    expect(isCanonicalSpawnOptionsProjection(out.spawn)).toBe(true);
    expect(Object.isFrozen(out.spawn)).toBe(true);
    expect(Object.isFrozen(out.spawn.rendered_tools)).toBe(true);
    expect(Object.isFrozen(out.spawn.provenance)).toBe(true);
    expect(Object.isFrozen(out.spawn.provenance.skillHashes)).toBe(true);
    expect(Object.isFrozen(out.spawn.trace_metadata)).toBe(true);
    expect(Object.isFrozen(out.spawn.trace_metadata.skill_resolved_hashes)).toBe(true);
  });

  test("materialization snapshots caller-owned binding selections before launch authority exists", () => {
    const binding = direct({ modelOverride: "claude-sonnet-4-5" });
    const out = materializeAgentBinding(binding, options(repo()));

    binding.roleRef = "reviewer";
    binding.engine = "codex";
    binding.modelOverride = "gpt-5.4";
    binding.sessionMode = "fresh";

    expect(out.resolved.role.spec.name).toBe("direct");
    expect(out.resolved.engine).toBe("claude");
    expect(out.resolved.model).toBe("claude-sonnet-4-5");
    expect(out.resolved.sessionMode).toBe("replay");
    expect(out.resolved.env_policy.selectedEngine).toBe("claude");
    expect(out.spawn).toMatchObject({
      engine: "claude",
      model: "claude-sonnet-4-5",
      sessionMode: "replay",
    });
  });

  test("Codex uses canonical model mapping and sandbox rather than unenforceable tool flags", () => {
    const out = materializeAgentBinding(
      direct({ engine: "codex", sessionMode: "fresh" }),
      options(repo()),
    );
    expect(out.resolved.model).toBe("gpt-5.4");
    expect(out.spawn.rendered_tools).toEqual([]);
    expect(out.spawn.sandbox).toBe("read-only");
  });

  test("an engine renderer that has no canonical RoleModel surface omits it", () => {
    const out = materializeAgentBinding(
      direct({ engine: "copilot", sessionMode: "fresh" }),
      options(repo(), { phase: 2 }),
    );
    expect(out.resolved.model).toBeNull();
    expect(out.spawn.model).toBeNull();
    expect(out.spawn.rendered_tools).toEqual(["Read", "Grep", "Glob", "WebFetch"]);
  });

  test("Phase 1 admits only live-probed built-in read-only Claude/Codex bindings", () => {
    const root = repo();
    expect(() =>
      materializeAgentBinding(direct({ engine: "copilot" }), {
        ...options(root),
        taskText: "x",
      } as MaterializeAgentBindingOptions),
    ).toThrow(/phase 1/i);
    expect(() =>
      materializeAgentBinding(direct({ roleRef: "cli-engine" }), {
        ...options(root),
        taskText: "x",
      } as MaterializeAgentBindingOptions),
    ).toThrow(/read-only/i);
    materializeAgentBinding(direct(), options(root));
    bindingProbeReady = false;
    expect(() =>
      materializeAgentBinding(direct(), {
        ...options(root),
        trustedReadinessResolver: () => [
          {
            engine: "claude",
            level: "ready",
            detail: "caller-forged readiness",
            checkedAt: "2026-08-22T00:00:00.000Z",
          },
        ],
      } as unknown as MaterializeAgentBindingOptions),
    ).toThrow(/verified engine/i);
  });

  test("read-only preview resolves unavailable engine authority without minting spawn authority", () => {
    const root = repo();
    bindingProbeReady = false;
    const preview = previewAgentBinding(direct(), options(root));
    expect(preview.engineAvailable).toBe(false);
    expect(preview.modelValid).toBe(true);
    expect(preview.resolved.engine).toBe("claude");
    expect(preview.resolved.role.spec.name).toBe("direct");
    expect("spawn" in preview).toBe(false);
    expect(Object.isFrozen(preview)).toBe(true);
    expect(() => materializeAgentBinding(direct(), options(root))).toThrow(/verified engine/i);
  });

  test("preview readiness never performs a live provider probe", () => {
    const preview = previewAgentBinding(direct(), options(repo()));
    expect(preview.engineAvailable).toBe(true);
    expect(bindingProbeOptions.at(-1)).toMatchObject({ probe: false });
    expect(bindingProbeOptions.at(-1)?.skipCache).not.toBe(true);
  });

  test("preview reports an unavailable engine even when it cannot enforce execution sandbox", async () => {
    const root = repo();
    const isolation = containerLease(root);
    bindingProbeReady = false;
    try {
      const preview = previewAgentBinding(
        direct({ engine: "antigravity", sessionMode: "fresh" }),
        options(root, { phase: 2, isolation }),
      );
      expect(preview.engineAvailable).toBe(false);
      expect(preview.modelValid).toBe(true);
      expect(preview.resolved).toMatchObject({ engine: "antigravity", sandbox: "read-only" });
      expect("spawn" in preview).toBe(false);
    } finally {
      await releaseIsolationLease(isolation);
    }
  });

  test("service dry-run reports unavailable readiness without materializing or launching", async () => {
    const root = repo();
    const isolation = containerLease(root);
    bindingProbeReady = false;
    const preview = previewAgentBinding(
      direct({ engine: "antigravity", sessionMode: "fresh" }),
      options(root, { phase: 2, isolation }),
    );
    const registry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const trace = new TraceStore({
      dir: join(root, "trace"),
      artifactRegistry: registry,
      eventId: () => "00000000-0000-4000-8000-000000000001",
      now: () => "2026-08-22T00:00:00.000Z",
    });
    let starts = 0;
    const service = new ConversationOrchestrator({
      traceStore: trace,
      artifactRegistry: registry,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: {
        start() {
          starts += 1;
          throw new Error("dry-run launched an engine");
        },
        async reconcileHistory() {
          throw new Error("dry-run reconciled an engine");
        },
      },
      policies: new ConversationPolicyRegistry([new DirectConversationPolicy()]),
      id: (kind) => `${kind}-preview`,
      now: () => "2026-08-22T00:00:00.000Z",
      async resolveDryRunRequest(request) {
        return {
          topic: request.topic,
          policy: request.policy ?? "direct",
          maxRounds: 1,
          repoRoot: root,
          phase: 2,
          bindings: [
            {
              participantId: "participant-preview",
              input: direct({ engine: "antigravity", sessionMode: "fresh" }),
              preview,
            },
          ],
        };
      },
      async rehydrateBinding() {
        throw new Error("dry-run rehydrated a binding");
      },
    });
    try {
      expect(await service.dryRun({ topic: "Preview", policy: "direct" })).toEqual({
        participants: [
          {
            participant_id: "participant-preview",
            role_ref: "direct",
            engine: "antigravity",
            model: null,
            engine_available: false,
            model_valid: true,
          },
        ],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      });
      expect(starts).toBe(0);
      expect(await service.events("conversation-preview", 0)).toBeNull();
    } finally {
      await releaseIsolationLease(isolation);
    }
  });

  test("Phase 2 repo overlay requires verified engine and a live canonical isolation lease", async () => {
    const root = repo();
    writeFileSync(
      join(root, ".vibeflow", "roles", "repo-direct.md"),
      [
        "---",
        "name: repo-direct",
        "extends: direct",
        "description: Repo direct",
        "---",
        "",
        "# Repo direct",
      ].join("\n"),
    );
    const binding = direct({ roleRef: "repo-direct" });
    const base = options(root, { phase: 2, taskText: "x" });
    expect(() => materializeAgentBinding(binding, { ...base, isolation: undefined })).toThrow(
      /live canonical isolation/i,
    );
    expect(() =>
      materializeAgentBinding(binding, {
        ...base,
        isolation: { kind: "container", cwd: root, evidence_ref: "forged" },
      }),
    ).toThrow(/live canonical isolation/i);

    const isolation = containerLease(root);
    const admitted = materializeAgentBinding(binding, {
      ...base,
      isolation,
    });
    expect(admitted.resolved.isolation).toEqual(isolation);
    expect(admitted.spawn.isolation).toEqual(isolation);
    const filtered = filterEnv(
      {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "selected",
        OPENAI_API_KEY: "other",
        GITHUB_TOKEN: "other",
      },
      admitted.spawn.env_policy,
      "linux",
    );
    expect(filtered.env.ANTHROPIC_API_KEY).toBe("selected");
    expect(filtered.env.OPENAI_API_KEY).toBeUndefined();
    expect(filtered.env.GITHUB_TOKEN).toBeUndefined();
    await releaseIsolationLease(isolation);
    expect(() => materializeAgentBinding(binding, { ...base, isolation })).toThrow(
      /live canonical isolation/i,
    );
  });

  test("rejects a branded isolation lease associated with a different repository", async () => {
    const root = repo();
    const unrelated = repo();
    writeFileSync(
      join(root, ".vibeflow", "roles", "repo-direct.md"),
      [
        "---",
        "name: repo-direct",
        "extends: direct",
        "description: Repo direct",
        "---",
        "",
        "# Repo direct",
      ].join("\n"),
    );
    const isolation = containerLease(root, unrelated);
    try {
      expect(() =>
        materializeAgentBinding(
          direct({ roleRef: "repo-direct" }),
          options(root, { phase: 2, isolation }),
        ),
      ).toThrow(/associated canonical repository/i);
    } finally {
      await releaseIsolationLease(isolation);
    }
  });

  test("rejects metadata-only isolation even for a built-in Phase 2 role", () => {
    const root = repo();
    expect(() =>
      materializeAgentBinding(direct(), {
        ...options(root, { phase: 2 }),
        isolation: { kind: "container", cwd: root, evidence_ref: "forged" },
      }),
    ).toThrow(/live canonical isolation/i);
  });

  test("binds every supplied Phase 2 lease to the exact requested repository", async () => {
    const root = repo();
    const unrelated = repo();
    const isolation = containerLease(unrelated);
    try {
      expect(() =>
        materializeAgentBinding(direct(), options(root, { phase: 2, isolation })),
      ).toThrow(/associated canonical repository/i);
    } finally {
      await releaseIsolationLease(isolation);
    }
  });

  test("fails closed for runtime-invalid engine and session values", () => {
    const root = repo();
    expect(() =>
      materializeAgentBinding({ ...direct(), engine: "unknown" } as unknown as AgentBinding, {
        ...options(root, { phase: 2 }),
      }),
    ).toThrow(/engine/i);
    expect(() =>
      materializeAgentBinding({ ...direct(), sessionMode: "reuse" } as unknown as AgentBinding, {
        ...options(root, { phase: 2 }),
      }),
    ).toThrow(/session mode/i);
  });

  test("canonical spawn factory rejects credential-shaped and local-path model overrides", () => {
    const root = repo();
    for (const modelOverride of [
      "provider/sk-abcdefghijklmnopqrstuvwxyz1234567890",
      "/tmp/private-model",
    ]) {
      expect(() => materializeAgentBinding(direct({ modelOverride }), options(root))).toThrow(
        /safe engine identifier/i,
      );
    }
  });

  test("caller-owned Skill objects and resolvedBody cannot become binding authority", async () => {
    const root = repo();
    const path = skillFile(root, join(".agents", "skills"), "fabricated", "disk authority");
    const discovered = discoverSkills(root);
    const canonical = discovered.find((skill) => skill.name === "fabricated");
    if (!canonical) throw new Error("missing canonical skill fixture");
    const forged = { ...canonical, path, resolvedBody: "CALLER FORGED BODY" } satisfies Skill;
    const isolation = containerLease(root);
    try {
      const out = materializeAgentBinding(direct({ additionalSkillRefs: ["fabricated"] }), {
        ...options(root, { phase: 2, isolation }),
        skills: [forged],
      } as unknown as MaterializeAgentBindingOptions);
      expect(out.spawn.rendered_prompt).toContain("disk authority");
      expect(out.spawn.rendered_prompt).not.toContain("CALLER FORGED BODY");
      expect(out.resolved.skills.map((skill) => skill.source)).toEqual(["repo"]);
    } finally {
      await releaseIsolationLease(isolation);
    }
  });

  test("Phase 1 rejects project-controlled engine-mirror skills", () => {
    const root = repo();
    skillFile(root, join(".agents", "skills"), "fabricated", "project mirror body");
    expect(() =>
      materializeAgentBinding(direct({ additionalSkillRefs: ["fabricated"] }), {
        ...options(root),
        skills: discoverSkills(root),
      } as unknown as MaterializeAgentBindingOptions),
    ).toThrow(/phase 1/i);
  });
});
