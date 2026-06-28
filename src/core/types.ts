export type Engine = "claude" | "codex" | "copilot";

/**
 * Canonical engine priority. Single source of truth for "which engine
 * wins when more than one is ready?" — also used as the default-arg
 * iteration order everywhere we render agent files / skill roots.
 *
 * The user-facing doc says: `claude > copilot > codex`. If you change
 * this list, you MUST also update docs/USER_GUIDE.md AND the
 * cross-file invariant test in test/engine-priority.test.ts.
 */
export const ENGINES: Engine[] = ["claude", "copilot", "codex"];

export type GateState = "pass" | "fail" | "running" | "pending";

export interface WorkUnit {
  name: string;
  status: "pending" | "running" | "verifying" | "done" | "blocked";
  confidence: number;
  /**
   * Per-unit risk class — drives the confidence threshold required for `goalEval` to mark the
   * unit as "met" (issue #90). Maps to a threshold via `thresholdFor()` in
   * `src/orchestrator/investigate.ts` (docs=0.70 → deploy/security=0.95). Optional; units
   * without a value default to `"feature"` (threshold 0.85).
   */
  riskClass?: "docs" | "simple-code" | "feature" | "architecture" | "security" | "deploy";
  owner_agent?: string;
  skills_used?: string[];
  knowledge_heavy?: boolean;
  knowledge_heavy_source?: "risk" | "regex";
  skills_injected?: string[];
  skills_required?: string[];
  skill_waiver?: { reason: string; at: string; by?: string };
  scope?: string[];
  /** Free-text build spec injected into the dispatch prompt so the engine knows WHAT to build. */
  spec?: string;
  gates: Record<"build" | "lint" | "test" | "review", GateState> & {
    /** Populated by the orchestrator's post-coding security checkpoint. */
    security?: GateState;
  };
  resources: { agents: number; tokens: number; cost_usd: number; wall_seconds: number };
  evidence?: string[];
  /**
   * Security checkpoint result, populated when the orchestrator runs
   * the post-coding security skill on this unit. Structural type to
   * avoid a circular import from core → orchestrator/security-checkpoint.
   */
  security?: {
    consent: "run" | "skip" | "abstain";
    verdict: "pass" | "fail" | "needs-review" | "skipped" | "error";
    items_checked?: number;
    items_failed?: number[];
    notes?: string;
  };
}

export interface Attachment {
  name: string;
  size: number;
  type: string;
  skill: string;
}

export interface WorkflowState {
  task_id: string;
  goal: string;
  success_criteria: string[];
  work_units: WorkUnit[];
  totals: { units: number; done: number; tokens: number; cost_usd: number; wall_seconds: number };
  /** @deprecated No longer written (the absolute path was per-machine and had
   *  zero readers; dropping it keeps WORKFLOW_STATE.json portable). Kept
   *  optional so older state files still parse. */
  repo_path?: string;
  attachments?: Attachment[];
  /** The VibeFlow version that last initialized (or updated) this workflow. Absent on pre-#323 workflows. */
  vibeflow_version?: string;
}

// --- Skills (Anthropic skill-creator standard: SKILL.md folder) ---
export type SkillStatus =
  | "verified"
  | "enriched"
  | "experimental"
  | "baseline"
  | "template"
  | "draft"
  | "unverified"
  | "deprecated";

export interface SkillRequires {
  filesystem?: "read" | "write" | "none";
  network?: boolean;
  shell?: boolean;
}

export interface Skill {
  name: string;
  description: string;
  version?: string;
  status: SkillStatus;
  capabilities?: string[];
  triggers?: string[];
  requires?: SkillRequires;
  /** Absolute path to the skill folder. */
  dir: string;
  /** Absolute path to the skill's SKILL.md. */
  path: string;
}

export interface SkillMatch {
  skill: Skill;
  reason: string;
  score: number;
}

// --- Hooks: universal protocol shared by every engine adapter ---
export type HookEvent =
  | "pre-tool-use"
  | "post-tool-use"
  | "pre-write"
  | "post-write"
  | "pre-command"
  | "post-command"
  | "stop"
  | "skill-compliance"
  | "verify-result";

export type HookDecision = "allow" | "warn" | "require_approval" | "block";
export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

export interface HookInput {
  event: HookEvent;
  tool?: string;
  workspace?: string;
  command?: string;
  files?: string[];
  agent?: string;
  taskId?: string;
  /** Declared scope of the active work unit (glob-ish prefixes). */
  scope?: string[];
  /** Free-text intent of the action, used to keep risk scoring intent-aware. */
  intent?: string;
  /** Body text of a Write/Edit (new file content or replacement string).
   *  Populated by the native payload parsers so content-aware secret scanning
   *  can see secrets hard-coded into an otherwise-allowed file. */
  content?: string;
}

export interface HookResult {
  decision: HookDecision;
  risk: RiskLevel;
  reasons: string[];
}

// --- Orchestration: investigation + debate (confidence < 1 handling) ---
export interface InvestigationRound {
  round: number;
  question: string;
  findings: string[];
  confidence: number;
  /** Verifiable evidence (command output, file paths) — presence required for confidence raises. */
  artifacts?: string[];
}

export interface DebatePosition {
  agent: string;
  claim: string;
  evidence: string[];
}

export interface DebateResult {
  question: string;
  positions: DebatePosition[];
  resolution: string;
  confidence: number;
  rejected: string[];
}
