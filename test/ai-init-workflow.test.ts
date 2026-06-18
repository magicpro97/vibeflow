import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("emits 8 Tier-1 adapter units in canonical order (no phase units without intake)", () => {
    const units = planAiInitUnits(profile, { goal: "ship it" });
    expect(units).toHaveLength(8);
    expect(units.map((u) => u.name)).toEqual([
      "ai-init-analyzer",
      "ai-init-instruction-writer",
      "ai-init-skill-curator",
      "ai-init-context-updater",
      "ai-init-tool-configurator",
      "ai-init-workflow-policy-writer",
      "ai-init-workflow-state-writer",
      "ai-init-quickstart-writer",
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

  test("quickstart-writer scope is exactly ['QUICKSTART.md'] regardless of engines", () => {
    const copilot = planAiInitUnits(profile, { engines: ["copilot"] }).find(
      (u) => u.name === "ai-init-quickstart-writer",
    );
    expect(copilot?.scope).toEqual(["QUICKSTART.md"]);

    const claude = planAiInitUnits(profile, { engines: ["claude"] }).find(
      (u) => u.name === "ai-init-quickstart-writer",
    );
    expect(claude?.scope).toEqual(["QUICKSTART.md"]);

    // Owner is doc-writer, same family as instruction-writer.
    expect(copilot?.owner_agent).toBe("doc-writer");
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
    expect(seen.size).toBe(8);
  });

  test("emits one Tier-2 unit per WorkflowPhase, after the 8 adapters", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [
        { name: "analyze", description: "Read the repo", dod: "stack table written" },
        { name: "ship", description: "Open a PR", dod: "PR opened" },
      ],
    });
    expect(units).toHaveLength(10);
    expect(units[8]?.name).toMatch(/^ai-init-phase-analyze-1$/);
    expect(units[9]?.name).toMatch(/^ai-init-phase-ship-2$/);
  });

  test("phase unit scope falls back to a sentinel when outputs are missing", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [{ name: "noop", description: "no outputs", dod: "noop" }],
    });
    const phase = units[8];
    expect(phase).toBeDefined();
    expect(phase?.scope).toEqual([".vibeflow/phase-outputs/noop.md"]);
  });

  test("phase unit name is path-safe (no traversal from crafted phase.name)", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [{ name: "../../../etc/passwd", description: "x", dod: "x" }],
    });
    const phase = units[8];
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
    expect(units[8]?.owner_agent).toBe("cli-engine");
    expect(units[9]?.owner_agent).toBe("web-ui");
    expect(units[10]?.owner_agent).toBe("doc-writer");
  });

  // Branch coverage for resolveOwner: every regex branch in src/ai-init-workflow.ts:243-248
  // + the default fallback at line 249.
  test("resolveOwner fuzzy-matches skill/capability keywords to skill-author", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [{ name: "sk", description: "add new skill", ownerHint: "skill", dod: "ok" }],
    });
    expect(units[8]?.owner_agent).toBe("skill-author");
  });

  test("resolveOwner fuzzy-matches preflight/probe/quota keywords to preflight-engine", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [
        { name: "pf", description: "add preflight probe", ownerHint: "preflight", dod: "ok" },
      ],
    });
    expect(units[8]?.owner_agent).toBe("preflight-engine");
  });

  test("resolveOwner fuzzy-matches dispatch/orchestrat/runner/workflow keywords to dispatch-runner", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [
        { name: "dr", description: "add workflow runner", ownerHint: "dispatch", dod: "ok" },
      ],
    });
    expect(units[8]?.owner_agent).toBe("dispatch-runner");
  });

  test("resolveOwner defaults to dispatch-runner when hint is empty/unknown", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [
        { name: "u1", description: "no hint", ownerHint: "totally-unknown-role", dod: "ok" },
        { name: "u2", description: "no hint at all", dod: "ok" },
      ],
    });
    expect(units[8]?.owner_agent).toBe("dispatch-runner");
    expect(units[9]?.owner_agent).toBe("dispatch-runner");
  });

  test("phase unit carries skills_injected and skills_required from the resolved role", () => {
    const units = planAiInitUnits(profile, {
      workflowPhases: [{ name: "x", description: "x", ownerHint: "cli-engine", dod: "x" }],
    });
    const phase = units[8];
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

  test("tool-configurator fails when SETTINGS.json fixture is deleted (substring match but file missing)", () => {
    rmSync(join(tmpDir, ".vibeflow/SETTINGS.json"));
    const u = unit("ai-init-tool-configurator");
    const r = aiInitReviewer(u, {
      status: "verifying",
      confidence: 1,
      evidence: ["updated .vibeflow/SETTINGS.json tools.codegraph"],
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

  test("passes tool-configurator when evidence cites SETTINGS.json", () => {
    const u = unit("ai-init-tool-configurator");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["updated .vibeflow/SETTINGS.json tools.codegraph"],
    });
    expect(r.pass).toBe(true);
  });

  test("fails tool-configurator when evidence is unrelated", () => {
    const u = unit("ai-init-tool-configurator");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["updated README"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("SETTINGS.json");
  });

  test("passes workflow-policy-writer when evidence cites WORKFLOW_POLICY.md", () => {
    const u = unit("ai-init-workflow-policy-writer");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: [".vibeflow/WORKFLOW_POLICY.md updated"],
    });
    expect(r.pass).toBe(true);
  });

  test("fails workflow-policy-writer when evidence is unrelated", () => {
    const u = unit("ai-init-workflow-policy-writer");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["updated README"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("WORKFLOW_POLICY");
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

  test("passes quickstart-writer when evidence cites QUICKSTART.md", () => {
    const u = unit("ai-init-quickstart-writer");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["rendered QUICKSTART.md from skeleton"],
    });
    expect(r.pass).toBe(true);
  });

  test("fails quickstart-writer when evidence never cites QUICKSTART.md", () => {
    const u = unit("ai-init-quickstart-writer");
    const r = aiInitReviewer(u, {
      status: "done",
      confidence: 1,
      evidence: ["updated README"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("QUICKSTART.md");
  });

  test("quickstart-writer fails when QUICKSTART.md fixture is missing (file-exists red path)", () => {
    rmSync(join(tmpDir, "QUICKSTART.md"));
    const u = unit("ai-init-quickstart-writer");
    const r = aiInitReviewer(u, {
      status: "verifying",
      confidence: 1,
      evidence: ["QUICKSTART.md"],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/not a regular file/);
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
    })[8];
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
    })[8];
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
    })[8];
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
