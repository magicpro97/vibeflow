import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AI_INIT_UNIT_NAMES,
  type AiInitIntake,
  type AiInitUnit,
  aiInitReviewer,
  buildFinisherBatchUnit,
  buildPhaseSkillEnrichmentUnits,
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
  test("emits 5 Tier-1 adapter units in canonical order (no phase units without intake)", () => {
    const units = planAiInitUnits(profile, { goal: "ship it" });
    expect(units).toHaveLength(5);
    expect(units.map((u) => u.name)).toEqual([
      "ai-init-analyzer",
      "ai-init-instruction-writer",
      "ai-init-skill-curator",
      "ai-init-context-updater",
      "ai-init-workflow-state-writer",
    ]);
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

  test("instruction-writer scope follows the selected engine", () => {
    const copilot = planAiInitUnits(profile, { engines: ["copilot"] }).find(
      (u) => u.name === "ai-init-instruction-writer",
    );
    expect(copilot?.scope).toEqual(["AGENTS.md", ".github/copilot-instructions.md"]);
    expect(copilot?.spec).toContain(
      "Update only these instruction file(s): AGENTS.md, .github/copilot-instructions.md",
    );
    expect(copilot?.spec).not.toContain("CLAUDE.md");
    expect(copilot?.spec).not.toContain(".agents/instructions.md");

    const claude = planAiInitUnits(profile, { engines: ["claude"] }).find(
      (u) => u.name === "ai-init-instruction-writer",
    );
    expect(claude?.scope).toEqual(["CLAUDE.md"]);
  });

  test("spec embeds the live project name + intake goal", () => {
    const units = planAiInitUnits(profile, { goal: "add web UI" });
    for (const u of units) {
      expect(u.spec).toContain("demo");
      expect(u.spec).toContain("add web UI");
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
    expect(seen.size).toBe(5);
  });

  test("emits one Tier-2 unit per WorkflowPhase, after the 5 adapters", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [
        { name: "analyze", description: "Read the repo", dod: "stack table written" },
        { name: "ship", description: "Open a PR", dod: "PR opened" },
      ],
    });
    expect(units).toHaveLength(7);
    expect(units[5]?.name).toMatch(/^ai-init-phase-analyze-1$/);
    expect(units[6]?.name).toMatch(/^ai-init-phase-ship-2$/);
  });

  test("phase unit scope falls back to a sentinel when outputs are missing", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [{ name: "noop", description: "no outputs", dod: "noop" }],
    });
    const phase = units[5];
    expect(phase).toBeDefined();
    expect(phase?.scope).toEqual([".vibeflow/phase-outputs/noop.md"]);
  });

  test("phase unit name is path-safe (no traversal from crafted phase.name)", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [{ name: "../../../etc/passwd", description: "x", dod: "x" }],
    });
    const phase = units[5];
    expect(phase).toBeDefined();
    expect(phase?.name).not.toContain("..");
    expect(phase?.name).not.toContain("/");
    expect(phase?.name).toMatch(/^ai-init-phase-/);
  });

  // T4: phase.name uniqueness is enforced at plan time. Two phases sharing
  // a name would produce two units with the SAME semantic identity, breaking
  // re-runs (one would shadow the other in WORKFLOW_STATE.json) and the
  // orchestrator's conflict detection.
  test("throws when two workflowPhases share the same name", () => {
    expect(() =>
      planAiInitUnits(profile, {
        workflowPhases: [
          { name: "build-cli", description: "first", dod: "ok" },
          { name: "build-cli", description: "second", dod: "ok" },
        ],
      }),
    ).toThrow(/duplicate phase name/i);
  });

  test("throws on case-insensitive duplicate phase names (build-cli vs Build-CLI)", () => {
    // Phase names are user-facing labels; "build-cli" and "Build-CLI"
    // would be visually identical in the dashboard. Normalize to lowercase
    // for the dedup check so we catch this class of mistake.
    expect(() =>
      planAiInitUnits(profile, {
        workflowPhases: [
          { name: "build-cli", description: "first", dod: "ok" },
          { name: "Build-CLI", description: "second", dod: "ok" },
        ],
      }),
    ).toThrow(/duplicate phase name/i);
  });

  test("phase unit owner_agent resolves from ownerHint", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [
        { name: "build-cli", description: "add flag", ownerHint: "cli-engine", dod: "ok" },
        { name: "ui-thing", description: "add panel", ownerHint: "ui", dod: "ok" },
        { name: "docs-update", description: "readme", ownerHint: "doc", dod: "ok" },
      ],
    });
    expect(units[5]?.owner_agent).toBe("cli-engine");
    expect(units[6]?.owner_agent).toBe("web-ui");
    expect(units[7]?.owner_agent).toBe("doc-writer");
  });

  // Branch coverage for resolveOwner: every regex branch in src/ai-init-workflow.ts:243-248
  // + the default fallback at line 249.
  test("resolveOwner fuzzy-matches skill/capability keywords to skill-author", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [{ name: "sk", description: "add new skill", ownerHint: "skill", dod: "ok" }],
    });
    expect(units[5]?.owner_agent).toBe("skill-author");
  });

  test("resolveOwner fuzzy-matches preflight/probe/quota keywords to preflight-engine", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [
        { name: "pf", description: "add preflight probe", ownerHint: "preflight", dod: "ok" },
      ],
    });
    expect(units[5]?.owner_agent).toBe("preflight-engine");
  });

  test("resolveOwner fuzzy-matches dispatch/orchestrat/runner/workflow keywords to dispatch-runner", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [
        { name: "dr", description: "add workflow runner", ownerHint: "dispatch", dod: "ok" },
      ],
    });
    expect(units[5]?.owner_agent).toBe("dispatch-runner");
  });

  test("resolveOwner defaults to dispatch-runner when hint is empty/unknown", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [
        { name: "u1", description: "no hint", ownerHint: "totally-unknown-role", dod: "ok" },
        { name: "u2", description: "no hint at all", dod: "ok" },
      ],
    });
    expect(units[5]?.owner_agent).toBe("dispatch-runner");
    expect(units[6]?.owner_agent).toBe("dispatch-runner");
  });

  test("phase unit carries skills_injected and skills_required from the resolved role", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [{ name: "x", description: "x", ownerHint: "cli-engine", dod: "x" }],
    });
    const phase = units[5];
    expect(phase).toBeDefined();
    expect(phase?.skills_injected).toBeDefined();
    expect(phase?.skills_required).toBeDefined();
    expect(phase?.skills_injected?.length).toBeGreaterThan(0);
    expect(phase?.skills_required?.length).toBeGreaterThan(0);
  });

  test("Tier-1 adapters carry skills_injected and skills_required", () => {
    const units = planAiInitUnits(profile, {});
    for (const u of units) {
      expect(u.skills_injected).toBeDefined();
      expect(u.skills_required).toBeDefined();
      expect(u.skills_injected?.length).toBeGreaterThan(0);
    }
  });
});

