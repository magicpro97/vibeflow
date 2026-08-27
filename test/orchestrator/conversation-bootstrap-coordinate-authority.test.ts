import { describe, expect, test } from "bun:test";
import type {
  AgentBinding,
  MaterializedAgentBinding,
  PreviewAgentBinding,
  ResolvedAgentBinding,
} from "../../src/agents/binding.js";
import { AGENT_ENGINE, AGENT_HOST_TOOL, AGENT_ROLE_SOURCE } from "../../src/core/agent-contract.js";
import { ROLE_MODEL, ROLE_SANDBOX, ROLE_TOOL_INTENT } from "../../src/core/role-contract.js";
import { CONVERSATION_ROLE_NAME, WORKFLOW_ROLE_NAME } from "../../src/core/role-name-contract.js";
import {
  type ConversationBindingFactory,
  createConversationRequestResolvers,
} from "../../src/orchestrator/conversation/bootstrap-request-resolution.js";
import { CONVERSATION_POLICY } from "../../src/orchestrator/conversation/conversation-policy-contract.js";
import { COORDINATE_TOPOLOGY_DIAGNOSTIC } from "../../src/orchestrator/conversation/router-helpers.js";
import type { ConversationCreateRequest } from "../../src/orchestrator/conversation/types.js";

interface BindingAuthorityOverride {
  readonly roleName?: string;
  readonly source?: typeof AGENT_ROLE_SOURCE.BUILTIN | typeof AGENT_ROLE_SOURCE.REPO;
  readonly sandbox?: typeof ROLE_SANDBOX.READ_ONLY | typeof ROLE_SANDBOX.WORKSPACE_WRITE;
  readonly tools?: readonly (typeof ROLE_TOOL_INTENT)[keyof typeof ROLE_TOOL_INTENT][];
}

const coordinateRequest = (): ConversationCreateRequest => ({
  topic: "Implement the approved change",
  policy: CONVERSATION_POLICY.COORDINATE,
  participants: [
    {
      role_ref: CONVERSATION_ROLE_NAME.DIRECT,
      engine: AGENT_ENGINE.CLAUDE,
      host_tools: [AGENT_HOST_TOOL.PROPOSE_ACTION],
    },
    {
      role_ref: WORKFLOW_ROLE_NAME.CLI_ENGINE,
      engine: AGENT_ENGINE.CODEX,
      host_tools: [AGENT_HOST_TOOL.PROPOSE_ACTION],
    },
  ],
});

function resolvedBinding(
  input: AgentBinding,
  override: BindingAuthorityOverride = {},
): ResolvedAgentBinding {
  const coordinator = input.roleRef === CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR;
  const sandbox =
    override.sandbox ?? (coordinator ? ROLE_SANDBOX.READ_ONLY : ROLE_SANDBOX.WORKSPACE_WRITE);
  const tools = [
    ...(override.tools ??
      (sandbox === ROLE_SANDBOX.READ_ONLY
        ? [ROLE_TOOL_INTENT.READ, ROLE_TOOL_INTENT.GREP]
        : [ROLE_TOOL_INTENT.READ, ROLE_TOOL_INTENT.WRITE])),
  ];
  const source = override.source ?? AGENT_ROLE_SOURCE.BUILTIN;
  const hash = `role-hash:${override.roleName ?? input.roleRef}`;
  return {
    role: {
      spec: {
        name: override.roleName ?? input.roleRef,
        description: "Test role authority",
        body: "Test role authority",
        tools,
        model: ROLE_MODEL.SONNET,
        sandbox,
      },
      source,
      resolved_hash: hash,
      metadata: {},
    },
    skills: [],
    engine: input.engine,
    model: null,
    sessionMode: input.sessionMode,
    tool_intents: tools,
    sandbox,
    env_policy: {} as never,
    isolation: null,
    provenance: { roleSource: source, roleHash: hash, skillHashes: [] },
    trace_metadata: { role_resolved_hash: hash, skill_resolved_hashes: [] },
  };
}

