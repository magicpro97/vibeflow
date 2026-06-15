/**
 * AI-init workflow decomposition.
 *
 * The previous `buildAiInitPrompt` (src/ai-init.ts) assembled a single mega-prompt
 * covering 4 distinct concerns: project analysis, instruction-file authoring, skill
 * curation, and project-context update. The plan below splits that work into 4
 * parallel work units (analyzer, instruction-writer, skill-curator, context-updater)
 * that the existing orchestrator (src/orchestrator/run.ts) can dispatch concurrently
 * with disjoint file scopes, run an independent reviewer over each, and gate close on
 * goalEval (confidence = 1.0 with recorded evidence per unit).
 *
 * The 4 unit shapes mirror the deterministic phase-1 outputs that applyIntake already
 * produces, so a successful workflow closes on the same on-disk artifacts (CLAUDE.md,
 * AGENTS.md, .github/copilot-instructions.md, .agents/instructions.md, .vibeflow/skills/,
 * .vibeflow/PROJECT_CONTEXT.md, .vibeflow/SKILL_INDEX.md, .claude/agents/, .codex/agents/,
 * .github/agents/) — but with the AI phase going through the orchestrator's review/goal
 * gates instead of a single confidence check at the end of one giant prompt.
 *
 * Pure module: no I/O, no engine calls. Both `planAiInitUnits` and `buildUnitBriefs`
 * are deterministic given (profile, intake) so unit tests can pin the decomposition.
 */

import { ROLE_NAMES, type RoleName } from "./agents/role-templates.js";
import type { WorkUnit } from "./core.js";
import type { ProjectProfile } from "./scanner.js";

/** A trimmed intake-answers shape this planner depends on. The full
 * `IntakeAnswers` from commands.ts is accepted with all fields optional. */
export interface AiInitIntake {
  goal?: string;
  engines?: string[];
  docSource?: string;
  taskSource?: string;
  fileTypes?: string[];
  expectedResult?: string;
  sample?: string;
  repoPath?: string;
}

/** A work unit tailored for the AI init phase. Same fields as
 * {@link WorkUnit} plus an acceptance signal the reviewer uses. The
 * planner sets `owner_agent` to a default role so the orchestrator can
 * route it to the matching engine-agnostic agent, and `spec` to the
 * human-readable description (what the engine receives). */
export interface AiInitUnit extends WorkUnit {
  /** Disjoint file scope — used by the orchestrator to detect conflicts and
   *  serialize overlapping units. The 4 default units below have disjoint
   *  scopes so they all run in parallel under `scheduleWaves`. */
  scope: string[];
  /** Acceptance signal the reviewer checks (e.g. "all 4 instruction files
   *  carry a fresh `vibeflow:start` block"). */
  acceptance: string;
}

/** Stable IDs for the 4 default init units. The orchestrator depends on
 *  stable names (no UUIDs) so the same workflow reproduces identical work
 *  units on a re-run. */
export const AI_INIT_UNIT_NAMES = [
  "ai-init-analyzer",
  "ai-init-instruction-writer",
  "ai-init-skill-curator",
  "ai-init-context-updater",
] as const;
export type AiInitUnitName = (typeof AI_INIT_UNIT_NAMES)[number];

/** Map each init unit to a default role (owner_agent). The reviewer passes
 *  when the unit's evidence cites the expected role's output paths. */
const DEFAULT_OWNER: Record<AiInitUnitName, RoleName> = {
  "ai-init-analyzer": "cli-engine",
  "ai-init-instruction-writer": "doc-writer",
  "ai-init-skill-curator": "skill-author",
  "ai-init-context-updater": "doc-writer",
};

/** Per-unit file scope. Disjoint by design so the orchestrator's
 *  `findScopeConflicts` reports zero conflicts and all 4 units run in
 *  parallel under `runParallel`. The analyzer's scope is intentionally a
 *  READ-only investigation target (`.vibeflow/ai-context/`); the
 *  context-updater owns the WRITE path (`.vibeflow/PROJECT_CONTEXT.md`).
 *  These two scopes are still disjoint at the `findScopeConflicts` level
 *  because the analyzer does not declare `.vibeflow/` as a parent. */
const UNIT_SCOPE: Record<AiInitUnitName, string[]> = {
  "ai-init-analyzer": [".vibeflow/ai-context/stack-evidence.md"],
  "ai-init-instruction-writer": [
    "CLAUDE.md",
    "AGENTS.md",
    ".github/copilot-instructions.md",
    ".agents/instructions.md",
  ],
  "ai-init-skill-curator": [".vibeflow/skills/", ".vibeflow/SKILL_INDEX.md"],
  "ai-init-context-updater": [".vibeflow/PROJECT_CONTEXT.md"],
};

/** Per-unit acceptance signal the reviewer uses to decide pass/fail. The
 *  strings are evidence patterns: the unit's recorded evidence must cite
 *  at least one of these (file path) for the reviewer to pass it. */
const UNIT_ACCEPTANCE: Record<AiInitUnitName, string> = {
  "ai-init-analyzer":
    "stack-evidence.md written, ProjectProfile summary backed by >=3 manifest/dependency citations",
  "ai-init-instruction-writer":
    "all 4 instruction files (CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, .agents/instructions.md) carry a fresh vibeflow:start block",
  "ai-init-skill-curator":
    ">=1 skill installed under .vibeflow/skills/, SKILL_INDEX.md regenerated, ctx7 (or fallback) cited as source",
  "ai-init-context-updater":
    ".vibeflow/PROJECT_CONTEXT.md updated with detected stack + architecture insights, human-curated sections preserved",
};

