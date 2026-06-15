import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Read the package version from the nearest package.json (walking up from this module),
 * so `vf --version` never drifts from the published version. Falls back to "0.0.0". */
// Test seam: exported so unit tests can exercise the try/catch fallback
// (line 19-20) by injecting a throwing fs or JSON.parse failure.
export function readVersion(
  inject: {
    existsSync?: (path: string) => boolean;
    readFileSync?: (path: string, enc: string) => string;
  } = {},
): string {
  const _exists = inject.existsSync ?? existsSync;
  const _read = inject.readFileSync ?? readFileSync;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const pkg = join(dir, "package.json");
      if (_exists(pkg)) {
        const v = (JSON.parse(_read(pkg, "utf8")) as { version?: string }).version;
        if (v) return v;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    /* fall through to default */
  }
  return "0.0.0";
}

export const VERSION = readVersion();

/** Canonical context directory (hidden dotdir). */
export const CTX_DIR = ".vibeflow";

export type Engine = "claude" | "codex" | "copilot";
export const ENGINES: Engine[] = ["claude", "codex", "copilot"];

export type GateState = "pass" | "fail" | "running" | "pending";

export interface WorkUnit {
  name: string;
  status: "pending" | "running" | "verifying" | "done" | "blocked";
  confidence: number;
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
  gates: Record<"build" | "lint" | "test" | "review", GateState>;
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
  repo_path?: string;
  attachments?: Attachment[];
}

// --- Skills (Anthropic skill-creator standard: SKILL.md folder) ---
export type SkillStatus = "verified" | "unverified" | "experimental" | "draft" | "deprecated";

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

export function cwd(): string {
  return process.cwd();
}

/** Base directory for a workflow. Defaults to the current working directory. */
export function ctxPath(...parts: string[]): string {
  return join(cwd(), CTX_DIR, ...parts);
}

/** Resolve a path inside a given base repo's canonical context dir. */
export function ctxPathIn(base: string, ...parts: string[]): string {
  return join(base, CTX_DIR, ...parts);
}

export function statePath(base: string = cwd()): string {
  return ctxPathIn(base, "WORKFLOW_STATE.json");
}

export function readState(base: string = cwd()): WorkflowState | null {
  const p = statePath(base);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as WorkflowState;
  } catch {
    return null;
  }
}

export function writeState(base: string, state: WorkflowState): void {
  writeFileSafe(statePath(base), JSON.stringify(state, null, 2));
}

/** Crash-safe write: temp file in the same directory, then atomic rename. A SIGKILL / power loss /
 * OOM between the open-truncate of a plain `writeFileSync` and the final write would leave the
 * target file EMPTY (0 bytes) or partial. POSIX guarantees `rename(2)` is atomic on the same
 * filesystem, so the target either has the previous content or the new content — never a mix.
 * Same-FS invariant: the `.tmp-<pid>-<ts>` suffix is constructed in the same directory as the
 * target (cross-FS rename degrades to copy+delete, which is NOT atomic).
 * Test seam: callers can inject a throwing `writeFileSync` to simulate a SIGKILL mid-write. */
export function writeFileSafe(
  path: string,
  content: string,
  inject: {
    mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
    writeFileSync?: (p: string, data: string) => void;
    renameSync?: (from: string, to: string) => void;
  } = {},
): void {
  const _mkdir = inject.mkdirSync ?? mkdirSync;
  const _write = inject.writeFileSync ?? writeFileSync;
  const _rename = inject.renameSync ?? renameSync;
  _mkdir(dirname(path), { recursive: true });
  const finalContent = content.endsWith("\n") ? content : `${content}\n`;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  _write(tmp, finalContent);
  _rename(tmp, path);
}

/** Coerce an untrusted value (parsed engine JSON / hand-edited ledger) to a string array;
 * anything that isn't an array of strings becomes []. Used to harden skill-field reads so
 * malformed shapes can't crash the skill gate / `vf verify`. */
export function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Append content to a file, creating the parent dir if absent. Unlike writeFileSafe this never
 * truncates and never mutates the input — callers control exact spacing (e.g. the work journal). */
export function appendFileSafe(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, content);
}

/** Path to the append-only work journal (knowledge/log.md) under the context dir. */
export function journalPath(base?: string): string {
  return base ? ctxPathIn(base, "knowledge", "log.md") : ctxPath("knowledge", "log.md");
}

/** Path to the knowledge catalog (knowledge/index.md) under the context dir. */
export function indexPath(base?: string): string {
  return base ? ctxPathIn(base, "knowledge", "index.md") : ctxPath("knowledge", "index.md");
}

export function recomputeTotals(s: WorkflowState): WorkflowState {
  s.totals = {
    units: s.work_units.length,
    done: s.work_units.filter((u) => u.status === "done").length,
    tokens: s.work_units.reduce((a, u) => a + u.resources.tokens, 0),
    cost_usd: Number(s.work_units.reduce((a, u) => a + u.resources.cost_usd, 0).toFixed(4)),
    wall_seconds: s.work_units.reduce((a, u) => a + u.resources.wall_seconds, 0),
  };
  return s;
}

function safeCommandName(cmd: string): boolean {
  // `command -v` is a POSIX shell builtin with no standalone binary (absent on most Linux),
  // so it must run through a shell — otherwise spawnSync hits ENOENT and reports every tool
  // as missing (CI false-negative). Guard the input (tool names only) so the shell string is safe.
  return /^[A-Za-z0-9._-]+$/.test(cmd);
}

/** Resolve the first executable path for a command, matching how the platform PATH is searched. */
export function resolveCommand(cmd: string): string | undefined {
  if (!safeCommandName(cmd)) return undefined;
  const found = Bun.which(cmd);
  return found ?? undefined;
}

/** Windows .cmd/.bat shims require shell execution under node:child_process. */
export function needsShellForCommand(cmd: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(cmd);
}

/** Detect whether a command exists on PATH. */
export function hasCommand(cmd: string): boolean {
  return resolveCommand(cmd) !== undefined;
}

export function isGitRepo(): boolean {
  return existsSync(join(cwd(), ".git")) || existsSync(resolve(cwd(), ".git"));
}

// --- tiny ANSI helpers (no dependency) ---
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  cyan: wrap(36),
};

export function parseFlags(args: string[]): {
  positionals: string[];
  flags: Record<string, string | boolean>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}
