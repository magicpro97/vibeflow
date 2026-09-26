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

/**
 * Both thresholds are LOWER FLOORS. The judge's answer exists once confidence reaches
 * `runAtConfidence`, and may act once confidence reaches `acceptAtConfidence`. An accept floor
 * below the run floor therefore makes the accept gate unreachable: every answer that exists may
 * also act. That is the only ordering worth rejecting. The shipped default runs at 0.7 and
 * accepts at 0.85, which is the intended shape, so it must load clean.
 */
export function typesafeThresholdError(
  form: Pick<TypesafeFormSettings, "runAtConfidence" | "acceptAtConfidence">,
): string {
  return form.acceptAtConfidence < form.runAtConfidence
    ? "Accept confidence must not be below the run confidence."
    : "";
}

/**
 * The section's form is seeded from `GET /api/typesafe`. When that read has not succeeded the form
 * still holds `emptyTypesafeForm()` (all zeros), and posting that block makes the server refill it
 * from `DEFAULT_TYPESAFE_SETTINGS`, silently discarding whatever the user had configured. So the
 * save control may only act on a view that actually loaded.
 */
export function typesafeSaveDisabled(input: {
  saving: boolean;
  status: string;
  thresholdError: string;
  rowsAreStale: boolean;
}): boolean {
  return (
    input.saving || input.status !== "ready" || input.thresholdError !== "" || input.rowsAreStale
  );
}

/**
 * `POST /api/detect` calls `setActiveRepo` server-side and `POST /api/settings` writes to whichever
 * repo is active, while the rows on screen still describe the repo whose view was last loaded. An
 * empty `loadedRepo` means nothing has loaded yet, so the first successful load owns the rows.
 */
export function typesafeNeedsReload(loadedRepo: string, activeRepo: string): boolean {
  return loadedRepo !== "" && loadedRepo !== activeRepo;
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
  /**
   * The server reports the full coerced block here, not the four editable fields, and the save
   * path posts the whole block back (it spreads `typesafeView.settings` first). Typing it as the
   * four-field form under-described the payload.
   */
  typesafe?: TypesafeSettings;
  projectClassification?: ProjectClassificationPatch["projectClassification"];
  updatedAt?: string;
}
