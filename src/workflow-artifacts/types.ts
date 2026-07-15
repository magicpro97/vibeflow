import type { AgentEngine } from "../agents/render.js";
import type { WorkflowPhase } from "../ai-init-workflow.js";

export type { WorkflowPhase };

// ── Engine config (add a new entry here to support a new engine) ──────────

export interface EngineConfig {
  instructionFiles: string[];
  skillRoot: string;
}

export const ENGINE_CONFIGS: Record<AgentEngine, EngineConfig> = {
  claude: {
    instructionFiles: ["CLAUDE.md", "AGENTS.md"],
    skillRoot: ".claude/skills",
  },
  codex: { instructionFiles: ["AGENTS.md"], skillRoot: ".agents/skills" },
  copilot: { instructionFiles: [".github/copilot-instructions.md"], skillRoot: ".github/skills" },
  opencode: { instructionFiles: ["AGENTS.md"], skillRoot: ".opencode/skills" },
};

/**
 * Single source of truth for per-engine skill mirror directories.
 *
 * This is the WRITE side: `vf init` and `vf skills sync` copy skills
 * from `.vibeflow/skills/<name>/` into each of these roots. The READ
 * side (`src/skills/registry.ts` and `src/skills/validator.ts`) MUST
 * scan the same roots so that a freshly-synced skill is discoverable
 * by `vf skills list` / `vf skills validate`.
 *
 * Audit (C2) found that this list was duplicated as `MIRRORS` in
 * `src/skills/sync.ts` AND that the read side had a DIFFERENT,
 * overlapping set of roots (`.vibeflow`, `.kiro`, `.claude`), missing
 * `.agents` and `.github` — so a skill synced to codex/copilot mirrors
 * was invisible to `vf skills list`. The fix: both sides import
 * `SKILL_MIRRORS` from this module.
 */
export const SKILL_MIRRORS: string[] = [
  ENGINE_CONFIGS.claude.skillRoot,
  ENGINE_CONFIGS.codex.skillRoot,
  ENGINE_CONFIGS.copilot.skillRoot,
];

// ── Public options ─────────────────────────────────────────────────────────

export interface WorkflowArtifactOpts {
  phases: WorkflowPhase[];
  engines: AgentEngine[];
  projectName: string;
  base: string;
}

/**
 * Dependency-injection slot for the warn callback used by
 * `generateWorkflowArtifacts`. Default is `console.warn` in production;
 * tests pass a capturing function to assert warnings without polluting
 * stdout. Matches the `copySkillCreator` pattern at the top of this
 * file.
 */
export interface GenerateArtifactsInject {
  onWarn?: (msg: string) => void;
}

// ── Phase helpers ──────────────────────────────────────────────────────────

export function phaseSlug(phase: WorkflowPhase): string {
  return phase.name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * True when the user supplied concrete input AND output paths for the
 * phase. When true, the AI enrichment (Phase 2) is expected to read the
 * declared files and generate a project-specific skill; when false, a
 * generic common template is copied instead.
 */
export function hasUserDeclaredIO(phase: WorkflowPhase): boolean {
  const inputs = phase.inputs?.filter((s) => s.trim().length > 0) ?? [];
  const outputs = phase.outputs?.filter((s) => s.trim().length > 0) ?? [];
  return inputs.length > 0 && outputs.length > 0;
}
