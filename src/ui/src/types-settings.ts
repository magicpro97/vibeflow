// UI-only projections copied from backend contracts; keep Node/Bun imports out.
// The settings subtree lives here (lifted out of types.ts, which was at the
// 400-line cap) so `typesafe?:` had somewhere to go without a waiver.
//
// TYPE-ONLY imports, deliberately: the vite browser bundle must never pull
// `src/typesafe-settings.ts`'s node:fs / bun:ffi runtime in, and the call-site
// vocabulary must never be re-declared UI-side.

import type { Engine } from "../../core/agent-contract.js";
import type { SKILL_MCP_TRANSPORT } from "../../core/skill-contract.js";
import type { TypesafeCallSites, TypesafeReviewerEnginePolicy } from "../../typesafe-contract.js";
import type { ProjectClassificationPatch } from "./project-settings-form.js";

export type ToolTier = "codegraph" | "lsp" | "native";

export interface FailureProtection {
  timeoutSeconds: number;
  autoWip: boolean;
  rollbackOnFail: boolean;
  requireGit: boolean;
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

export type CuratorSeverity = "low" | "medium" | "high";

export interface CuratorSettings {
  enabled: boolean;
  observeMode: boolean;
  schedule: string;
  severityThreshold: CuratorSeverity;
}

/** Shape of the System One block as the browser sees it (no values, only types —
 *  every number is owned by `coerceTypesafeSettings` on the server). */
export interface TypesafeSettings {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  retryBackoffMs: number;
  runAtConfidence: number;
  acceptAtConfidence: number;
  judgeScoreLevels: number;
  judgePassLevel: number;
  judgeTestFloor: number;
  reviewerEngine: TypesafeReviewerEnginePolicy;
  failStreakLimit: number;
  cooldownBaseMs: number;
  cooldownCapMs: number;
  hookTimeoutMs: number;
  hookBusLockRetries: number;
  maxCalls: number;
  callSites: TypesafeCallSites;
}

/** The subset the control center actually edits. A `Pick` of the mirror, so a
 *  renamed server field breaks the build here instead of drifting silently. */
export type TypesafeFormSettings = Pick<
  TypesafeSettings,
  "enabled" | "runAtConfidence" | "acceptAtConfidence" | "callSites"
>;

/**
 * Inert form state until `GET /api/typesafe` answers. Zeros, NOT defaults — the
 * section is disabled while loading and the save round-trips the server's
 * effective block, so the browser never keeps a second copy of a numeric default.
 * The call-site record is a total `Record<TypesafeCallSiteName, boolean>`, so the
 * compiler rejects a missing or misspelled member.
 */
export function emptyTypesafeForm(): TypesafeFormSettings {
  return {
    enabled: false,
    runAtConfidence: 0,
    acceptAtConfidence: 0,
    callSites: { reviewer: false, risk: false, goalCoverage: false, planner: false },
  };
}

/** `GET /api/typesafe` — redacted by construction: `keySource`, never the key. */
export interface TypesafeSettingsView {
  state: string;
  cooldownUntil?: string;
  lastClass?: string;
  calls?: number;
  enabled: boolean;
  configured: boolean;
  keySource: "env" | "file" | "none";
  model: string;
  timeoutMs: number;
  thresholds: { run: number; accept: number };
  callSites: TypesafeCallSites;
  lastCall?: { at: string; caller: string; status?: number; ms: number };
  /** The effective, coerced block. Round-trip THIS on save: the write path
   *  re-coerces a partial block onto the DEFAULTS, so echoing only the edited
   *  fields would silently reset model, timeoutMs and the breaker tuning. */
  settings: TypesafeSettings;
}

/** `POST /api/typesafe/test` — the probe runs server-side, so the browser holds no key. */
export interface TypesafeTestResult {
  ok: boolean;
  status?: number;
  model?: string;
  ms?: number;
  score?: number;
  confidence?: number;
  error?: string;
}

export type UserMcpServerView = {
  transport?: (typeof SKILL_MCP_TRANSPORT)[keyof typeof SKILL_MCP_TRANSPORT];
  command?: string;
  url?: string;
};

export interface VibeSettings {
  enabledEngines?: Engine[];
  tools: { codegraph: boolean; lsp: boolean };
  toolPriority: ToolTier[];
  lspServers?: string[];
  failureProtection: FailureProtection;
  memory: boolean;
  notifications?: boolean;
  hooks?: HookConfig;
  envPolicy?: { deny?: string[]; allow?: string[] };
  /** #548: user-declared MCP servers surfaced in the control center. */
  mcpServers?: Record<string, UserMcpServerView>;
  curator?: CuratorSettings;
  /** System One (Jev) decision judge — optional, off by default. */
  typesafe?: TypesafeFormSettings;
  projectClassification?: ProjectClassificationPatch["projectClassification"];
  updatedAt?: string;
}
