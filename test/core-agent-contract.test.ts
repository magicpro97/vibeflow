import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LegacyEngineV1 } from "../src/actions/legacy-adopt-types.js";
import type { EngineName } from "../src/actions/types.js";
import type { AgentEngine } from "../src/agents/render.js";
import { CAPABILITY_ADAPTER_ENGINE_ORDER } from "../src/capabilities/adapters/registry.js";
import type { EngineName as CapabilityCliEngineName } from "../src/commands/capability/parser-types.js";
import type { Engine as CoordEngine } from "../src/commands/coord.js";
import {
  AGENT_ENGINE,
  AGENT_HOST_TOOL,
  AGENT_HOST_TOOLS,
  AGENT_ROLE_SOURCE,
  AGENT_ROLE_SOURCES,
  type AgentHostToolV1,
  ENGINES,
  type Engine as SharedEngine,
  isAgentEngine,
  isAgentHostTool,
  isAgentRoleSource,
} from "../src/core/agent-contract.js";
import { ENGINES as CORE_TYPE_ENGINES, type Engine } from "../src/core/types.js";
import {
  AGENT_ACTION_CANDIDATE_HOST_TOOL,
  type AgentActionCandidateHostToolV1,
} from "../src/orchestrator/conversation/conversation-agent-action-candidate-contract.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_CREATE_ENGINE,
  CONVERSATION_PRIVATE_CONTEXT_CREATE_ENGINES,
  CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOL,
  CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOLS,
  type ConversationHomeCreateParticipantWireV1,
  type ConversationPrivateContextCreateEngineV1,
  type ConversationPrivateContextCreateHostToolV1,
  isConversationPrivateContextCreateEngine,
  isConversationPrivateContextCreateHostTool,
} from "../src/orchestrator/conversation/conversation-private-context-broker-wire.js";
import type { HandoffEngineName } from "../src/orchestrator/conversation/handoff-types.js";
import type {
  ConversationCreateParticipant,
  ConversationHostToolV1,
} from "../src/orchestrator/conversation/types.js";
import { SUPERPOWERS_ENGINES, type SuperpowersEngine } from "../src/superpowers-sync.js";
import type { Engine as UiEngine } from "../src/ui/src/types.js";
import { INIT_SKILL_MIRROR_ENGINES } from "../src/workflow/init-update.js";

type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

const exactTypeParity = Object.freeze({
  CORE_ENGINE: true satisfies Same<Engine, SharedEngine>,
  UI_ENGINE: true satisfies Same<UiEngine, SharedEngine>,
  ACTION_ENGINE: true satisfies Same<EngineName, SharedEngine>,
  AGENT_RENDER_ENGINE: true satisfies Same<AgentEngine, SharedEngine>,
  CAPABILITY_CLI_ENGINE: true satisfies Same<CapabilityCliEngineName, SharedEngine>,
  COORD_ENGINE: true satisfies Same<CoordEngine, SharedEngine>,
  LEGACY_ACTION_ENGINE: true satisfies Same<LegacyEngineV1, SharedEngine>,
  HANDOFF_ENGINE: true satisfies Same<HandoffEngineName, SharedEngine>,
  BROKER_ENGINE: true satisfies Same<ConversationPrivateContextCreateEngineV1, SharedEngine>,
  BROKER_PARTICIPANT_ENGINE: true satisfies Same<
    ConversationHomeCreateParticipantWireV1["engine"],
    SharedEngine
  >,
  CONVERSATION_PARTICIPANT_ENGINE: true satisfies Same<
    ConversationCreateParticipant["engine"],
    SharedEngine
  >,
  BROKER_HOST_TOOL: true satisfies Same<
    ConversationPrivateContextCreateHostToolV1,
    AgentHostToolV1
  >,
  CONVERSATION_HOST_TOOL: true satisfies Same<ConversationHostToolV1, AgentHostToolV1>,
  CANDIDATE_HOST_TOOL: true satisfies Same<AgentActionCandidateHostToolV1, AgentHostToolV1>,
  SUPERPOWERS_ENGINE_SUBSET: true satisfies SuperpowersEngine extends SharedEngine ? true : false,
});

const source = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

const moduleSpecifiers = (text: string): string[] =>
  [...text.matchAll(/(?:\bfrom\s+|^\s*import\s+|\bimport\s*\(\s*)"([^"]+)"/gmu)].map(
    (match) => match[1] ?? "",
  );