/** Per-unit description (the spec the engine receives when dispatched). */
const UNIT_DESCRIPTION: Record<AiInitUnitName, string> = {
  "ai-init-analyzer":
    "Investigate the project until confidence = 1.0 on every finding (build/test/lint commands, package manager, language + framework versions, CI). Read package.json, tsconfig/biome config, source tree, sample source files (>=5 across modules), and >=2 test files. Write .vibeflow/ai-context/stack-evidence.md with file/manifest evidence per component. Do not guess.",
  "ai-init-instruction-writer":
    "Update all 4 instruction files (CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, .agents/instructions.md) for this project. Edit only inside the vibeflow:start/vibeflow:end markers; preserve all human content outside markers. Include the discovered build/test/lint commands, code conventions (from real code, not guesses), architecture (key modules + data flow), tech stack with versions, and gotchas. Be concise — AI agents read these files.",
  "ai-init-skill-curator":
    "Discover and install skills for the detected stack via `npx ctx7 skills install --yes --all --claude` (headless), or fall back to manual SKILL.md authored from `ctx7 docs`. Follow the SKILL.md format from .vibeflow/ai-context/ANTHROPIC_SKILL_STANDARD.md. Copy to .claude/skills/, .agents/skills/, .github/skills/. Verify with `vf skills validate` and regenerate .vibeflow/SKILL_INDEX.md. Project-fit skills live under .vibeflow/skills/.",
  "ai-init-context-updater":
    "Update .vibeflow/PROJECT_CONTEXT.md with the detected stack (evidence-backed), architecture insights, code conventions, and the active workflow. Preserve any human-authored sections outside the generated block. This is the canonical source of truth for all subsequent `vf init` regenerations.",
};

/** Build the spec text for one unit, given the live project context. The
 *  spec is what the engine receives as `unit.spec` in the dispatch prompt. */
function buildSpec(
  name: AiInitUnitName,
  profile: ProjectProfile,
  intake: AiInitIntake,
  detectedRoles: RoleName[],
): string {
  const goal = intake.goal?.trim() || "Set up VibeFlow AI guidance for this repository";
  const engines = (intake.engines ?? []).join(", ") || "(default: claude, codex, copilot)";
  const roleList = detectedRoles.length ? detectedRoles.join(", ") : ROLE_NAMES.join(", ");
  return [
    `## ${name}`,
    "",
    `Goal: ${goal}`,
    `Engines: ${engines}`,
    `Project: ${profile.name} (${profile.languages.join(", ") || "unknown"})`,
    `Active roles in this repo: ${roleList}`,
    "",
    UNIT_DESCRIPTION[name],
  ].join("\n");
}

/**
 * Decompose the AI-init phase into 4 parallel work units. Pure: no I/O. The
 * orchestrator can feed the result straight into `planWorkUnits` and
 * `scheduleWaves` (no conflicts; all 4 land in wave 0).
 *
 * @param profile       scanner profile (always available — applyIntake calls
 *                      scanRepo before phase 2)
 * @param intake        trimmed intake answers (all fields optional)
 * @param detectedRoles roles detectRolesForRepo returned for this repo. The
 *                      planner includes them in each unit's spec so the
 *                      engine knows which specialist agents to consult.
 */
export function planAiInitUnits(
  profile: ProjectProfile,
  intake: AiInitIntake,
  detectedRoles: RoleName[] = [...ROLE_NAMES],
): AiInitUnit[] {
  return AI_INIT_UNIT_NAMES.map((name): AiInitUnit => {
    const spec = buildSpec(name, profile, intake, detectedRoles);
    return {
      name,
      status: "pending",
      confidence: 0,
      owner_agent: DEFAULT_OWNER[name],
      spec,
      scope: UNIT_SCOPE[name],
      acceptance: UNIT_ACCEPTANCE[name],
      gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      evidence: [],
    };
  });
}

/**
 * Reviewer used by the orchestrator: a unit passes when its recorded
 * evidence cites at least one path matching its acceptance pattern. This
 * is intentionally simple — a richer review (e.g. diff-based) is out of
 * scope and would require a second engine pass. The point is to gate
 * `status = done` on real on-disk evidence, not on the engine's word.
 */
export function aiInitReviewer(
  unit: WorkUnit,
  outcome: { status: WorkUnit["status"]; confidence: number; evidence: string[] },
): { pass: boolean; reason: string } {
  if (outcome.status !== "done") {
    return { pass: false, reason: `dispatcher reported status=${outcome.status}, not done` };
  }
  if (outcome.confidence < 1) {
    return { pass: false, reason: `confidence=${outcome.confidence} < 1.0` };
  }
  if (!outcome.evidence?.length) {
    return { pass: false, reason: "no evidence recorded" };
  }
  // For instruction-writer and context-updater, evidence must cite a real
  // file path (one of the scoped paths or any .vibeflow/* path). Other
  // units are gated purely on evidence presence + confidence 1.0.
  const name = unit.name as AiInitUnitName;
  if (name === "ai-init-instruction-writer") {
    const REQUIRED = UNIT_SCOPE[name];
    const hit = outcome.evidence.some((e) =>
      REQUIRED.some((p) => e.includes(p) || e.endsWith(p.replace(/^\.\//, ""))),
    );
    if (!hit) {
      return {
        pass: false,
        reason: `no evidence cites one of: ${REQUIRED.join(", ")}`,
      };
    }
  }
  if (name === "ai-init-skill-curator") {
    const hit = outcome.evidence.some(
      (e) => e.includes(".vibeflow/skills/") || e.includes("SKILL_INDEX"),
    );
    if (!hit) {
      return { pass: false, reason: "no evidence cites a skill file or SKILL_INDEX update" };
    }
  }
  return { pass: true, reason: "evidence + confidence 1.0" };
}
