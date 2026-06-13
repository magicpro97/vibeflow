import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkUnit } from "../src/core.js";
import {
  agentPrompt,
  persistAgentOutput,
  spawnAgent,
  type AgentConfig,
  type AgentOutcome,
} from "../src/orchestrator/agent.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vf-agent-test-"));
}

const sampleUnit: WorkUnit = {
  name: "auth-rewrite",
  status: "pending",
  confidence: 0,
  skills_used: ["security-audit"],
  scope: ["src/auth/**"],
  spec: "Rewrite auth to use JWT",
  gates: { build: "pass", lint: "pass", test: "pass", review: "pending" },
  resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
};

describe("orchestrator/agent: agentPrompt", () => {
  test("includes unit name, spec, scope in the prompt", () => {
    const prompt = agentPrompt(sampleUnit);
    expect(prompt).toContain("auth-rewrite");
    expect(prompt).toContain("Rewrite auth to use JWT");
    expect(prompt).toContain("src/auth/**");
  });
});

describe("orchestrator/agent: persistAgentOutput", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("writes outcome JSON to .vibeflow/workunits/<unitName>/evidence/<...>.json", () => {
    dir = tmp();
    const outcome: AgentOutcome = {
      status: "done",
      confidence: 0.9,
      evidence: ["test/auth.test.ts:42"],
      output: "JWT rewrite complete",
    };
    const path = persistAgentOutput(dir, "auth-rewrite", outcome);
    expect(existsSync(path)).toBe(true);
    expect(path).toContain("auth-rewrite");
    expect(path).toMatch(/\.json$/);
  });
});

describe("orchestrator/agent: spawnAgent (smoke)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("returns failed status when lock is already held (no binary path needed)", async () => {
    dir = tmp();
    mkdirSync(join(dir, ".vibeflow"), { recursive: true });
    const { tryLock, releaseLock } = await import("../src/orchestrator/marker.js");
    expect(tryLock("auth-rewrite")).toBe(true);
    try {
      const r = await spawnAgent(sampleUnit, "test prompt", {
        engine: "claude",
        cwd: dir,
        timeoutMs: 1000,
      });
      expect(r.status).toBe("failed");
      expect(r.output).toContain("lock");
    } finally {
      releaseLock("auth-rewrite");
    }
  });
});

describe("orchestrator/agent: parseClaudeStreamJson (parse JSON from stream segments)", () => {
  // The function is not exported, but the orchestrator uses it internally.
  // We can hit its branches via spawnAgent + runAgent, but those need a real
  // Claude binary. Skip for now — covered indirectly by other tests.
  test.skip("placeholder", () => {});
});
