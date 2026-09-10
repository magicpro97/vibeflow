import { afterEach, describe, expect, test } from "bun:test";
import type { MaterializedAgentBinding, PreviewAgentBinding } from "../../src/agents/binding.js";
import { AGENT_ENGINE, AGENT_ROLE_SOURCE } from "../../src/core/agent-contract.js";
import { ROLE_MODEL, ROLE_SANDBOX, ROLE_TOOL_INTENT } from "../../src/core/role-contract.js";
import { CONVERSATION_ROLE_NAME } from "../../src/core/role-name-contract.js";
import {
  type ConversationBindingFactory as ResolverFactory,
  createConversationRequestResolvers,
  defaultConversationReadiness,
  liveConversationReadiness,
} from "../../src/orchestrator/conversation/bootstrap-request-resolution.js";
import { CONVERSATION_POLICY } from "../../src/orchestrator/conversation/conversation-policy-contract.js";
import type { ConversationCreateRequest } from "../../src/orchestrator/conversation/types.js";
import { setSharedCache } from "../../src/preflight.js";

const PROBE_MODULE = "../../src/preflight.js";
let probeModule: typeof import("../../src/preflight.js");

function simpleBinding(roleRef: string, engine: string) {
  return {
    role: {
      spec: {
        name: roleRef,
        description: "d",
        body: "b",
        tools: [ROLE_TOOL_INTENT.READ],
        model: ROLE_MODEL.SONNET,
        sandbox: ROLE_SANDBOX.READ_ONLY,
      },
      source: AGENT_ROLE_SOURCE.BUILTIN,
      resolved_hash: `h:${roleRef}`,
      metadata: {},
    },
    skills: [],
    engine,
    model: null,
    sessionMode: null as never,
    tool_intents: [ROLE_TOOL_INTENT.READ],
    sandbox: ROLE_SANDBOX.READ_ONLY,
    env_policy: {} as never,
    isolation: null,
    provenance: {
      roleSource: AGENT_ROLE_SOURCE.BUILTIN,
      roleHash: `h:${roleRef}`,
      skillHashes: [],
    },
  };
}

const factory: ResolverFactory = {
  materialize(binding): MaterializedAgentBinding {
    return {
      resolved: simpleBinding(binding.roleRef, binding.engine as string) as never,
      spawn: {} as never,
    };
  },
  preview(binding): PreviewAgentBinding {
    return {
      resolved: simpleBinding(binding.roleRef, binding.engine as string) as never,
      engineAvailable: true,
      modelValid: true,
    };
  },
};

const readyRows = (): { engine: string; ready: boolean; admitted: boolean }[] => [
  { engine: AGENT_ENGINE.CLAUDE, ready: true, admitted: true },
  { engine: AGENT_ENGINE.CODEX, ready: true, admitted: true },
  { engine: AGENT_ENGINE.ANTIGRAVITY, ready: false, admitted: false },
];

function makeResolvers(overrides: Record<string, unknown> = {}) {
  return createConversationRequestResolvers({
    options: { readiness: readyRows, ...overrides } as never,
    repoRoot: process.cwd(),
    phase: 1,
    binder: factory,
  });
}

function debateRequest(): ConversationCreateRequest {
  return {
    topic: "proposal",
    policy: CONVERSATION_POLICY.DEBATE,
    participants: [
      {
        role_ref: CONVERSATION_ROLE_NAME.DIRECT,
        engine: AGENT_ENGINE.CLAUDE,
      },
    ],
  };
}

afterEach(() => {
  setSharedCache(undefined);
  Reflect.deleteProperty(require.cache, require.resolve(PROBE_MODULE));
});

describe("conversation bootstrap readiness projection", () => {
  test("defaultConversationReadiness admits engines by conversation role authority", () => {
    const rows = defaultConversationReadiness(process.cwd(), 1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.ready).toBe("boolean");
      expect(typeof row.admitted).toBe("boolean");
      expect(row.engine).toBeTruthy();
    }
    expect(rows.some((r) => r.engine === AGENT_ENGINE.CLAUDE && r.admitted)).toBe(true);
  });

  test("later phases never drop an engine admitted in phase one", () => {
    const phaseOne = defaultConversationReadiness(process.cwd(), 1);
    const phaseTwo = defaultConversationReadiness(process.cwd(), 2);
    for (const row of phaseOne) {
      if (!row.admitted) continue;
      const later = phaseTwo.find((r) => r.engine === row.engine);
      expect(later?.admitted).toBe(true);
    }
    // Phase one is narrower: every engine admitted in phase one stays admitted later.
    const laterAdmitted = new Set(phaseTwo.filter((r) => r.admitted).map((r) => r.engine));
    for (const row of phaseOne) {
      if (row.admitted) expect(laterAdmitted.has(row.engine)).toBe(true);
    }
  });

  test("liveConversationReadiness rounds through the shared probe cache seam", async () => {
    const cacheMap = new Map<string, unknown>();
    const allReady = ["claude", "codex", "copilot", "opencode", "antigravity"].map((engine) => ({
      engine,
      level: "ready",
      detail: "seeded",
      checkedAt: "t",
    }));
    for (const row of allReady) cacheMap.set(row.engine, row);
    setSharedCache({
      get: (engine: string) => cacheMap.get(engine),
      set: (engine: string, _repo: string, _args: readonly string[], result: unknown) => {
        cacheMap.set(engine, result);
      },
      invalidate: () => {},
      invalidateAll: () => {},
    } as never);
    const rows = await liveConversationReadiness(process.cwd(), 1);
    expect(rows.every((r) => typeof r.ready === "boolean")).toBe(true);
    expect(rows.every((r) => typeof r.admitted === "boolean")).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(cacheMap.has(row.engine)).toBe(true);
  });

  test("liveConversationReadiness serves a cached probe without re-checking", async () => {
    const seeded = {
      claude: { engine: "claude", level: "ready", detail: "cached", checkedAt: "x" },
      codex: { engine: "codex", level: "missing", detail: "cached", checkedAt: "x" },
      copilot: { engine: "copilot", level: "ready", detail: "cached", checkedAt: "x" },
      opencode: { engine: "opencode", level: "ready", detail: "cached", checkedAt: "x" },
    };
    let writes = 0;
    setSharedCache({
      get: (engine: string) => seeded[engine as keyof typeof seeded],
      set: () => {
        writes++;
      },
      invalidate: () => {},
      invalidateAll: () => {},
    } as never);
    const rows = await liveConversationReadiness(process.cwd(), 1);
    const claude = rows.find((r) => r.engine === "claude");
    expect(claude?.ready).toBe(true);
    expect(rows.find((r) => r.engine === "antigravity")?.ready).toBe(false);
    expect(rows.some((r) => r.engine === "claude")).toBe(true);
    // The uncached engine was probed and written back through the seam.
    expect(writes).toBeGreaterThan(0);
  });

  test("debate creates flow explicit host tools through materialization", async () => {
    const resolvers = makeResolvers();
    const result = await resolvers.resolveCreateRequest(debateRequest());
    expect(result.bindings.length).toBeGreaterThan(1);
    expect(result.bindings[0]?.input.roleRef).toBe(CONVERSATION_ROLE_NAME.DIRECT);
  });
});
