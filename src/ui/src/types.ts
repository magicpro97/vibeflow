// Copied from src/core/types.ts and src/logbus/types.ts — keep in sync manually.
// Only what the UI needs; no Node/Bun imports.

export type Engine = "claude" | "codex" | "copilot";
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
  };
  resources: { agents: number; tokens: number; cost_usd: number; wall_seconds: number };
  evidence?: string[];
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
  hooks?: HookConfig;
  updatedAt?: string;
}
