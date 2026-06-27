/**
 * AI-init workflow types and constants.
 *
 * Pure leaf module — imports only from core.js and role-templates.js.
 * Does NOT import from the facade or sibling modules.
 */

import type { RoleName } from "../agents/role-templates.js";
import type { Engine, WorkUnit } from "../core.js";
export interface AiInitIntake {
  goal?: string;
  engines?: string[];
  docSource?: string;
  taskSource?: string;
  fileTypes?: string[];
  expectedResult?: string;
  sample?: string;
  repoPath?: string;
  /** Workflow phases the user wants this init to cover. Each phase
   *  becomes a work unit in Tier 2 of the planner. Empty array (or
   *  undefined) is valid — the planner still emits the Tier 1 adapter
   *  units so a project with no explicit phases still gets the full
   *  baseline. */
  workflowPhases?: WorkflowPhase[];
  /** Code-navigation tools the user wants enabled. When absent, the
   *  planner leaves `SETTINGS.json` untouched (user opt-in only). */
  toolToggles?: { codegraph?: boolean; lsp?: boolean };
  /** When true, the planner generates the agent-team agent files
   *  (`.claude/agents/<role>.md` × N roles) alongside the rest. Default
   *  true — matches the legacy `agentFiles()` behaviour. */
  generateAgentTeam?: boolean;
  /** CLI-side ctx7 auth status collected before Phase 2. false means the
   *  user declined/failed login or init is non-interactive, so specs must
   *  use the documented fallback path without prompting again. */
  ctx7Authenticated?: boolean;
  /** P1-10: pre-resolved ctx7 repo list hint (formerly populated by
   *  discovery/ctx7-resolve.ts, removed — 0 production callers). */
  ctx7ResolvedReposHint?: string;
}

/** A single user-declared workflow phase. Mirrors the structure the
 *  web intake wizard already exposes in `src/ui/shell.html` (workflow
 *  steps with name, description, definition of done). */
export interface WorkflowPhase {
  /** Stable phase name; the planner uses it as the work-unit name
   *  (`ai-init-phase-<slug>-<n>`). MUST be unique within `workflowPhases`. */
  name: string;
  /** Free-text description the engine sees as the unit spec. */
  description: string;
  /** Inputs this phase consumes (file paths, env, or upstream phase names). */
  inputs?: string[];
  /** Outputs this phase produces (file paths, commands, or downstream
   *  phase names). The reviewer gates on evidence citing at least one. */
  outputs?: string[];
  /** Template the engine should follow (file path or inline body). */
  template?: string;
  /** Definition of done — reviewer reads this to set the acceptance
   *  signal for the phase's work unit. */
  dod?: string;
  /** Hint the planner uses to assign `owner_agent`. Matches a role name
   *  (see `agents/role-templates.ts`) or a substring the planner can
   *  fuzzy-route against detected roles. */
  ownerHint?: string;
}

/** A work unit tailored for the AI init phase. Same fields as
 * {@link WorkUnit} plus an acceptance signal the reviewer uses. The
 * planner sets `owner_agent` to a default role so the orchestrator can
 * route it to the matching engine-agnostic agent, and `spec` to the
 * human-readable description (what the engine receives). */
export interface AiInitUnit extends WorkUnit {
  /** Disjoint file scope — used by the orchestrator to detect conflicts and
   *  serialize overlapping units. The default units below have disjoint
   *  scopes so they all run in parallel under `scheduleWaves`. */
  scope: string[];
  /** Acceptance signal the reviewer checks (e.g. "all 4 instruction files
   *  carry a fresh `vibeflow:start` block"). */
  acceptance: string;
  /** Names of work units this unit depends on. The orchestrator uses
   *  `depends_on` to schedule units into parallel waves: units in the
   *  same wave (no transitive dependencies) run concurrently; waves run
   *  sequentially. Empty array means this unit has no dependencies and
   *  belongs to wave 0. */
  depends_on: string[];
}

/** Stable IDs for the Tier 1 (adapter) init units. The orchestrator
 *  depends on stable names (no UUIDs) so the same workflow reproduces
 *  identical work units on a re-run. Tier 2 phase units are emitted
 *  with names `ai-init-phase-<slug>-<n>` (one per `WorkflowPhase` in
 *  intake). */
