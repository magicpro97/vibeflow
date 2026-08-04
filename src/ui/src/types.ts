// Copied from src/core/types.ts and src/logbus/types.ts — keep in sync manually.
// Only what the UI needs; no Node/Bun imports.

export type Engine = "claude" | "codex" | "copilot" | "opencode" | "antigravity";
export type GateState = "pass" | "fail" | "running" | "pending";

export interface WorkUnit {
  name: string;
  status: "pending" | "running" | "verifying" | "done" | "blocked";
  /** Agent's self-reported confidence 0.0–1.0. 0 = not yet reported (new unit). */
  confidence: number;
  riskClass?: "docs" | "simple-code" | "feature" | "architecture" | "security" | "deploy";
  owner_agent?: string;
  skills_used?: string[];
  scope?: string[];
  spec?: string;
  gates: Record<"build" | "lint" | "test" | "review", GateState> & {
    security?: GateState;
    goal_eval?: GateState; // ADR-003
  };
  goal_score?: number; // #545: calibrated judge score 0..1
  resources: { agents: number; tokens: number; cost_usd: number; wall_seconds: number };
  evidence?: string[];
  /** Knowledge-heavy units require a human-authored canary test to close (ADR-005). */
  knowledge_heavy?: boolean;
  /** Linked canary test: file + human author + when linked. Absent = not yet covered. */
  canary?: { file: string; author: string; linkedAt: string };
  depends_on?: string[];
  upstreamHandoffs?: Array<{ unit: string; summary: string }>;
  acceptance_criteria?: Array<{
    id: string;
    criterion: string;
    verification?: string;
    required?: boolean;
  }>;
}

export interface Attachment {
  name: string;
  size: number;
  type: string;
  skill: string;
}

/** #557: one recorded status transition — mirrors src/orchestrator/timeline.ts. */
export interface TimelineEntry {
  status: string;
  at: number;
  confidence?: number;
  evidenceCount?: number;
}

export interface WorkflowState {
  task_id: string;
  goal: string;
  success_criteria: string[];
  work_units: WorkUnit[];
  totals: { units: number; done: number; tokens: number; cost_usd: number; wall_seconds: number };
  /** @deprecated No longer written by server. Kept optional so older state files still parse. */
  repo_path?: string;
  attachments?: Attachment[];
  vibeflow_version?: string;
}

export type Channel = "vf" | "engine-stdout" | "engine-stderr" | "user" | "hook";
export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEvent {
  seq: number;
  ts: number;
  runId: string;
  workflowId?: string;
  repoPath?: string;
  unit?: string;
  channel: Channel;
  level: LogLevel;
  text: string;
  meta?: Record<string, unknown>;
}

export type WorkflowDashboardStatus = "running" | "blocked" | "pending" | "done";

export interface WorkflowDashboardItem {
  key: string;
  repoPath: string;
  repoName: string;
  taskId: string;
  goal: string;
  updatedAt: number;
  workUnits: WorkUnit[];
  totals: { units: number; done: number; tokens: number; cost_usd: number; wall_seconds: number };
  status: WorkflowDashboardStatus;
  waves: string[][];
  latestEvent?: LogEvent;
}

export interface DashboardSelection {
  repoPath: string;
  workflowId: string;
  unit?: string;
}

export type ToolTier = "codegraph" | "lsp" | "native";

export interface ProjectEntry {
  path: string;
  name: string;
  lastUsed: number;
  goal: string;
  totals: { units: number; done: number; tokens: number; cost_usd: number };
}

export type HookTemplateId =
  | "block-destructive"
  | "flag-installs"
  | "protect-secrets"
  | "protect-config"
  | "workspace-guard";

export interface HookConfig {
  templates: HookTemplateId[];
  custom: { match: string; risk: string; reason?: string }[];
}

export interface FailureProtection {
  timeoutSeconds: number;
  autoWip: boolean;
  rollbackOnFail: boolean;
  requireGit: boolean;
}

export type CuratorSeverity = "low" | "medium" | "high";

export type FindingType = "stale-anchor" | "duplicate-owner" | "unpinned-registry";

export interface CuratorSettings {
  enabled: boolean;
  observeMode: boolean;
  schedule: string;
  severityThreshold: CuratorSeverity;
}

export interface CuratorFindingView {
  id: string;
  type: FindingType;
  severity: CuratorSeverity;
  summary: string;
}

