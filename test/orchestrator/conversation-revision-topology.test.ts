import { describe, expect, test } from "bun:test";
import { HOST_ACTION_KIND } from "../../src/actions/host-action-contract.js";
import type { MaterializedAgentBinding } from "../../src/agents/binding.js";
import { AGENT_ENGINE, AGENT_HOST_TOOL } from "../../src/core/agent-contract.js";
import { ROLE_SANDBOX } from "../../src/core/role-contract.js";
import { CONVERSATION_ROLE_NAME } from "../../src/core/role-name-contract.js";
import { applyConversationRevisionMutation } from "../../src/orchestrator/conversation/revision-action-manifest.js";
import {
  assertConversationTopologyMaterialization,
  materializeConversationTopologyAuthority,
  projectConversationRevisionTopology,
} from "../../src/orchestrator/conversation/revision-topology-authority.js";
import type {
  ConversationBinding,
  ConversationManifest,
} from "../../src/orchestrator/conversation/types.js";

const binding = (
  participantId: string,
  roleRef: string,
  engine: ConversationBinding["input"]["engine"],
  hostTools: ConversationBinding["host_tools"] = [],
): ConversationBinding => ({
  participant_id: participantId,
  host_tools: hostTools,
  input: {
    roleRef,
    engine,
    modelOverride: `${engine}-model`,
    sessionMode: "exact",
    additionalSkillRefs: [`${roleRef}-skill`],
  },
});

const manifest = (policy: string, bindings: ConversationBinding[]): ConversationManifest => ({
  version: "1.0",
  conversation_id: "conversation-topology",
  workflow_id: "workflow-topology",
  revision_id: "revision-topology",
  run_id: "run-topology",
  parent_conversation_id: null,
  parent_revision_id: null,
  topic: "Coordinate the implementation",
  policy,
  max_rounds: 4,
  baseline_enabled: false,
  evaluator_auto_added: false,
  repo_root: "/repo-does-not-need-to-exist",
  phase: 3,
  task_text: "Coordinate the implementation",
  bindings,
  created_at: "2026-08-28T00:00:00.000Z",
});

const directManifest = (): ConversationManifest =>
  manifest("direct", [
    binding("participant-direct", CONVERSATION_ROLE_NAME.DIRECT, AGENT_ENGINE.CLAUDE, [
      AGENT_HOST_TOOL.PROPOSE_ACTION,
    ]),
  ]);

const coordinateManifest = (): ConversationManifest =>
  manifest("coordinate", [
    binding(
      "participant-coordinator",
      CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR,
      AGENT_ENGINE.CLAUDE,
    ),
    binding("participant-web", "web-ui", AGENT_ENGINE.CODEX),
    binding("participant-docs", "doc-writer", AGENT_ENGINE.CODEX),
  ]);

const add = (
  roleRef: string = CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR,
  engine: ConversationBinding["input"]["engine"] = AGENT_ENGINE.CODEX,
) => ({
  type: "conversation.add_participant" as const,
  participant: { role_ref: roleRef, engine, model: null, skill_refs: [] },
});

function materialized(
  source: ConversationBinding,
  sandbox: (typeof ROLE_SANDBOX)[keyof typeof ROLE_SANDBOX],
  tools: Array<"read" | "write" | "edit" | "bash" | "grep" | "glob" | "web">,
  roleSource: "builtin" | "repo" = "builtin",
): MaterializedAgentBinding {
  return {
    resolved: {
      role: {
        source: roleSource,
        resolved_hash: `hash-${source.participant_id}`,
        metadata: {},
        spec: {
          name: source.input.roleRef,
          description: source.input.roleRef,
          body: source.input.roleRef,
          tools,
          model: "sonnet",
          sandbox,
        },
      },
      skills: [],
      engine: source.input.engine,
      model: source.input.modelOverride ?? null,
      sessionMode: source.input.sessionMode,
      tool_intents: tools,
      sandbox,
    },
  } as unknown as MaterializedAgentBinding;
}

