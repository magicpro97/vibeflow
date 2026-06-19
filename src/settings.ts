import { existsSync, readFileSync } from "node:fs";
import { ctxPathIn, cwd, writeFileSafe } from "./core.js";

/** Tool tiers, in the canonical preference family used by the priority ladder. */
export type ToolTier = "codegraph" | "lsp" | "native";

/** All valid tiers, in the canonical default order (highest preference first). */
const TIERS: ToolTier[] = ["codegraph", "lsp", "native"];

/**
 * Source-protection policy for real (cli) dispatch. All conservative by default so an
 * upgrade never silently changes behavior: a bounded timeout, no auto-WIP, no rollback,
 * and git is recommended but not required.
 */
export interface FailureProtection {
  /** Per-unit dispatch timeout in seconds; 0 disables the timeout. */
  timeoutSeconds: number;
  /** Snapshot a dirty tree with a throwaway WIP commit before dispatching. */
  autoWip: boolean;
  /** Hard-reset to the pre-dispatch state when a unit fails. */
  rollbackOnFail: boolean;
  /** Refuse a real dispatch outside a git repo (engine edits would be irreversible). */
  requireGit: boolean;
}

/** Per-repo user settings persisted to `.vibeflow/SETTINGS.json`. */
export interface VibeSettings {
  tools: { codegraph: boolean; lsp: boolean };
  toolPriority: ToolTier[];
  lspServers?: string[];
  failureProtection: FailureProtection;
  /**
   * When true (default), VibeFlow's memory feature is active: `vf init` records
   * the claude-mem opt-in here, and a future orchestrate-side query reads it.
   * Toggled via `vf config memory on|off`. Does not gate the `vf init` prompt.
   */
  memory: boolean;
  /** ISO timestamp stamped by the writer. */
  updatedAt: string;
}

/** Default dispatch timeout (seconds) — long enough for a real engine run, short enough to unstick. */
export const DEFAULT_TIMEOUT_SECONDS = 3600;

/** Conservative source-protection defaults (off where it could surprise an upgrading user). */
export const DEFAULT_FAILURE_PROTECTION: FailureProtection = {
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  autoWip: false,
  rollbackOnFail: false,
  requireGit: false,
};

/** Off-by-default baseline. `readSettings` always returns a fresh copy, never this object. */
export const DEFAULT_SETTINGS: VibeSettings = {
  tools: { codegraph: false, lsp: false },
  toolPriority: [...TIERS],
  failureProtection: { ...DEFAULT_FAILURE_PROTECTION },
  memory: true,
  updatedAt: "",
};

function isTier(v: unknown): v is ToolTier {
  return v === "codegraph" || v === "lsp" || v === "native";
}

/** Deep copy of the defaults so callers can mutate the result freely. */
function defaults(): VibeSettings {
  return {
    tools: { ...DEFAULT_SETTINGS.tools },
    toolPriority: [...DEFAULT_SETTINGS.toolPriority],
    failureProtection: { ...DEFAULT_FAILURE_PROTECTION },
    memory: DEFAULT_SETTINGS.memory,
    updatedAt: DEFAULT_SETTINGS.updatedAt,
  };
}

/** Path to the settings file inside a given repo's canonical context dir. */
export function settingsPath(base?: string): string {
  return ctxPathIn(base ?? cwd(), "SETTINGS.json");
}

/** Validate + dedupe a stored priority list; fall back to defaults when unusable. */
function normalizePriority(raw: unknown): ToolTier[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...TIERS];
  // Any unknown tier makes the whole list untrustworthy → default order.
  if (!raw.every(isTier)) return [...TIERS];
  const seen = new Set<ToolTier>(raw);
  // Keep declared order, then append any tiers the file omitted (forward-compatible).
  const ordered = [...seen];
  for (const tier of TIERS) {
    if (!seen.has(tier)) ordered.push(tier);
  }
  return ordered;
}

/** Merge a partial/old/unknown failureProtection block over the conservative defaults. */
function coerceFailureProtection(raw: unknown): FailureProtection {
  const out = { ...DEFAULT_FAILURE_PROTECTION };
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.timeoutSeconds === "number" && Number.isFinite(obj.timeoutSeconds)) {
    out.timeoutSeconds = Math.max(0, obj.timeoutSeconds);
  }
  if (typeof obj.autoWip === "boolean") out.autoWip = obj.autoWip;
  if (typeof obj.rollbackOnFail === "boolean") out.rollbackOnFail = obj.rollbackOnFail;
  if (typeof obj.requireGit === "boolean") out.requireGit = obj.requireGit;
  return out;
}

/** Merge a partial/old/unknown stored object over the defaults into a complete VibeSettings. */
function coerce(raw: unknown): VibeSettings {
  const out = defaults();
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;

  const tools = obj.tools;
  if (tools && typeof tools === "object") {
    const t = tools as Record<string, unknown>;
    if (typeof t.codegraph === "boolean") out.tools.codegraph = t.codegraph;
    if (typeof t.lsp === "boolean") out.tools.lsp = t.lsp;
  }

  out.toolPriority = normalizePriority(obj.toolPriority);
  out.failureProtection = coerceFailureProtection(obj.failureProtection);

  if (typeof obj.memory === "boolean") out.memory = obj.memory;

  if (Array.isArray(obj.lspServers)) {
    const servers = obj.lspServers.filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (servers.length) out.lspServers = servers;
  }

  if (typeof obj.updatedAt === "string") out.updatedAt = obj.updatedAt;
  return out;
}

/** Read settings for a repo; missing/corrupt files yield a fresh copy of the defaults. */
export function readSettings(base?: string): VibeSettings {
  const p = settingsPath(base);
  if (!existsSync(p)) return defaults();
  try {
    return coerce(JSON.parse(readFileSync(p, "utf8")) as unknown);
  } catch {
    return defaults();
  }
}

/** Read-modify-write: merge `next` over current settings, stamp `updatedAt`, persist, return it. */
export function writeSettings(
  base: string,
  next: Partial<VibeSettings>,
  opts?: { now?: () => string },
): VibeSettings {
  const now = opts?.now ?? (() => new Date().toISOString());
  const current = readSettings(base);
  const merged: VibeSettings = {
    tools: { ...current.tools, ...(next.tools ?? {}) },
    toolPriority: next.toolPriority ? normalizePriority(next.toolPriority) : current.toolPriority,
    failureProtection: { ...current.failureProtection, ...(next.failureProtection ?? {}) },
    memory: next.memory ?? current.memory,
    updatedAt: now(),
  };
  const servers = next.lspServers ?? current.lspServers;
  if (servers?.length) merged.lspServers = [...servers];
  writeFileSafe(settingsPath(base), JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * Turn the ordered `toolPriority` list into a rank map where higher = preferred, mirroring
 * STATUS_RANK in skills/registry.ts. The first element gets the highest rank.
 */
export function priorityRank(settings: VibeSettings): Record<ToolTier, number> {
  const order = normalizePriority(settings.toolPriority);
  const rank = {} as Record<ToolTier, number>;
  const top = order.length;
  for (let i = 0; i < order.length; i++) {
    rank[order[i] as ToolTier] = top - i;
  }
  return rank;
}