/** Fixed counts object — all three keys always present, initialized 0. */
export interface CuratorCounts {
  "stale-anchor": number;
  "duplicate-owner": number;
  "unpinned-registry": number;
}

export interface CuratorView {
  findings: CuratorFindingView[];
  counts: CuratorCounts;
  total: number;
}

export interface VibeSettings {
  tools: { codegraph: boolean; lsp: boolean };
  toolPriority: ToolTier[];
  lspServers?: string[];
  failureProtection: FailureProtection;
  memory: boolean;
  notifications?: boolean;
  hooks?: HookConfig;
  /** #556: env-scrub policy for spawned engine subprocesses (read-only in the UI). */
  envPolicy?: { deny?: string[]; allow?: string[] };
  /** #689: curator scheduling + severity prefs. */
  curator?: CuratorSettings;
  updatedAt?: string;
}

export interface HookLogPayload {
  decision: "warn" | "require_approval" | "block";
  risk: "none" | "low" | "medium" | "high" | "critical";
  reasons: string[];
  tool?: string;
  command?: string;
  files?: string[];
  event?: string;
}

// ── Diff preview types (#641) ──────────────────────────────────────────────
export interface DiffFileEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unmerged" | "type-changed";
  added: number;
  deleted: number;
  isBinary: boolean;
}

export interface WorkflowDiffSummary {
  baseline: string | null;
  baselineLabel: string;
  files: DiffFileEntry[];
  totalAdded: number;
  totalDeleted: number;
  untracked: string[];
  truncated: boolean;
}

export interface WorkUnitDiffResult {
  unit: string;
  hasDiff: boolean;
  reason?: string;
  files: DiffFileEntry[];
  diff: string;
  truncated: boolean;
}

export interface DiffResponse {
  summary: WorkflowDiffSummary;
  unitDiff?: WorkUnitDiffResult;
}

// ── Plan Review types ──
export interface PlanBlockRaw {
  id: string;
  type: string;
  content: string;
  lines?: { startLine: number; endLine: number };
}

export interface PlanRevision {
  id: string;
  workflowId: string;
  parentId?: string;
  markdown: string;
  blocks: PlanBlockRaw[];
  createdBy: { type: "user" | "agent"; id: string; name: string };
  createdAt: string;
  status: string;
}

// ── Plan Review Comment types ──
export interface PlanCommentAnchor {
  blockId: string;
  quote: string;
  range?: { startOffset: number; endOffset: number };
}

export type PlanCommentStatus = "draft" | "open";

export interface PlanComment {
  id: string;
  revisionId: string;
  parentId?: string;
  anchor?: PlanCommentAnchor;
  body: string;
  status: PlanCommentStatus;
  depth: number;
  createdAt: string;
  createdBy: { type: "user" | "agent"; id: string; name: string };
  updatedAt: string;
}

// ── #633: Skills catalog types ─────────────────────────────────────────────
export type SkillStatus =
  | "verified"
  | "enriched"
  | "experimental"
  | "baseline"
  | "template"
  | "draft"
  | "unverified"
  | "deprecated";

export type ScanStatus = "not-scanned" | "pass" | "warn" | "blocked";

export interface SafeSkill {
  name: string;
  description: string;
  version?: string;
  status: SkillStatus;
  origin: "project-local" | "shared";
  securityScan: ScanStatus;
  registry?: { id: string; version: string; pinned: boolean };
  scope?: "common" | "project" | "adapter" | "organization";
  domain?: { id?: string; role?: "canonical" | "child" };
  owners?: string[];
  stale?: boolean;
  staleReason?: string;
}

// ── #688: Registry view types ────────────────────────────────────────────
export interface RegistryViewEntry {
  id: string;
  url: string;
  ref: string;
  commitOID: string;
  entryCount: number;
  installedCount: number;
  valid: boolean;
}

export interface RegistryPreview {
  ok: true;
  executable: false;
  registry: string;
  plan: string;
}

// ── #691: Domain & Facts view types ────────────────────────────────────
export interface DomainFactView {
  key: string;
  owner: string;
  version: string;
  statement: string;
  paths: string[];
}

export interface DomainRootView {
  id: string;
  canonical: string;
  facts: DomainFactView[];
  children: string[];
}

export interface DomainsView {
  ok: true;
  roots: DomainRootView[];
}

export interface DomainImpact {
  ok: boolean;
  query: string;
  facts: string[];
  skills: string[];
  error?: string;
}