function bindingFactory(
  authority: (binding: AgentBinding) => BindingAuthorityOverride = () => ({}),
): ConversationBindingFactory {
  const resolve = (binding: AgentBinding) => resolvedBinding(binding, authority(binding));
  return {
    materialize(binding): MaterializedAgentBinding {
      return { resolved: resolve(binding), spawn: {} as never };
    },
    preview(binding): PreviewAgentBinding {
      return { resolved: resolve(binding), engineAvailable: true, modelValid: true };
    },
  };
}

function resolvers(factory: ConversationBindingFactory) {
  return createConversationRequestResolvers({
    options: {
      readiness: () => [
        { engine: AGENT_ENGINE.CLAUDE, ready: true, admitted: true },
        { engine: AGENT_ENGINE.COPILOT, ready: true, admitted: true },
        { engine: AGENT_ENGINE.CODEX, ready: true, admitted: true },
      ],
    },
    repoRoot: process.cwd(),
    phase: 1,
    binder: factory,
  });
}

describe("coordinate bootstrap authority", () => {
  test.each([
    {
      label: "writable coordinator",
      authority: (binding: AgentBinding): BindingAuthorityOverride =>
        binding.roleRef === CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR
          ? {
              sandbox: ROLE_SANDBOX.WORKSPACE_WRITE,
              tools: [ROLE_TOOL_INTENT.READ, ROLE_TOOL_INTENT.WRITE],
            }
          : {},
      diagnostic: COORDINATE_TOPOLOGY_DIAGNOSTIC.COORDINATOR_AUTHORITY_INVALID,
    },
    {
      label: "read-only executor",
      authority: (binding: AgentBinding): BindingAuthorityOverride =>
        binding.roleRef === WORKFLOW_ROLE_NAME.CLI_ENGINE
          ? { sandbox: ROLE_SANDBOX.READ_ONLY, tools: [ROLE_TOOL_INTENT.READ] }
          : {},
      diagnostic: COORDINATE_TOPOLOGY_DIAGNOSTIC.EXECUTOR_AUTHORITY_INVALID,
    },
    {
      label: "repo-shadowed coordinator",
      authority: (binding: AgentBinding): BindingAuthorityOverride =>
        binding.roleRef === CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR
          ? { source: AGENT_ROLE_SOURCE.REPO }
          : {},
      diagnostic: COORDINATE_TOPOLOGY_DIAGNOSTIC.COORDINATOR_AUTHORITY_INVALID,
    },
  ])("rejects $label after real materialization", async ({ authority, diagnostic }) => {
    await expect(
      resolvers(bindingFactory(authority)).resolveCreateRequest(coordinateRequest()),
    ).rejects.toThrow(diagnostic);
  });

  test("dry-run rejects materialized role drift before returning a preview", async () => {
    const factory = bindingFactory((binding) =>
      binding.roleRef === WORKFLOW_ROLE_NAME.CLI_ENGINE
        ? { roleName: CONVERSATION_ROLE_NAME.DIRECT }
        : {},
    );
    await expect(resolvers(factory).resolveDryRunRequest(coordinateRequest())).rejects.toThrow(
      COORDINATE_TOPOLOGY_DIAGNOSTIC.MATERIALIZATION_CHANGED,
    );
  });

  test("preserves a specialized writable executor and strips every coordinate host tool", async () => {
    const resolution = resolvers(
      bindingFactory((binding) =>
        binding.roleRef === WORKFLOW_ROLE_NAME.CLI_ENGINE ? { source: AGENT_ROLE_SOURCE.REPO } : {},
      ),
    );
    const [created, previewed] = await Promise.all([
      resolution.resolveCreateRequest(coordinateRequest()),
      resolution.resolveDryRunRequest(coordinateRequest()),
    ]);
    for (const result of [created, previewed]) {
      expect(result.bindings.map(({ input }) => input.roleRef)).toEqual([
        CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR,
        WORKFLOW_ROLE_NAME.CLI_ENGINE,
      ]);
      expect(result.bindings.map(({ input }) => input.engine)).toEqual([
        AGENT_ENGINE.CLAUDE,
        AGENT_ENGINE.CODEX,
      ]);
      expect(result.bindings.map(({ hostTools }) => hostTools)).toEqual([[], []]);
    }
  });
});
