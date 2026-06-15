import { describe, expect, test } from "bun:test";
import {
  AI_INIT_UNIT_NAMES,
  type AiInitUnit,
  aiInitReviewer,
  planAiInitUnits,
} from "../src/ai-init-workflow.js";
import { findScopeConflicts } from "../src/gates.js";
import type { ProjectProfile } from "../src/scanner.js";

const profile: ProjectProfile = {
  name: "demo",
  summary: "demo project",
  languages: ["TypeScript"],
  packageManager: "bun",
  buildCommand: "bun run build",
  testCommand: "bun test",
  lintCommand: "bun run lint",
  frameworks: ["React"],
  hasCI: true,
  findings: [],
  manifests: ["package.json"],
};

describe("planAiInitUnits", () => {
  test("emits 4 stable units in canonical order", () => {
    const units = planAiInitUnits(profile, { goal: "ship it" });
    expect(units).toHaveLength(4);
    expect(units.map((u) => u.name)).toEqual([
      "ai-init-analyzer",
      "ai-init-instruction-writer",
      "ai-init-skill-curator",
      "ai-init-context-updater",
    ]);
    // Same set of names is exported for stable IDs.
    expect(AI_INIT_UNIT_NAMES).toHaveLength(4);
  });

  test("every unit starts pending, confidence 0, gates pending", () => {
    const units = planAiInitUnits(profile, {});
    for (const u of units) {
      expect(u.status).toBe("pending");
      expect(u.confidence).toBe(0);
      expect(u.gates).toEqual({
        build: "pending",
        lint: "pending",
        test: "pending",
        review: "pending",
      });
      expect(u.resources).toEqual({ agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 });
      expect(u.evidence).toEqual([]);
    }
  });

  test("owner_agent is a recognised role for every unit", () => {
    const units = planAiInitUnits(profile, {});
    for (const u of units) {
      expect(u.owner_agent).toBeTruthy();
      // Role names from role-templates (stable set)
      const VALID = new Set([
        "cli-engine",
        "web-ui",
        "skill-author",
        "preflight-engine",
        "dispatch-runner",
        "doc-writer",
      ]);
      expect(VALID.has(u.owner_agent as string)).toBe(true);
    }
  });

  test("scope is disjoint (findScopeConflicts returns [])", () => {
    const units = planAiInitUnits(profile, {});
    const conflicts = findScopeConflicts(units);
    expect(conflicts).toEqual([]);
  });

  test("spec embeds the live project name + intake goal", () => {
    const units = planAiInitUnits(profile, { goal: "add web UI" });
    for (const u of units) {
      expect(u.spec).toContain("demo");
      expect(u.spec).toContain("add web UI");
      // Each spec names the unit, so a dispatched agent knows its own name.
      expect(u.spec).toContain(u.name);
    }
  });

  test("spec falls back to a stable default when goal is empty", () => {
    const units = planAiInitUnits(profile, { goal: "  " });
    for (const u of units) {
      expect(u.spec).toContain("Set up VibeFlow AI guidance");
    }
  });

  test("detected roles are interpolated into each spec", () => {
    const units = planAiInitUnits(profile, {}, ["cli-engine", "doc-writer"]);
    for (const u of units) {
      expect(u.spec).toContain("cli-engine");
      expect(u.spec).toContain("doc-writer");
    }
  });

  test("acceptance signal is non-empty and unit-specific", () => {
    const units = planAiInitUnits(profile, {});
    const seen = new Set<string>();
    for (const u of units) {
      expect(u.acceptance.length).toBeGreaterThan(0);
      seen.add(u.acceptance);
    }
    // All 4 acceptance strings are distinct (so a reviewer can tell them apart).
    expect(seen.size).toBe(4);
  });
});

describe("aiInitReviewer", () => {
  function unit(name: AiInitUnit["name"]): AiInitUnit {
    const all = planAiInitUnits(profile, {});
    const found = all.find((u) => u.name === name);
    if (!found) throw new Error(`unit ${name} not in plan`);
    return found;
  }

  test("passes when status=done, confidence=1, and evidence cites a scoped path", () => {
    const u = unit("ai-init-instruction-writer");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["edited CLAUDE.md", "edited AGENTS.md"],
    });
    expect(r.pass).toBe(true);
  });

  test("fails instruction-writer when evidence is empty", () => {
    const u = unit("ai-init-instruction-writer");
    const r = aiInitReviewer(u, { status: "done", confidence: 1, evidence: [] });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/evidence/i);
  });

  test("fails instruction-writer when evidence cites only unrelated files", () => {
    const u = unit("ai-init-instruction-writer");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["edited README.md"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("CLAUDE.md");
  });

  test("fails skill-curator when evidence never cites .vibeflow/skills/ or SKILL_INDEX", () => {
    const u = unit("ai-init-skill-curator");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["installed 3 skills"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/skill file|SKILL_INDEX/);
  });

  test("passes skill-curator when evidence cites .vibeflow/skills/", () => {
    const u = unit("ai-init-skill-curator");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: [".vibeflow/skills/foo/SKILL.md written"],
    });
    expect(r.pass).toBe(true);
  });

  test("fails when confidence < 1 regardless of evidence", () => {
    const u = unit("ai-init-analyzer");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 0.7,
      evidence: [".vibeflow/ai-context/stack-evidence.md"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("0.7");
  });

  test("fails when status is not done", () => {
    const u = unit("ai-init-analyzer");
    const r = aiInitReviewer(u, {
      status: "blocked",
      confidence: 1,
      evidence: [".vibeflow/ai-context/stack-evidence.md"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("blocked");
  });
});