describe("aiInitReviewer", () => {
  function unit(name: AiInitUnit["name"]): AiInitUnit {
    const all = planAiInitUnits(profile, {});
    const found = all.find((u) => u.name === name);
    if (!found) throw new Error(`unit ${name} not in plan`);
    return found;
  }

  // Fixture for the T3 file-exists check: chdir to a tmpdir populated with
  // the adapter-scope files so existsSync() sees them. Original cwd restored
  // in afterEach.
  let origCwd: string;
  let tmpDir: string;
  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "vf-ai-init-reviewer-"));
    process.chdir(tmpDir);
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    mkdirSync(join(tmpDir, ".vibeflow"), { recursive: true });
    mkdirSync(join(tmpDir, ".vibeflow/ai-context"), { recursive: true });
    mkdirSync(join(tmpDir, ".vibeflow/skills/foo"), { recursive: true });
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# fixture\n");
    writeFileSync(join(tmpDir, "AGENTS.md"), "# fixture\n");
    writeFileSync(join(tmpDir, ".github/copilot-instructions.md"), "# fixture\n");
    writeFileSync(join(tmpDir, ".vibeflow/ai-context/stack-evidence.md"), "# fixture\n");
    writeFileSync(join(tmpDir, ".vibeflow/skills/foo/SKILL.md"), "# fixture\n");
    writeFileSync(join(tmpDir, ".vibeflow/SKILL_INDEX.md"), "# fixture\n");
    writeFileSync(join(tmpDir, ".vibeflow/PROJECT_CONTEXT.md"), "# fixture\n");
    writeFileSync(join(tmpDir, ".vibeflow/SETTINGS.json"), "{}\n");
    writeFileSync(join(tmpDir, ".vibeflow/WORKFLOW_POLICY.md"), "# fixture\n");
    writeFileSync(join(tmpDir, ".vibeflow/WORKFLOW_STATE.json"), "{}\n");
    writeFileSync(join(tmpDir, "QUICKSTART.md"), "# fixture\n");
  });
  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("passes when status=done, confidence=1, and evidence cites a scoped path", () => {
    const u = unit("ai-init-instruction-writer");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["edited AGENTS.md", "edited .github/copilot-instructions.md"],
    });
    expect(r.pass).toBe(true);
  });

  test("instruction-writer reviewer uses the unit scope instead of all engine files", () => {
    const u = planAiInitUnits(profile, { engines: ["copilot"] }).find(
      (candidate) => candidate.name === "ai-init-instruction-writer",
    );
    if (!u) throw new Error("instruction writer unit not in plan");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["edited AGENTS.md"],
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
    expect(r.reason).toMatch(/(AGENTS\.md|copilot-instructions)/);
  });

  test("passes when status=verifying with confidence=1 and valid evidence (per orchestrateUnits contract)", () => {
    const u = unit("ai-init-analyzer");
    const r = aiInitReviewer(u, {
      status: "verifying",
      confidence: 1,
      evidence: [".vibeflow/ai-context/stack-evidence.md"],
    });
    expect(r.pass).toBe(true);
  });

  test("fails when status=blocked even with full evidence", () => {
    const u = unit("ai-init-analyzer");
    const r = aiInitReviewer(u, {
      status: "blocked",
      confidence: 1,
      evidence: [".vibeflow/ai-context/stack-evidence.md"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("blocked");
  });

  // T3 file-exists tests: substring pre-filter is not enough; the cited path
  // must actually exist on disk.
  test("instruction-writer fails when CLAUDE.md fixture is deleted", () => {
    rmSync(join(tmpDir, "CLAUDE.md"));
    rmSync(join(tmpDir, "AGENTS.md"));
    const u = unit("ai-init-instruction-writer");
    const r = aiInitReviewer(u, {
      status: "verifying",
      confidence: 1,
      evidence: ["CLAUDE.md", "AGENTS.md"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/not a regular file/);
  });

  test("analyzer passes when stack-evidence.md exists on disk (file-exists green path)", () => {
    const u = unit("ai-init-analyzer");
    const r = aiInitReviewer(u, {
      status: "verifying",
      confidence: 1,
      evidence: [".vibeflow/ai-context/stack-evidence.md"],
    });
    expect(r.pass).toBe(true);
  });

  test("skill-curator dir-entry green path: file inside .vibeflow/skills/ exists", () => {
    const u = unit("ai-init-skill-curator");
    const r = aiInitReviewer(u, {
      status: "verifying",
      confidence: 1,
      evidence: ["wrote .vibeflow/skills/foo/SKILL.md"],
    });
    expect(r.pass).toBe(true);
  });

  test("skill-curator dir-entry red path: file inside .vibeflow/skills/ does not exist", () => {
    const u = unit("ai-init-skill-curator");
    const r = aiInitReviewer(u, {
      status: "verifying",
      confidence: 1,
      evidence: ["wrote .vibeflow/skills/missing/SKILL.md"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/not a regular file/);
  });

  test("analyzer file-exists red path: stack-evidence.md missing", () => {
    rmSync(join(tmpDir, ".vibeflow/ai-context/stack-evidence.md"));
    const u = unit("ai-init-analyzer");
    const r = aiInitReviewer(u, {
      status: "verifying",
      confidence: 1,
      evidence: ["wrote .vibeflow/ai-context/stack-evidence.md"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/not a regular file/);
  });

  test("instruction-writer wordStart=-1 branch: evidence starts with the scope path", () => {
    // "AGENTS.md content" → idx 0, wordStart -1, candidate "AGENTS.md"
    const u = unit("ai-init-instruction-writer");
    const r = aiInitReviewer(u, {
      status: "verifying",
      confidence: 1,
      evidence: ["AGENTS.md content updated"],
    });
    expect(r.pass).toBe(true);
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

  test("passes workflow-state-writer when evidence cites WORKFLOW_STATE.json", () => {
    const u = unit("ai-init-workflow-state-writer");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: [".vibeflow/WORKFLOW_STATE.json updated with 3 work units"],
    });
    expect(r.pass).toBe(true);
  });

  test("fails workflow-state-writer when evidence is unrelated", () => {
    const u = unit("ai-init-workflow-state-writer");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["updated README"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("WORKFLOW_STATE");
  });

  test("passes phase unit when evidence cites one of the declared outputs", () => {
    const phase = planAiInitUnits(profile, {
      workflowPhases: [
        {
          name: "build",
          description: "build the thing",
          outputs: ["dist/bundle.js", "dist/index.html"],
          dod: "build done",
        },
      ],
    })[5];
    expect(phase).toBeDefined();
    if (!phase) return;
    // Create the cited output file on disk so the file-exists check
    // passes (MINOR-3 consistency).
    mkdirSync(join(tmpDir, "dist"), { recursive: true });
    writeFileSync(join(tmpDir, "dist/bundle.js"), "// bundle\n");
    const r = aiInitReviewer(phase, {
      status: "done",
      confidence: 1,
      evidence: ["dist/bundle.js written"],
    });
    expect(r.pass).toBe(true);
  });

  test("fails phase unit when evidence never cites a declared output", () => {
    const phase = planAiInitUnits(profile, {
      workflowPhases: [
        {
          name: "build",
          description: "build the thing",
          outputs: ["dist/bundle.js"],
          dod: "build done",
        },
      ],
    })[5];
    expect(phase).toBeDefined();
    if (!phase) return;
    const r = aiInitReviewer(phase, {
      status: "done",
      confidence: 1,
      evidence: ["wrote some scratch file"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("dist/bundle.js");
  });

  // MINOR-3: phase units also pass through file-exists review.
  test("fails phase unit when cited output file does not exist on disk (MINOR-3)", () => {
    const phase = planAiInitUnits(profile, {
      workflowPhases: [
        {
          name: "ship",
          description: "ship the thing",
          outputs: [".vibeflow/phase-outputs/ship.md"],
          dod: "ship done",
        },
      ],
    })[5];
    expect(phase).toBeDefined();
    if (!phase) return;
    // Do NOT create the cited file on disk. The reviewer must reject.
    const r = aiInitReviewer(phase, {
      status: "done",
      confidence: 1,
      evidence: ["wrote .vibeflow/phase-outputs/ship.md"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/not a regular file/);
  });

  // Dir-scope entries (trailing `/`) accept the directory itself as valid
  // evidence — the skill-curator's scope is .vibeflow/skills/, so citing
  // the directory (or a subdirectory within it) confirms the engine
  // created content there. A missing directory still fails.
  test("dir-scope evidence that resolves to a directory (not a file inside) passes (MINOR-2 updated)", () => {
    // .vibeflow/skills/foo/ is a real dir (created in beforeEach). Cite
    // the dir itself (no trailing /SKILL.md) — pathIsDir accepts it.
    const u = unit("ai-init-skill-curator");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["installed .vibeflow/skills/foo"],
    });
    expect(r.pass).toBe(true);
  });

  test("dir-scope evidence fails when the cited directory does not exist", () => {
    const u = unit("ai-init-skill-curator");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["installed .vibeflow/skills/nonexistent"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/not a regular file/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 2 engine-scoping invariants: `vf init --engine X` must NOT
// generate instruction files or skill dirs for unselected engines.
// The plan, the spec text, and the reviewer fallback must all be
// engine-scoped. These tests pin the contract against regression.
// ───────────────────────────────────────────────────────────────────────────
describe("Phase 2 engine-scoping invariants", () => {
  test("instruction-writer spec never references 'all 3' instruction files", () => {
    const units = planAiInitUnits(profile, { engines: ["claude"] });
    const u = units.find((u) => u.name === "ai-init-instruction-writer");
    if (!u) throw new Error("instruction-writer not in plan");
    expect(u.spec).not.toContain("all 3");
    expect(u.spec).not.toContain("all 3 instruction files");
    expect(u.spec).toContain("Update only these instruction file(s)");
  });

  test("skill-curator spec never syncs/writes unselected engine skill dirs", () => {
    const units = planAiInitUnits(profile, { engines: ["claude"] });
    const u = units.find((u) => u.name === "ai-init-skill-curator");
    if (!u) throw new Error("skill-curator not in plan");
    // For --engine claude, the spec must NOT target the unselected engines'
    // skill dirs as a SYNC/WRITE destination. PR #251 added an explicit
    // "DELETE unselected engine skill dirs" cleanup step that legitimately
    // names `.github/skills/` — that serves the invariant (don't keep an
    // unselected mirror), so we forbid it only as a sync target, not outright.
    expect(u.spec).not.toMatch(/sync[^\n]*\.github\/skills\//i);
    expect(u.spec).not.toMatch(/\.github\/skills\/[^\n]*(?:sync|mirror|write)/i);
    // And it must mention the selected engine's skill dir.
    expect(u.spec).toContain(".claude/skills/");
    // The sync/verify commands are scoped to the selected engine only.
    expect(u.spec).toContain("--engine claude");
    expect(u.spec).not.toMatch(/--mode pointer\b(?!\s*--engine)/);
  });

  test("instruction-writer acceptance follows the selected engine (not 'all 3')", () => {
    const claude = planAiInitUnits(profile, { engines: ["claude"] }).find(
      (u) => u.name === "ai-init-instruction-writer",
    );
    if (!claude) throw new Error("instruction-writer not in plan");
    expect(claude.acceptance).not.toContain("all 3");
    expect(claude.acceptance).toContain("CLAUDE.md");
    expect(claude.acceptance).not.toContain("AGENTS.md");
  });

  test("instruction-writer scope for claude is exactly ['CLAUDE.md']", () => {
    const u = planAiInitUnits(profile, { engines: ["claude"] }).find(
      (u) => u.name === "ai-init-instruction-writer",
    );
    if (!u) throw new Error("instruction-writer not in plan");
    expect(u.scope).toEqual(["CLAUDE.md"]);
  });

  test("instruction-writer scope for codex is exactly ['AGENTS.md']", () => {
    const u = planAiInitUnits(profile, { engines: ["codex"] }).find(
      (u) => u.name === "ai-init-instruction-writer",
    );
    if (!u) throw new Error("instruction-writer not in plan");
    expect(u.scope).toEqual(["AGENTS.md"]);
  });

  test("instruction-writer scope for copilot is ['AGENTS.md', '.github/copilot-instructions.md']", () => {
    const u = planAiInitUnits(profile, { engines: ["copilot"] }).find(
      (u) => u.name === "ai-init-instruction-writer",
    );
    if (!u) throw new Error("instruction-writer not in plan");
    expect(u.scope).toEqual(["AGENTS.md", ".github/copilot-instructions.md"]);
  });

  test("instruction-writer reviewer does NOT pass on an unselected engine's file", () => {
    // Select copilot only. Evidence cites CLAUDE.md (a claude-only file).
    // The reviewer must reject — CLAUDE.md is out of scope.
    const u = planAiInitUnits(profile, { engines: ["copilot"] }).find(
      (candidate) => candidate.name === "ai-init-instruction-writer",
    );
    if (!u) throw new Error("instruction-writer not in plan");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["edited CLAUDE.md"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/AGENTS\.md|copilot-instructions/);
  });

  test("skill-curator reviewer uses unit.scope (not hardcoded strings)", () => {
    // Default plan (no engines) — skill-curator scope is the static
    // ADAPTER_SCOPE value. Evidence must cite one of those scope entries.
    const u = planAiInitUnits(profile, {}).find(
      (candidate) => candidate.name === "ai-init-skill-curator",
    );
    if (!u) throw new Error("skill-curator not in plan");
    // ponytail: create .vibeflow/SKILL_INDEX.md so statSync passes on CI
    const dir = mkdtempSync(join(tmpdir(), "vf-scope-"));
    mkdirSync(join(dir, ".vibeflow"), { recursive: true });
    writeFileSync(join(dir, ".vibeflow/SKILL_INDEX.md"), "# fixture\n");
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      const r = aiInitReviewer(u, {
        status: "done",
        confidence: 1,
        evidence: ["regenerated .vibeflow/SKILL_INDEX.md"],
      });
      expect(r.pass).toBe(true);
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skill-curator reviewer rejects evidence citing an out-of-scope path", () => {
    // Replace the unit's scope with a narrow list, then verify the
    // reviewer only accepts evidence matching the scope — not arbitrary
    // skill paths.
    const u = planAiInitUnits(profile, { engines: ["claude"] }).find(
      (candidate) => candidate.name === "ai-init-skill-curator",
    );
    if (!u) throw new Error("skill-curator not in plan");
    // The default skill-curator scope is [".vibeflow/skills/", ".vibeflow/SKILL_INDEX.md"].
    // Evidence citing a path NOT in scope should fail the substring check.
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["installed .claude/skills/foo/SKILL.md"],
    });
    // .claude/skills/ is NOT in the skill-curator's scope (scope is
    // .vibeflow/skills/). The reviewer must reject.
    expect(r.pass).toBe(false);
  });

  test("empty intake.engines falls back to a single engine scope (not all engines)", () => {
    // When intake.engines is empty/absent, selectedInstructionScope must
    // fall back to INIT_DEFAULT_ENGINE (copilot), NOT the all-3 union.
    const u = planAiInitUnits(profile, {}).find(
      (candidate) => candidate.name === "ai-init-instruction-writer",
    );
    if (!u) throw new Error("instruction-writer not in plan");
    // Copilot scope = AGENTS.md + .github/copilot-instructions.md.
    // Must NOT include CLAUDE.md (the claude-only file).
    expect(u.scope).toEqual(["AGENTS.md", ".github/copilot-instructions.md"]);
    expect(u.scope).not.toContain("CLAUDE.md");
  });
});

describe("buildPhaseSkillEnrichmentUnits — batched shape", () => {
  // Issue 3: the previous shape was N units, one per phase. With a
  // typical 3-phase workflow that meant 3 separate engine calls on
  // the same prompt shape — wasteful (rate-limit) and slow (3x wall).
  // The current shape is ONE unit covering all phases; the engine
  // processes every phase section in a single turn. The reviewer
  // must then gate on every per-phase skill file existing on disk.

  const phases: AiInitIntake["workflowPhases"] = [
    {
      name: "detail design",
      description: "frozen spec",
      inputs: ["brain/docs/basic_designs/x.md"],
      outputs: ["brain/docs/detail_designs/x.md"],
    },
    {
      name: "implement",
      description: "code it",
      inputs: ["brain/docs/detail_designs/x.md"],
      outputs: ["brain/app/src/main/java/x.java"],
    },
    {
      name: "test",
      description: "prove it",
      inputs: ["brain/app/src/main/java/x.java"],
      outputs: ["brain/app/src/test/java/xTest.java"],
    },
  ];

  test("returns a single batched unit when 3 phases qualify", () => {
    const units = buildPhaseSkillEnrichmentUnits(
      { goal: "init", workflowPhases: phases },
      ["copilot"],
      (_e, slug) => `.vibeflow/skills/${slug}/SKILL.md`,
    );
    expect(units).toHaveLength(1);
    expect(units[0]?.name).toBe("ai-init-skill-enrich-batch");
  });

  test("the batched unit's scope covers every per-phase skill path", () => {
    const units = buildPhaseSkillEnrichmentUnits(
      { goal: "init", workflowPhases: phases },
      ["copilot"],
      (_e, slug) => `.vibeflow/skills/${slug}/SKILL.md`,
    );
    const u = units[0];
    if (!u) throw new Error("batched unit missing");
    expect(u.scope).toEqual([
      ".vibeflow/skills/detail-design/SKILL.md",
      ".vibeflow/skills/implement/SKILL.md",
      ".vibeflow/skills/test/SKILL.md",
    ]);
  });

  test("the batched unit's spec includes a section per phase", () => {
    const units = buildPhaseSkillEnrichmentUnits(
      { goal: "init", workflowPhases: phases },
      ["copilot"],
      (_e, slug) => `.vibeflow/skills/${slug}/SKILL.md`,
    );
    const u = units[0];
    if (!u) throw new Error("batched unit missing");
    expect(u.spec).toContain("Phase 1: detail design");
    expect(u.spec).toContain("Phase 2: implement");
    expect(u.spec).toContain("Phase 3: test");
  });

  test("phases with no inputs or no outputs are filtered out", () => {
    const mixed: AiInitIntake["workflowPhases"] = [
      { name: "good", description: "ok", inputs: ["a.md"], outputs: ["b.md"] },
      { name: "no-inputs", description: "ok", outputs: ["c.md"] },
      { name: "no-outputs", description: "ok", inputs: ["d.md"] },
    ];
    const units = buildPhaseSkillEnrichmentUnits(
      { goal: "init", workflowPhases: mixed },
      ["copilot"],
      (_e, slug) => `.vibeflow/skills/${slug}/SKILL.md`,
    );
    expect(units).toHaveLength(1);
    const u = units[0];
    if (!u) throw new Error("batched unit missing");
    expect(u.scope).toEqual([".vibeflow/skills/good/SKILL.md"]);
  });

  test("returns [] when no phases qualify (no engine calls)", () => {
    const units = buildPhaseSkillEnrichmentUnits(
      { goal: "init", workflowPhases: [] },
      ["copilot"],
      (_e, slug) => `.vibeflow/skills/${slug}/SKILL.md`,
    );
    expect(units).toEqual([]);
  });

  test("returns [] when engines is empty", () => {
    const units = buildPhaseSkillEnrichmentUnits(
      { goal: "init", workflowPhases: phases },
      [],
      (_e, slug) => `.vibeflow/skills/${slug}/SKILL.md`,
    );
    expect(units).toEqual([]);
  });
});

describe("aiInitReviewer — batched enrichment gate", () => {
  // The batched unit is reviewed as if it were a single multi-path
  // scope. Partial batches (some files written, some not) MUST fail
  // so the user can re-run to retry — we never claim success on a
  // half-finished enrichment.
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vf-enrich-"));
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  const skillPath = (slug: string): string => join(tmp, `${slug}.md`);

  function makeBatchedUnit(slugs: string[]): AiInitUnit {
    return {
      name: "ai-init-skill-enrich-batch",
      status: "pending",
      confidence: 1,
      scope: slugs.map(skillPath),
      acceptance: "",
      depends_on: [],
      gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      evidence: [],
    };
  }

  test("passes when every per-phase skill file exists on disk", () => {
    const slugs = ["detail-design", "implement", "test"];
    for (const s of slugs) {
      writeFileSync(skillPath(s), "# skill body\n");
    }
    const u = makeBatchedUnit(slugs);
    const r = aiInitReviewer(
      u,
      {
        status: "verifying",
        confidence: 1,
        evidence: slugs.map(skillPath),
      },
      tmp,
    );
    expect(r.pass).toBe(true);
  });

  test("fails when even one per-phase skill file is missing", () => {
    // Only write 2 of 3 files — partial batch.
    writeFileSync(skillPath("detail-design"), "# skill body\n");
    writeFileSync(skillPath("implement"), "# skill body\n");
    // test is missing.
    const slugs = ["detail-design", "implement", "test"];
    const u = makeBatchedUnit(slugs);
    const r = aiInitReviewer(
      u,
      {
        status: "verifying",
        confidence: 1,
        evidence: slugs.map(skillPath),
      },
      tmp,
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("missing");
    expect(r.reason).toContain("test");
  });
});

// ── buildFinisherBatchUnit + finisher-batch validator branches (L641-720, L965-981) ──

describe("buildFinisherBatchUnit (PR137 round 2)", () => {
  const baseProfile: ProjectProfile = {
    name: "demo",
    summary: "demo project",
    languages: ["TypeScript"],
    packageManager: "bun",
    buildCommand: "bun run build",
    testCommand: "bun test",
    lintCommand: "bun run lint",
    frameworks: ["React"],
    hasCI: true,
    manifests: [],
    findings: [],
  };

  test("builds a unit named ai-init-finishers-batch with the workflow-state finisher scope", () => {
    const intake: AiInitIntake = { goal: "init", engines: ["claude"] };
    const u = buildFinisherBatchUnit(baseProfile, intake, ["doc-writer"]);
    expect(u.name).toBe("ai-init-finishers-batch");
    // PR #251 consolidated the finisher set to the single workflow-state writer;
    // SETTINGS.json / WORKFLOW_POLICY.md / QUICKSTART.md are seeded by other layers.
    expect(u.scope).toEqual([".vibeflow/WORKFLOW_STATE.json"]);
  });

  test("uses detectedRoles when provided, falls back to ROLE_NAMES when empty", () => {
    const intake: AiInitIntake = { goal: "init", engines: ["claude"] };
    const u1 = buildFinisherBatchUnit(baseProfile, intake, ["doc-writer", "skill-author"]);
    expect(u1.spec).toContain("doc-writer, skill-author");
    const u2 = buildFinisherBatchUnit(baseProfile, intake, []);
    expect(u2.spec).toContain("Active roles in this repo:");
    // The fallback list contains at least the standard roles.
    expect(u2.spec).toMatch(/doc-writer|skill-author|tester/);
  });

  test("default goal + engines when intake omits them", () => {
    const intake: AiInitIntake = {};
    const u = buildFinisherBatchUnit(baseProfile, intake, []);
    expect(u.spec).toContain("Set up VibeFlow AI guidance for this repository");
    expect(u.spec).toContain("(default: copilot)");
  });

  test("aiInitReviewer: finisher-batch with all 4 files written + evidence → pass", () => {
    const intake: AiInitIntake = { goal: "init", engines: ["claude"] };
    const tmp = mkdtempSync(join(tmpdir(), "vf-fin-batch-all-"));
    const u = buildFinisherBatchUnit(baseProfile, intake, []);
    mkdirSync(join(tmp, ".vibeflow"), { recursive: true });
    for (const scope of u.scope ?? []) {
      mkdirSync(join(tmp, dirname(scope)), { recursive: true });
      writeFileSync(join(tmp, scope), "# content\n");
    }
    const r = aiInitReviewer(
      u,
      {
        status: "verifying",
        confidence: 1,
        evidence: u.scope ?? [],
      },
      tmp,
    );
    expect(r.pass).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("aiInitReviewer: finisher-batch with its file missing on disk → fail with reason", () => {
    const intake: AiInitIntake = { goal: "init", engines: ["claude"] };
    // Use a temp cwd so the test doesn't pick up the real
    // .vibeflow/WORKFLOW_STATE.json that exists in the repo root.
    // The validator's checkFileExists would otherwise see it and report pass.
    const tmp = mkdtempSync(join(tmpdir(), "vf-fin-batch-missing-"));
    const u = buildFinisherBatchUnit(baseProfile, intake, []);
    mkdirSync(join(tmp, ".vibeflow"), { recursive: true });
    // Deliberately do NOT write the scope file on disk — evidence cites it but
    // the file is absent, so the reviewer must fail.
    const r = aiInitReviewer(
      u,
      {
        status: "verifying",
        confidence: 1,
        evidence: u.scope ?? [],
      },
      tmp,
    );
    expect(r.pass).toBe(false);
    // Either the "missing evidence" or "file doesn't exist" path
    // may fire (validator's checkFileExists iterates evidence).
    expect(r.reason).toMatch(/missing|exists/);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("aiInitReviewer: finisher-batch evidence missing a path → fail with reason", () => {
    const intake: AiInitIntake = { goal: "init", engines: ["claude"] };
    const tmp = mkdtempSync(join(tmpdir(), "vf-fin-batch-ev-missing-"));
    const u = buildFinisherBatchUnit(baseProfile, intake, []);
    mkdirSync(join(tmp, ".vibeflow"), { recursive: true });
    for (const scope of u.scope ?? []) {
      mkdirSync(join(tmp, dirname(scope)), { recursive: true });
      writeFileSync(join(tmp, scope), "# content\n");
    }
    // Evidence cites none of the scope paths → fail.
    const r = aiInitReviewer(
      u,
      {
        status: "verifying",
        confidence: 1,
        evidence: [],
      },
      tmp,
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/missing|no evidence/);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("aiInitReviewer: finisher-batch with empty scope → fail with no-scope reason", () => {
    const intake: AiInitIntake = { goal: "init", engines: ["claude"] };
    const u = buildFinisherBatchUnit(baseProfile, intake, []);
    // Construct a pathological unit with empty scope to exercise the
    // early-return guard in the finisher-batch validator. Non-empty
    // evidence is needed so we don't trip the upstream
    // "no evidence recorded" check at L794 first.
    const uEmpty: AiInitUnit = { ...u, scope: [] };
    const r = aiInitReviewer(
      uEmpty,
      { status: "verifying", confidence: 1, evidence: ["dummy"] },
      "/tmp",
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("no scope paths");
  });

  // ── Sibling branches in aiInitReviewer: skill-enrich empty-scope + missing-evidence, ctx7 auth hint ──
  // Pre-existing residual gaps (273, 1036, 1042-1045) — covered here
  // so the file reaches 100% line coverage.

  test("aiInitReviewer: skill-enrich unit with empty scope → fail with no-scope reason", () => {
    const u: AiInitUnit = {
      name: "ai-init-skill-enrich-batch",
      status: "pending",
      confidence: 1,
      scope: [],
      acceptance: "",
      depends_on: [],
      gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      evidence: [],
    };
    const r = aiInitReviewer(
      u,
      { status: "verifying", confidence: 1, evidence: ["dummy"] },
      "/tmp",
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("no scope paths");
  });

  test("aiInitReviewer: skill-enrich unit missing evidence path → fail with missing reason", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vf-enrich-missing-"));
    try {
      const slugs = ["detail-design", "implement", "test"];
      for (const s of slugs) {
        writeFileSync(join(tmp, `${s}.md`), "# body\n");
      }
      const u: AiInitUnit = {
        name: "ai-init-skill-enrich-batch",
        status: "pending",
        confidence: 1,
        scope: slugs.map((s) => join(tmp, `${s}.md`)),
        acceptance: "",
        depends_on: [],
        gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        evidence: [],
      };
      // Non-empty evidence that omits one scope path → L1042-1045 fires.
      const r = aiInitReviewer(
        u,
        { status: "verifying", confidence: 1, evidence: [join(tmp, "detail-design.md")] },
        tmp,
      );
      expect(r.pass).toBe(false);
      expect(r.reason).toContain("missing");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("planAiInitUnits: ctx7 authenticated branch (L273)", () => {
  const baseProfile: ProjectProfile = {
    name: "demo",
    summary: "demo project",
    languages: ["TypeScript"],
    packageManager: "bun",
    buildCommand: "bun run build",
    testCommand: "bun test",
    lintCommand: "bun run lint",
    frameworks: ["React"],
    hasCI: true,
    manifests: [],
    findings: [],
  };

  test("skill-curator spec includes ctx7 auth hint when intake.ctx7Authenticated=true", () => {
    const intake: AiInitIntake = {
      goal: "init",
      engines: ["claude"],
      ctx7Authenticated: true,
    };
    const units = planAiInitUnits(baseProfile, intake, []);
    const curator = units.find((u) => u.name === "ai-init-skill-curator");
    expect(curator).toBeDefined();
    expect(curator?.spec).toContain("ctx7 is already authenticated from the CLI pre-check");
  });
});
