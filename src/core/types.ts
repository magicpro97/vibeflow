export type Engine = "claude" | "codex" | "copilot" | "opencode" | "antigravity";
/**
/**
 * Canonical engine priority. Single source of truth for "which engine
 * wins when more than one is ready?" — also used as the default-arg
 * iteration order everywhere we render agent files / skill roots.
 *
 * The user-facing doc says: `claude > copilot > codex`. If you change
 * this list, you MUST also update docs/USER_GUIDE.md AND the
 * cross-file invariant test in test/engine-priority.test.ts.
 */
export const ENGINES: Engine[] = ["claude", "copilot", "codex", "opencode", "antigravity"];

export type GateState = "pass" | "fail" | "running" | "pending";

/** #522: one structured acceptance criterion. `verification`/`priority` optional so prose-only
 *  criteria still parse and adding this field never retroactively hardens a green gate. */
export interface AcceptanceCriterion {
  id: string;
  criterion: string;
  /**
   * Command the reviewer EXECUTES to verify this criterion. Absent ⇒ prose-only,
   * skipped. #533: the default runner (`defaultRun`, scoped-gate.ts) splits on
   * spaces and `spawnSync(bin, args)` with NO shell — so shell metacharacters
   * (pipes, quotes, redirects, `$()`, globs) are NOT interpreted (`grep foo | wc`
   * runs `grep` with literal args `["foo","|","wc"]`). A URL is fine as a plain
   * arg (`curl https://…`); it just can't be used as shell. Provide a single
   * binary + args, or a test filter; wrap shell logic in a script and invoke that.
   * TRUST BOUNDARY: the reviewer runs this string unsandboxed with no prompt
   * (unlike the security checkpoint). Safe for user-authored plans; treat as
   * arbitrary code execution if criteria can originate from untrusted LLM output.
   */
  verification?: string;
  /** Absent ⇒ treated as SHOULD (warn-only) so adding this field never hardens a green gate. */
  priority?: "MUST" | "SHOULD" | "NICE";
}

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
    /** ADR-003: behavioral goal-eval result. */
    goal_eval?: GateState;
  };
  /** #545: calibrated judge score 0..1 (P(goal met)) from the reviewer-LLM.
   *  Graded signal in computeConfidence; absent ⇒ omitted (fail-open). */
  goal_score?: number;
  resources: { agents: number; tokens: number; cost_usd: number; wall_seconds: number };
  evidence?: string[];
  /** #612: names of units this unit depends on (carried from the planner's UnitProposal). */
  depends_on?: string[];
  /** #612: summaries handed off from completed upstream units. Read-only — filled by the
   *  wave dispatcher before this unit is dispatched. */
  upstreamHandoffs?: Array<{ unit: string; summary: string }>;
  /** #522: structured acceptance. Reviewer runs each `verification`; a failing MUST is a
   *  review FAILURE. Optional — prose spec/acceptance still valid. */
  acceptance_criteria?: AcceptanceCriterion[];
  /**
   * #517: capture time (ISO-8601 UTC) of each evidence string, keyed by the
   * evidence STRING so it survives the Set-dedup in applyOutcome. Stamp-once:
   * a re-dispatch never rewrites an existing key. ABSENT ⇒ freshness gate
   * fails open (no warning) — adding this field never hardens a green gate.
   */
  evidence_at?: Record<string, string>;
  /**
   * ADR-005: the human-authored canary test linked to this unit. Knowledge-heavy
   * units cannot close without one (gate FAILURE). `author` (git-blame) must
   * differ from the dispatch engine identity — a canary the agent wrote itself
   * is not a canary. Set by `vf canary link`.
   */
  canary?: { file: string; author: string; linkedAt: string };
  /**
   * Type B drift (ADR spec-freshness): SHA256 of each scoped file captured at the
   * last GREEN verify, plus the git SHA then. A later verify recomputes them — a
   * changed scoped file with no re-dispatch is an out-of-pipeline edit (provenance).
   * #532: a `null` value is the absent-at-snapshot sentinel (create detection).
   */
  impl_fingerprint?: Record<string, string | null>;
  verified_sha?: string;
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
  /** ADR-004: transient flag — skip unverifiable-evidence failure check (escape hatch). Never persisted. */
  _allowUnverifiedEvidence?: boolean;
}

// --- Skills (Anthropic skill-creator standard: SKILL.md folder) ---
export type SkillScope = "common" | "organization" | "project" | "adapter";

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
  /** #655: scope classifies how reusable this skill is. */
  scope?: SkillScope;
  /** #655: for project-scoped skills, the repo/project identifier. */
  projectId?: string;
  /** #655: names of skills this skill extends/inherits from. */
  extends?: string[];
  capabilities?: string[];
  triggers?: string[];
  /** #543: repo = always-on project law (injected every dispatch); knowledge (default) = keyword-gated. */
  type?: "repo" | "knowledge";
  requires?: SkillRequires;
  /** #552: an MCP server this skill provisions when present (executable skill bundle). */
  mcp?: {
    name?: string;
    transport?: "stdio" | "http" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
  };
  /** Absolute path to the skill folder. */
  dir: string;
  /** Absolute path to the skill's SKILL.md. */
  path: string;
  /**
   * #656: resolved merged body when this skill extends a base skill.
   * Set by adapter resolution after discoverSkills. Undefined for
   * skills without extends, or when the base is missing/unresolvable.
   */
  resolvedBody?: string;
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
  /** #624: Claude sets stop_hook_active=true when a Stop hook already blocked once.
   *  The Stop-gate reads this to DOWNGRADE from a hard block to advice, avoiding an
   *  infinite loop (respects CLAUDE_CODE_STOP_HOOK_BLOCK_CAP). */
  stopHookActive?: boolean;
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