describe("shared agent contract", () => {
  test("preserves the canonical engine priority and frozen host-tool vocabulary", () => {
    expect(ENGINES).toEqual(["claude", "copilot", "codex", "opencode", "antigravity"]);
    expect(Object.values(AGENT_ENGINE)).toEqual([...ENGINES]);
    expect(AGENT_HOST_TOOLS).toEqual(["propose_action"]);
    expect(Object.values(AGENT_HOST_TOOL)).toEqual([...AGENT_HOST_TOOLS]);
    expect(AGENT_ROLE_SOURCES).toEqual(Object.values(AGENT_ROLE_SOURCE));
    for (const value of [
      AGENT_ENGINE,
      ENGINES,
      AGENT_HOST_TOOL,
      AGENT_HOST_TOOLS,
      AGENT_ROLE_SOURCE,
      AGENT_ROLE_SOURCES,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  test("names and freezes domain-specific engine orders without changing them", () => {
    expect(CAPABILITY_ADAPTER_ENGINE_ORDER).toEqual([
      AGENT_ENGINE.CLAUDE,
      AGENT_ENGINE.CODEX,
      AGENT_ENGINE.COPILOT,
      AGENT_ENGINE.OPENCODE,
      AGENT_ENGINE.ANTIGRAVITY,
    ]);
    expect(SUPERPOWERS_ENGINES).toEqual([
      AGENT_ENGINE.CLAUDE,
      AGENT_ENGINE.CODEX,
      AGENT_ENGINE.OPENCODE,
    ]);
    expect(INIT_SKILL_MIRROR_ENGINES).toEqual([
      AGENT_ENGINE.CLAUDE,
      AGENT_ENGINE.CODEX,
      AGENT_ENGINE.COPILOT,
      AGENT_ENGINE.OPENCODE,
    ]);
    for (const values of [
      CAPABILITY_ADAPTER_ENGINE_ORDER,
      SUPERPOWERS_ENGINES,
      INIT_SKILL_MIRROR_ENGINES,
    ])
      expect(Object.isFrozen(values)).toBe(true);
  });

  test("aliases every engine and host-tool boundary to one runtime and type authority", () => {
    expect(CORE_TYPE_ENGINES).toBe(ENGINES);
    expect(CONVERSATION_PRIVATE_CONTEXT_CREATE_ENGINE).toBe(AGENT_ENGINE);
    expect(CONVERSATION_PRIVATE_CONTEXT_CREATE_ENGINES).toBe(ENGINES);
    expect(CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOL).toBe(AGENT_HOST_TOOL);
    expect(CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOLS).toBe(AGENT_HOST_TOOLS);
    expect(AGENT_ACTION_CANDIDATE_HOST_TOOL).toBe(AGENT_HOST_TOOL);
    expect(Object.values(exactTypeParity).every(Boolean)).toBe(true);
  });

  test("shares guards across the broker wire boundary", () => {
    expect(isConversationPrivateContextCreateEngine).toBe(isAgentEngine);
    expect(isConversationPrivateContextCreateHostTool).toBe(isAgentHostTool);
    expect(ENGINES.every(isAgentEngine)).toBe(true);
    expect(AGENT_HOST_TOOLS.every(isAgentHostTool)).toBe(true);
    expect(AGENT_ROLE_SOURCES.every(isAgentRoleSource)).toBe(true);
    for (const value of ["CLAUDE", "propose-action", "", null, 1]) {
      expect(isAgentEngine(value)).toBe(false);
      expect(isAgentHostTool(value)).toBe(false);
    }
    for (const value of ["builtin ", "workspace", null, 1])
      expect(isAgentRoleSource(value)).toBe(false);
  });

  test("keeps the shared authority browser-safe and wire imports allowlisted", () => {
    const contractSource = source("src/core/agent-contract.ts");
    expect(moduleSpecifiers(contractSource)).toEqual([]);
    expect(contractSource).not.toMatch(/\bnode:|\bBuffer\b|\bprocess(?:\.|\b)/u);

    const hostActionContractSource = source("src/actions/host-action-contract.ts");
    expect(moduleSpecifiers(hostActionContractSource)).toEqual([]);
    expect(hostActionContractSource).not.toMatch(/\bnode:|\bBuffer\b|\bprocess(?:\.|\b)/u);

    const wireSource = source(
      "src/orchestrator/conversation/conversation-private-context-broker-wire.ts",
    );
    expect(moduleSpecifiers(wireSource)).toEqual(["../../core/agent-contract.js"]);
    expect(wireSource).not.toMatch(/\bnode:|\bBuffer\b|\bprocess(?:\.|\b)/u);

    const candidateContractSource = source(
      "src/orchestrator/conversation/conversation-agent-action-candidate-contract.ts",
    );
    expect(moduleSpecifiers(candidateContractSource)).toEqual([
      "../../actions/host-action-contract.js",
      "../../actions/public-action-contract.js",
      "../../core/agent-contract.js",
      "./conversation-public-wire-contract.js",
    ]);
    expect(candidateContractSource).not.toMatch(/\bnode:|\bBuffer\b|\bprocess(?:\.|\b)/u);
  });

  test("prevents action, handoff, and create-request boundaries from redeclaring engines", () => {
    const boundaryFiles = [
      "src/actions/internal-candidate-validation.ts",
      "src/actions/legacy-adopt-types.ts",
      "src/actions/legacy-component-validation.ts",
      "src/actions/legacy-manifest-validation.ts",
      "src/actions/permission-validation.ts",
      "src/actions/preview-validation.ts",
      "src/actions/proposal-content-validation.ts",
      "src/actions/types.ts",
      "src/actions/validation.ts",
      "src/orchestrator/conversation/handoff-types.ts",
      "src/orchestrator/conversation/handoff-validation.ts",
      "src/ui/src/conversation-store.ts",
    ];
    const redeclaredEngineVocabulary =
      /["']claude["']\s*,\s*["'](?:codex|copilot)["']\s*,\s*["'](?:codex|copilot)["']\s*,\s*["']opencode["']\s*,\s*["']antigravity["']/u;

    for (const path of boundaryFiles) {
      const boundarySource = source(path);
      expect(boundarySource).not.toMatch(redeclaredEngineVocabulary);
      expect(boundarySource).toMatch(/core\/agent-contract\.js/u);
    }
  });

  test("prevents generic full-engine consumers from redeclaring the closed vocabulary", () => {
    const consumers = [
      "src/agents/render.ts",
      "src/capabilities/authority/validation.ts",
      "src/capabilities/manifest/component-validation.ts",
      "src/capabilities/manifest/validation.ts",
      "src/capabilities/permissions/scope.ts",
      "src/capabilities/planning/orphan-planner.ts",
      "src/capabilities/runtime-discovery.ts",
      "src/capabilities/source/resolution-records.ts",
      "src/capabilities/storage/lock-validation.ts",
      "src/commands/capability/parser-shared.ts",
      "src/commands/capability/parser-types.ts",
      "src/commands/coord.ts",
      "src/dispatch/start-authority.ts",
      "src/orchestrator/conversation/fold-validation.ts",
      "src/server/capability-route.ts",
      "src/ui/src/components/Stage1Describe.vue",
      "src/ui/src/components/Stage2Generate.vue",
      "src/ui/src/components/Stage3Orchestrate.vue",
    ];
    const rawFullEngineLists = [
      /["']claude["']\s*,\s*["']codex["']\s*,\s*["']copilot["']\s*,\s*["']opencode["']\s*,\s*["']antigravity["']/u,
      /["']claude["']\s*,\s*["']copilot["']\s*,\s*["']codex["']\s*,\s*["']opencode["']\s*,\s*["']antigravity["']/u,
      /["']antigravity["']\s*,\s*["']claude["']\s*,\s*["']codex["']\s*,\s*["']copilot["']\s*,\s*["']opencode["']/u,
    ];
    const rawFullEngineUnion =
      /["']claude["']\s*\|\s*["']codex["']\s*\|\s*["']copilot["']\s*\|\s*["']opencode["']\s*\|\s*["']antigravity["']/u;

    for (const path of consumers) {
      const consumerSource = source(path);
      for (const pattern of rawFullEngineLists) expect(consumerSource).not.toMatch(pattern);
      expect(consumerSource).not.toMatch(rawFullEngineUnion);
    }
  });

  test("prevents engine-specific consumers from hardcoding discriminant comparisons or types", () => {
    const consumers = [
      "src/tools/index.ts",
      "src/dispatch/prompt.ts",
      "src/capabilities/adapters/projection-builders.ts",
      "src/commands/review-cross.ts",
    ];
    const rawEngineDiscriminant =
      /\b(?:engine|target\.engine|request\.engine|input\.target\.engine)\s*(?::|===|!==)\s*["'](?:claude|copilot|codex|opencode|antigravity)["']/u;

    for (const path of consumers) {
      const consumerSource = source(path);
      expect(consumerSource, `${path} imports the shared engine authority`).toContain(
        "agent-contract.js",
      );
      expect(consumerSource, `${path} has no raw engine discriminant`).not.toMatch(
        rawEngineDiscriminant,
      );
    }
  });
});