describe("conversation revision topology authority", () => {
  test("atomically promotes direct to coordinate and retains the requested specialized executor", () => {
    const projected = projectConversationRevisionTopology({
      parent: directManifest(),
      action: add("web-ui"),
      idempotencyKey: "add-web-ui",
    });

    expect(projected.target.policy).toBe("coordinate");
    expect(projected.target.bindings.map(({ participant_id }) => participant_id)).toEqual([
      "participant-direct",
      expect.stringMatching(/^participant-[a-f0-9]{32}$/),
    ]);
    expect(projected.target.bindings.map(({ input }) => input.roleRef)).toEqual([
      CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR,
      "web-ui",
    ]);
    expect(projected.target.bindings.map(({ input }) => input.sessionMode)).toEqual([
      "fresh",
      "fresh",
    ]);
    expect(projected.target.bindings.map(({ host_tools }) => host_tools)).toEqual([[], []]);
    expect(projected.target.bindings[0]?.input.modelOverride).toBe("claude-model");
    expect(projected.target.bindings[0]?.input.additionalSkillRefs).toEqual(["direct-skill"]);
    expect(Object.getOwnPropertyDescriptor(projected, "authority")?.get).toBeUndefined();
    expect(projected.before_authority.policy).toBe("direct");
    expect(projected.authority).toEqual(materializeConversationTopologyAuthority(projected.target));
    expect(projected.authority.topology_digest).not.toBe(
      projected.before_authority.topology_digest,
    );

    const coordinator = projected.target.bindings[0] as ConversationBinding;
    const executor = projected.target.bindings[1] as ConversationBinding;
    expect(() =>
      assertConversationTopologyMaterialization({
        manifest: projected.target,
        bindings: [
          materialized(coordinator, ROLE_SANDBOX.READ_ONLY, ["read"]),
          materialized(executor, ROLE_SANDBOX.WORKSPACE_WRITE, ["read", "edit", "bash"]),
        ],
      }),
    ).not.toThrow();
  });

  test("rejects same-engine, unsupported, and read-only executor authority", () => {
    expect(() =>
      applyConversationRevisionMutation({
        parent: directManifest(),
        action: add(CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR, AGENT_ENGINE.CLAUDE),
        idempotencyKey: "same-engine",
      }),
    ).toThrow("coordinate executor authority is invalid");
    expect(() =>
      applyConversationRevisionMutation({
        parent: directManifest(),
        action: add(CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR, AGENT_ENGINE.OPENCODE),
        idempotencyKey: "unsupported-engine",
      }),
    ).toThrow("coordinate executor authority is invalid");
    expect(() =>
      applyConversationRevisionMutation({
        parent: directManifest(),
        action: add(CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR, AGENT_ENGINE.COPILOT),
        idempotencyKey: "unauthenticated-output-engine",
      }),
    ).toThrow("coordinate executor authority is invalid");

    const target = applyConversationRevisionMutation({
      parent: directManifest(),
      action: add(CONVERSATION_ROLE_NAME.DIRECT),
      idempotencyKey: "read-only-executor",
    });
    const coordinator = target.bindings[0] as ConversationBinding;
    const executor = target.bindings[1] as ConversationBinding;
    expect(() =>
      assertConversationTopologyMaterialization({
        manifest: target,
        bindings: [
          materialized(coordinator, ROLE_SANDBOX.READ_ONLY, ["read"]),
          materialized(executor, ROLE_SANDBOX.READ_ONLY, ["read"]),
        ],
      }),
    ).toThrow("coordination executor role must have workspace-write authority");
  });

  test("rejects update and promotion paths that would admit Copilot coordination output", () => {
    expect(() =>
      applyConversationRevisionMutation({
        parent: coordinateManifest(),
        action: {
          type: HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT,
          participant_id: "participant-docs",
          changes: { engine: AGENT_ENGINE.COPILOT },
        },
        idempotencyKey: "update-executor-to-copilot",
      }),
    ).toThrow("coordinate executor authority is invalid");

    const legacyCopilotExecutor = coordinateManifest();
    (legacyCopilotExecutor.bindings[1] as ConversationBinding).input.engine = AGENT_ENGINE.COPILOT;
    expect(() =>
      applyConversationRevisionMutation({
        parent: legacyCopilotExecutor,
        action: {
          type: HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT,
          participant_id: "participant-coordinator",
        },
        idempotencyKey: "promote-copilot-executor",
      }),
    ).toThrow("coordinate executor authority is invalid");
  });

  test("preserves coordinate when an executor is removed and collapses N to one canonical direct", () => {
    const retainedCoordinate = applyConversationRevisionMutation({
      parent: coordinateManifest(),
      action: { type: "conversation.remove_participant", participant_id: "participant-web" },
      idempotencyKey: "remove-executor",
    });
    expect(retainedCoordinate.policy).toBe("coordinate");
    expect(retainedCoordinate.bindings.map(({ participant_id }) => participant_id)).toEqual([
      "participant-coordinator",
      "participant-docs",
    ]);

    const two = structuredClone(coordinateManifest());
    two.bindings = two.bindings.slice(0, 2);
    const collapsed = applyConversationRevisionMutation({
      parent: two,
      action: {
        type: "conversation.remove_participant",
        participant_id: "participant-coordinator",
      },
      idempotencyKey: "collapse-direct",
    });
    expect(collapsed.policy).toBe("direct");
    expect(collapsed.bindings).toMatchObject([
      {
        participant_id: "participant-web",
        host_tools: [AGENT_HOST_TOOL.PROPOSE_ACTION],
        input: {
          roleRef: CONVERSATION_ROLE_NAME.DIRECT,
          engine: AGENT_ENGINE.CODEX,
          sessionMode: "fresh",
        },
      },
    ]);
  });

  test("fails closed on policy/count drift but preserves a legacy custom direct continuation", () => {
    expect(() =>
      applyConversationRevisionMutation({
        parent: directManifest(),
        action: { type: "conversation.update_settings", changes: { policy: "coordinate" } },
        idempotencyKey: "invalid-coordinate-settings",
      }),
    ).toThrow("coordinate conversation topology is noncanonical");
    expect(() =>
      applyConversationRevisionMutation({
        parent: coordinateManifest(),
        action: { type: "conversation.update_settings", changes: { policy: "direct" } },
        idempotencyKey: "invalid-direct-settings",
      }),
    ).toThrow("direct conversation topology is noncanonical");

    const legacy = manifest("direct", [
      {
        participant_id: "participant-domain",
        input: {
          roleRef: "domain-reader",
          engine: AGENT_ENGINE.CODEX,
          sessionMode: "exact",
        },
      },
    ]);
    const continued = applyConversationRevisionMutation({
      parent: legacy,
      action: {
        type: "conversation.continue_message",
        content: "Continue",
        target_participants: "all",
      },
      idempotencyKey: "legacy-direct-continuation",
    });
    expect(continued.bindings[0]).toMatchObject({
      participant_id: "participant-domain",
      input: { roleRef: "domain-reader", sessionMode: "fresh" },
    });
    expect(continued.bindings[0]).not.toHaveProperty("host_tools");
  });

  test("rejects direct to debate before a proposal can own any durable mutation", () => {
    const source = directManifest();
    const before = structuredClone(source);

    expect(() =>
      projectConversationRevisionTopology({
        parent: source,
        action: { type: "conversation.update_settings", changes: { policy: "debate" } },
        idempotencyKey: "invalid-direct-to-debate",
      }),
    ).toThrow("debate conversation topology is noncanonical");
    expect(source).toEqual(before);
  });

  test("rejects coordinate to debate before a proposal can own any durable mutation", () => {
    const source = coordinateManifest();
    const before = structuredClone(source);

    expect(() =>
      projectConversationRevisionTopology({
        parent: source,
        action: { type: "conversation.update_settings", changes: { policy: "debate" } },
        idempotencyKey: "invalid-coordinate-to-debate",
      }),
    ).toThrow("debate conversation topology is noncanonical");
    expect(source).toEqual(before);
  });
});
