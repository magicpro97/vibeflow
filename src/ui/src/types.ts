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
  unit?: string;
  channel: Channel;
  level: LogLevel;
  text: string;
  meta?: Record<string, unknown>;
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