export const AI_INIT_ADAPTER_NAMES = [
  "ai-init-analyzer",
  "ai-init-instruction-writer",
  "ai-init-skill-curator",
  "ai-init-context-updater",
  "ai-init-workflow-state-writer",
] as const;
export type AiInitAdapterName = (typeof AI_INIT_ADAPTER_NAMES)[number];

/**
 * P0-4: The single "finisher" adapter unit produces the
 * WORKFLOW_STATE.json file. When quota is low it is skipped to
 * preserve the core skill-curator + analyzer + instruction-writer +
 * context-updater path. Phase-skill enrichment is NEVER in this set — those are the reusable templates that
 * downstream workflows depend on, and skipping them would defeat
 * the whole point of `vf init`. */
export const AI_INIT_FINISHER_NAMES: ReadonlySet<AiInitAdapterName> = new Set([
  "ai-init-workflow-state-writer",
] as const);

/** Back-compat export: a flat list of the original 4 unit names. New
 *  code should reference `AI_INIT_ADAPTER_NAMES` (5 entries). Kept so
 *  external callers and the existing test suite still resolve. */
export const AI_INIT_UNIT_NAMES = [
  "ai-init-analyzer",
  "ai-init-instruction-writer",
  "ai-init-skill-curator",
  "ai-init-context-updater",
] as const;
export type AiInitUnitName = (typeof AI_INIT_UNIT_NAMES)[number];

/** Map each Tier-1 adapter unit to its default role (owner_agent). The
 *  reviewer passes when the unit's evidence cites the expected role's
 *  runtime state). Each adapter owns a distinct on-disk artifact so two
 *  units never try to write the same path. */
export const ADAPTER_OWNER: Record<AiInitAdapterName, RoleName> = {
  "ai-init-analyzer": "cli-engine",
  "ai-init-instruction-writer": "doc-writer",
  "ai-init-skill-curator": "skill-author",
  "ai-init-context-updater": "doc-writer",
  "ai-init-workflow-state-writer": "dispatch-runner",
};

/** Per-adapter file scope. Disjoint by design so the orchestrator's
 *  `findScopeConflicts` reports zero conflicts and all units run in
 *  parallel under `runParallel`. Each adapter owns a distinct on-disk
 *  artifact so two units never try to write the same path. */
export const ADAPTER_SCOPE: Record<AiInitAdapterName, string[]> = {
  "ai-init-analyzer": [".vibeflow/ai-context/stack-evidence.md"],
  "ai-init-instruction-writer": ["AGENTS.md", ".github/copilot-instructions.md"],
  "ai-init-skill-curator": [".vibeflow/skills/", ".vibeflow/SKILL_INDEX.md"],
  "ai-init-context-updater": [".vibeflow/PROJECT_CONTEXT.md"],
  "ai-init-workflow-state-writer": [".vibeflow/WORKFLOW_STATE.json"],
};

/** Per-adapter dependency map for wave scheduling.
 *
 *  Wave 0 (no deps): analyzer, instruction-writer
 *  Wave 1 (waits for analyzer): skill-curator, context-updater
 *    — skill-curator needs stack-evidence.md to match whitelist
 *    — context-updater needs stack-evidence.md + project-profile.json
 *  Wave 2 (waits for wave 1): state-writer
 *    — state-writer needs skill curator’s work for the work_units block
 */
export const ADAPTER_DEPENDS_ON: Record<AiInitAdapterName, string[]> = {
  "ai-init-analyzer": [],
  "ai-init-instruction-writer": [],
  "ai-init-skill-curator": ["ai-init-analyzer"],
  "ai-init-context-updater": ["ai-init-analyzer"],
  "ai-init-workflow-state-writer": ["ai-init-analyzer", "ai-init-skill-curator"],
};

export const ENGINE_INSTRUCTION_SCOPE: Record<Engine, string[]> = {
  claude: ["CLAUDE.md"],
  codex: ["AGENTS.md"],
  copilot: ["AGENTS.md", ".github/copilot-instructions.md"],
};

export const ENGINE_SKILL_DIR: Record<Engine, string> = {
  claude: ".claude/skills/",
  codex: ".agents/skills/",
  copilot: ".github/skills/",
};

export const INIT_DEFAULT_ENGINE: Engine = "copilot";
