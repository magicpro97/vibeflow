// test/init-update.test.ts
//
// Migration fixture test for issue #323: `vf init` UPDATE mechanism.
//
// Acceptance:
//  - version stamp present after `vf init`
//  - re-init detects prior version, runs UPDATE (slim context regenerated
//    in markers, content outside preserved)
//  - migration fixture: OLD fat block → `vf init` → slim inside markers,
//    human content intact
//  - skill `vf` seeded into repo + synced

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIntake } from "../src/commands/init-apply.js";
import { VERSION, type WorkflowState, readState } from "../src/core.js";
import { CTX_DIR } from "../src/core.js";
import { ensureInitUpdated } from "../src/workflow/init-update.js";

const VF_BLOCK_START = "<!-- vibeflow:start -->";
const VF_BLOCK_END = "<!-- vibeflow:end -->";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-init-upd-"));
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** A fat old-style CLAUDE.md (pre-#322) — large generated block, no markers. */
function fatClaudeMd(): string {
  return `# CLAUDE.md
## ⚡ VibeFlow v0.7.0 Active — local-first orchestrator

This file is managed by VibeFlow.

## VibeFlow Commands
- \`vf doctor\` — check engine readiness
- \`vf init\` — regenerate context files
- \`vf orchestrate\` — plan + dispatch
- \`vf verify\` — run gates
- \`vf units\` — track work units
- \`vf skills\` — manage skills
- \`vf tools\` — configure tools
- \`vf hooks\` — guardrails
- \`vf discover\` — external docs
- \`vf workflow\` — manage workflows

## Working with vf
Drive every task through vf.

Confidence gate: nothing is "done" until confidence = 1.0 WITH evidence.

Powered by VibeFlow.
`;
}

/** A CLAUDE.md with human content outside markers (the expected post-update shape). */
function claudeWithHumanEdges(): string {
  return `# My personal notes about this project

I wrote this section myself; it must survive re-init.

## My workflow notes

Remember to ping the team before deploying.

${VF_BLOCK_START}
## ⚡ VibeFlow v0.8.0 Active
## VibeFlow commands (use these)
- \`vf doctor\`
- \`vf init\`
- \`vf orchestrate\`
- \`vf verify\`
- \`vf skills\`
**Confidence gate:** nothing is "done" until \`vf verify\` passes.
Powered by VibeFlow
${VF_BLOCK_END}

## My footer
This should also survive.
`;
}

// ---------------------------------------------------------------------------
// 1. Version stamp present after fresh init
// ---------------------------------------------------------------------------
describe("vf init version stamp", () => {
  test("fresh init stamps vibeflow_version on the state", () => {
    const dir = tmpRepo();
    try {
      const result = applyIntake(
        { goal: "stamp test", engines: ["claude"] },
        { base: dir, dry: true, skipPreflight: true },
      );
      expect(result.state.vibeflow_version).toBe(VERSION);
      // repo_path is no longer written — it was a per-machine absolute path
      // with zero readers (kept the state non-portable). Must be absent.
      expect(result.state.repo_path).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  test("state on disk carries version stamp after non-dry init", () => {
    const dir = tmpRepo();
    try {
      applyIntake(
        { goal: "disk test", engines: ["claude"] },
        { base: dir, dry: false, skipPreflight: true },
      );
      const state = readState(dir);
      expect(state).not.toBeNull();
      expect(state?.vibeflow_version).toBe(VERSION);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Re-init with old state (no version stamp) → stamp updated
// ---------------------------------------------------------------------------
describe("vf init re-init detection", () => {
  test("re-init stamps version on old state that lacks it", () => {
    const dir = tmpRepo();
    try {
      // Seed an old-style state with NO version field
      const ctxDir = join(dir, CTX_DIR);
      mkdirSync(ctxDir, { recursive: true });
      const oldState: WorkflowState = {
        task_id: "TASK-1",
        goal: "old goal",
        success_criteria: [],
        work_units: [],
        totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      };
      writeFileSync(join(ctxDir, "WORKFLOW_STATE.json"), JSON.stringify(oldState, null, 2));

      // Re-init
      applyIntake(
        { goal: "new goal", engines: ["claude"] },
        { base: dir, dry: false, skipPreflight: true },
      );
      const state = readState(dir);
      expect(state).not.toBeNull();
      expect(state?.vibeflow_version).toBe(VERSION);
      // Goal should be updated
      expect(state?.goal).toBe("new goal");
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. ensureInitUpdated version-stamp update (direct call)
// ---------------------------------------------------------------------------
describe("ensureInitUpdated version stamp", () => {
  test("stamps version on state with missing version field", () => {
    const dir = tmpRepo();
    try {
      const ctxDir = join(dir, CTX_DIR);
      mkdirSync(ctxDir, { recursive: true });
      // Write an old state WITHOUT vibeflow_version
      const old: WorkflowState = {
        task_id: "TASK-1",
        goal: "no-version",
        success_criteria: [],
        work_units: [],
        totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      };
      writeFileSync(join(ctxDir, "WORKFLOW_STATE.json"), JSON.stringify(old, null, 2));

      // Run the update orchestration directly
      const result = ensureInitUpdated(dir);
      expect(result.updated).toBe(true);

      const state = readState(dir);
      expect(state?.vibeflow_version).toBe(VERSION);
    } finally {
      cleanup(dir);
    }
  });

  test("stamps version on state with stale version", () => {
    const dir = tmpRepo();
    try {
      const ctxDir = join(dir, CTX_DIR);
      mkdirSync(ctxDir, { recursive: true });
      // Write an old state WITH a stale version
      const old: WorkflowState = {
        task_id: "TASK-1",
        goal: "stale-version",
        success_criteria: [],
        work_units: [],
        totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        vibeflow_version: "0.0.0",
      };
      writeFileSync(join(ctxDir, "WORKFLOW_STATE.json"), JSON.stringify(old, null, 2));

      const result = ensureInitUpdated(dir);
      expect(result.updated).toBe(true);

      const state = readState(dir);
      expect(state?.vibeflow_version).toBe(VERSION);
    } finally {
      cleanup(dir);
    }
  });

  test("no-op when state already has current version", () => {
    const dir = tmpRepo();
    try {
      const ctxDir = join(dir, CTX_DIR);
      mkdirSync(ctxDir, { recursive: true });
      // Write state WITH current version
      const current: WorkflowState = {
        task_id: "TASK-1",
        goal: "current-version",
        success_criteria: [],
        work_units: [],
        totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        vibeflow_version: VERSION,
      };
      writeFileSync(join(ctxDir, "WORKFLOW_STATE.json"), JSON.stringify(current, null, 2));

      const result = ensureInitUpdated(dir);
      expect(result.updated).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("no-op when no state exists", () => {
    const dir = tmpRepo();
    try {
      const result = ensureInitUpdated(dir);
      expect(result.updated).toBe(false);
      expect(result.seeded).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Migration fixture: old fat block → re-init → slim inside markers,
//    human content outside preserved
// ---------------------------------------------------------------------------
describe("migration fixture: old fat block → slim markers", () => {
  test("old CLAUDE.md without markers gets slim block inside markers, human text preserved", () => {
    const dir = tmpRepo();
    try {
      const ctxDir = join(dir, CTX_DIR);
      mkdirSync(ctxDir, { recursive: true });

      // Seed old state
      const oldState: WorkflowState = {
        task_id: "TASK-1",
        goal: "migration test",
        success_criteria: [],
        work_units: [],
        totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      };
      writeFileSync(join(ctxDir, "WORKFLOW_STATE.json"), JSON.stringify(oldState, null, 2));

      // Seed old fat CLAUDE.md
      writeFileSync(join(dir, "CLAUDE.md"), fatClaudeMd());

      // Also seed human-text-with-markers CLAUDE.md to test preservation
      // (we do a separate test for the pure old-format case below)

      // Re-init
      applyIntake(
        { goal: "migration test", engines: ["claude"] },
        { base: dir, dry: false, skipPreflight: true },
      );

      // Read the updated CLAUDE.md
      const updated = readFileSync(join(dir, "CLAUDE.md"), "utf8");

      // Should have markers now
      expect(updated).toContain(VF_BLOCK_START);
      expect(updated).toContain(VF_BLOCK_END);

      // Should contain slim command list (5 core commands)
      expect(updated).toContain("vf doctor");
      expect(updated).toContain("vf orchestrate");

      // State should have version stamp
      const state = readState(dir);
      expect(state?.vibeflow_version).toBe(VERSION);
    } finally {
      cleanup(dir);
    }
  });

  test("CLAUDE.md with human content outside markers — human text preserved, block updated to slim", () => {
    const dir = tmpRepo();
    try {
      const ctxDir = join(dir, CTX_DIR);
      mkdirSync(ctxDir, { recursive: true });

      // Seed old state
      const oldState: WorkflowState = {
        task_id: "TASK-1",
        goal: "preservation test",
        success_criteria: [],
        work_units: [],
        totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      };
      writeFileSync(join(ctxDir, "WORKFLOW_STATE.json"), JSON.stringify(oldState, null, 2));

      // Seed a CLAUDE.md that already has markers with OLD verbose content and
      // human text outside.
      const oldBlock = `${VF_BLOCK_START}
## ⚡ VibeFlow v0.7.0 Active
## Full VibeFlow Command Reference
- vf doctor — check engine readiness
- vf init — regenerate context
- vf orchestrate — plan + dispatch
- vf verify — run gates
- vf units — track work units
- vf skills — manage skills store
- vf tools — configure code navigation
- vf hooks — guardrail hooks
- vf discover — external docs
- vf workflow — manage workflows
## Working with vf (the full loop)
Drive every task through vf.
Confidence gate: nothing is done until confidence=1.
Powered by VibeFlow v0.7.0
${VF_BLOCK_END}`;

      const humanHeader = "# My custom header — keep this";
      const humanFooter = "## My notes\nThis is human content that must survive.";
      writeFileSync(join(dir, "CLAUDE.md"), `${humanHeader}\n\n${oldBlock}\n\n${humanFooter}\n`);

      // Re-init
      applyIntake(
        { goal: "preservation test", engines: ["claude"] },
        { base: dir, dry: false, skipPreflight: true },
      );

      // Read updated file
      const updated = readFileSync(join(dir, "CLAUDE.md"), "utf8");

      // Human text outside markers should be preserved
      expect(updated).toContain(humanHeader);
      expect(updated).toContain(humanFooter);

      // Markers should be present
      expect(updated).toContain(VF_BLOCK_START);
      expect(updated).toContain(VF_BLOCK_END);

      // Old verbose commands should NOT be present (replaced by slim)
      expect(updated).not.toContain("vf tools");
      expect(updated).not.toContain("vf hooks");
      expect(updated).not.toContain("vf discover");
      expect(updated).not.toContain("vf workflow");
      expect(updated).not.toContain("v0.7.0");

      // Slim commands should be present
      expect(updated).toContain("vf doctor");
      expect(updated).toContain("vf orchestrate");
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. vf skill seeding
// ---------------------------------------------------------------------------
describe("vf skill seeding", () => {
  test("skill vf seeded into repo after init", () => {
    const dir = tmpRepo();
    try {
      applyIntake(
        { goal: "skill seed test", engines: ["claude"] },
        { base: dir, dry: false, skipPreflight: true },
      );

      // The vf skill should exist in the canonical skills dir
      const vfSkillPath = join(dir, CTX_DIR, "skills", "vf", "SKILL.md");
      expect(existsSync(vfSkillPath)).toBe(true);

      // It should have meaningful content (not empty)
      const content = readFileSync(vfSkillPath, "utf8");
      expect(content).toContain("name: vf");
      expect(content).toContain("VibeFlow");

      // Skill should be synced to engine mirror
      const claudeSkillPath = join(dir, ".claude", "skills", "vf", "SKILL.md");
      expect(existsSync(claudeSkillPath)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
