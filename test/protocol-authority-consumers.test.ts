import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_ENGINE, ENGINES } from "../src/core/agent-contract.js";
import { CAPABILITY_SCOPE, CAPABILITY_SCOPES } from "../src/core/capability-contract.js";
import { SKILL_STATUS, SKILL_STATUSES, isSkillStatus } from "../src/core/skill-contract.js";
import { STATUS_RANK } from "../src/skills/registry.js";
import { parseStatusFromText } from "../src/skills/verify.js";

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");

const ENGINE_CONSUMERS = Object.freeze([
  "src/preflight.ts",
  "src/preflight/check-async.ts",
  "src/preflight/probe.ts",
  "src/ask-support.ts",
  "src/adapters/engine-files.ts",
  "src/agents/binding.ts",
  "src/dispatch.ts",
  "src/dispatch/public-redaction.ts",
  "src/dispatch/session-argv.ts",
  "src/dispatch/session-output.ts",
  "src/dispatch/session-terminal.ts",
  "src/commands/dispatch-session-runtime.ts",
  "src/commands/orchestrate.ts",
  "src/capabilities/adapters/hook-projections.ts",
  "src/capabilities/planning/component-target.ts",
  "src/orchestrator/conversation/bootstrap-request-resolution.ts",
  "src/superpowers-sync-exec.ts",
]);

const RAW_ENGINE_DISCRIMINANT =
  /\b(?:[A-Za-z_$][\w$#]*\.)*#?engine\s*(?::|===|!==)\s*["'](?:claude|copilot|codex|opencode|antigravity)["']/u;
const RAW_ENGINE_CASE = /\bcase\s+["'](?:claude|copilot|codex|opencode|antigravity)["']\s*:/u;
const RAW_ENGINE_AUTHORITY_CALL =
  /\b(?:failedAuth|nativeEvent|writeReceipt)\(\s*["'](?:claude|copilot|codex|opencode|antigravity)["']/u;

describe("protocol authority consumers", () => {
  test("keeps engine branches bound to the frozen shared authority", () => {
    expect(Object.values(AGENT_ENGINE)).toEqual([...ENGINES]);
    for (const path of ENGINE_CONSUMERS) {
      const text = source(path);
      expect(text, `${path} imports AGENT_ENGINE`).toContain("agent-contract.js");
      expect(text, `${path} has no raw engine discriminant`).not.toMatch(RAW_ENGINE_DISCRIMINANT);
      expect(text, `${path} has no raw engine switch case`).not.toMatch(RAW_ENGINE_CASE);
      expect(text, `${path} has no raw engine authority call`).not.toMatch(
        RAW_ENGINE_AUTHORITY_CALL,
      );
    }
  });

  test("keeps the migrated capability scope consumers on CapabilityScope", () => {
    const consumers = [
      "src/capabilities/adapters/hook-projections.ts",
      "src/capabilities/planning/component-target.ts",
    ];
    const rawScopeDiscriminant =
      /\b(?:[A-Za-z_$][\w$]*\.)*scope\s*(?::|===|!==|=)\s*(?:["'](?:project|user)["']|["']project["']\s*\|\s*["']user["'])/u;
    expect(Object.values(CAPABILITY_SCOPE)).toEqual([...CAPABILITY_SCOPES]);
    for (const path of consumers) {
      const text = source(path);
      expect(text, `${path} imports the shared capability authority`).toContain(
        "capability-contract.js",
      );
      expect(text, `${path} has no raw capability scope discriminant`).not.toMatch(
        rawScopeDiscriminant,
      );
    }
  });

  test("keeps skill parsing, ranking, and verification on one lifecycle authority", () => {
    expect(Object.values(SKILL_STATUS)).toEqual([...SKILL_STATUSES]);
    expect(Object.keys(STATUS_RANK).sort()).toEqual([...SKILL_STATUSES].sort());
    for (const value of [SKILL_STATUS, SKILL_STATUSES, STATUS_RANK]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    for (const status of SKILL_STATUSES) expect(isSkillStatus(status)).toBe(true);
    for (const value of ["toString", "constructor", "VERIFIED", "", null, 1]) {
      expect(isSkillStatus(value)).toBe(false);
    }
    expect(parseStatusFromText("---\nstatus: draft\n---\nbody")).toBe(SKILL_STATUS.DRAFT);
    expect(parseStatusFromText("---\nstatus: invented\n---\nbody")).toBeNull();

    const registry = source("src/skills/registry.ts");
    const verify = source("src/skills/verify.ts");
    expect(registry).toContain("core/skill-contract.js");
    expect(verify).toContain("core/skill-contract.js");
    expect(registry).not.toMatch(/\bconst\s+VALID_STATUS\b/u);
    expect(registry).not.toMatch(
      /^\s*(?:verified|enriched|experimental|baseline|template|draft|unverified|deprecated):\s*\d+/mu,
    );
    expect(`${registry}\n${verify}`).not.toMatch(
      /\b(?:status|skill\.status|s\.status)\s*(?:===|!==|=)\s*["'](?:verified|enriched|experimental|baseline|template|draft|unverified|deprecated)["']/u,
    );
    expect(verify).not.toMatch(/\btype\s+VerifyStatus\s*=\s*["']/u);
  });
});
