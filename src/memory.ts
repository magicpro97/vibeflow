// src/memory.ts
//
// claude-mem integration backend for `vf init` (Phase 1.5). Thin, pure,
// and injectable: every side effect (PATH lookup, subprocess, file I/O)
// goes through a seam so unit tests never shell out. All functions are
// best-effort — they return a result, never throw — because memory is an
// enrichment, not a gate: a failed install or a missing policy file must
// not block init.
//
// claude-mem keeps ONE shared store (~/.claude-mem); installing wires the
// per-IDE hooks that feed it. claude-mem's `--ide` flag takes a SINGLE id
// (verified against its installer: `selectedIDEs = [options.ide]`, no
// comma-split), so wiring N engines means N installer invocations — one
// per engine — against the same shared store. We stream the installer's
// output (stdio:"inherit") because the first run downloads the plugin and
// runs bun/npm install; a silent spawnSync looked like a hang.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { type Engine, ctxPathIn, hasCommand, writeFileSafe } from "./core.js";

/** Default bound for the (network-bound) installer; keeps init from hanging. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 180_000;

/** The header the guide block is keyed on (idempotency + spec contract). */
const GUIDE_HEADER = "## Memory: claude-mem";

/**
 * VibeFlow engine → claude-mem `--ide` identifier. These are the exact IDs
 * claude-mem's installer accepts (`claude-code`, `codex-cli`, `copilot-cli`);
 * a wrong id makes the installer exit non-zero with "Unknown IDE".
 */
export const ENGINE_IDE: Record<Engine, string> = {
  claude: "claude-code",
  codex: "codex-cli",
  copilot: "copilot-cli",
};

export interface MemoryBackendOpts {
  /** Bound for the installer subprocess (ms). Default {@link DEFAULT_INSTALL_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Working directory for the installer. */
  cwd?: string;
  /**
   * Injectable spawner so unit tests never shell out. Defaults to the real
   * `spawnSync`. Typed to its shape (single-line `?? spawnSync` default keeps
   * the per-file coverage gate green — see init-ctx7.ts for the same idiom).
   */
  spawner?: typeof spawnSync;
  /** Injectable PATH check. Defaults to the real {@link hasCommand}. */
  has?: (cmd: string) => boolean;
}

/** True when the `claude-mem` binary is resolvable on PATH. */
export function isInstalled(opts: Pick<MemoryBackendOpts, "has"> = {}): boolean {
  const has = opts.has ?? hasCommand;
  return has("claude-mem");
}

/**
 * Wire claude-mem for ONE engine. Runs
 *   npx -y claude-mem install --ide <id> --provider claude --no-auto-start
 * with stdio inherited so the user sees live progress (the first run
 * downloads the plugin + runs bun/npm install — a silent spawn looked like
 * a hang). `--no-auto-start` skips the worker autostart prompt; `--ide`
 * scopes the install to one IDE (the flag takes a single value). Bounded by
 * `timeoutMs`; never throws.
 *
 * Because stdio is inherited, the installer's own stderr goes straight to
 * the terminal, so a failure `reason` here is just the exit signal — the
 * actionable detail is already on screen.
 */
export function installForEngine(
  engine: Engine,
  opts: MemoryBackendOpts = {},
): { ok: boolean; reason?: string } {
  const spawn = opts.spawner ?? spawnSync;
  const ide = ENGINE_IDE[engine];
  try {
    const r = spawn(
      "npx",
      ["-y", "claude-mem", "install", "--ide", ide, "--provider", "claude", "--no-auto-start"],
      { stdio: "inherit", timeout: opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS, cwd: opts.cwd },
    );
    if (r.status === 0) return { ok: true };
    if (r.signal) return { ok: false, reason: `killed by ${r.signal} (likely timed out)` };
    return { ok: false, reason: `claude-mem install --ide ${ide} exited ${r.status}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Per-engine wiring outcome from {@link ensureInstalledForEngines}. */
export interface MemoryWireResult {
  /** Engines whose claude-mem hook was wired successfully. */
  wired: Engine[];
  /** Engines that failed, with the reason (exit/signal/throw). */
  failed: Array<{ engine: Engine; reason: string }>;
}

/**
 * Wire claude-mem for each engine in `engines`, sharing the one ~/.claude-mem
 * store. Best-effort per engine: a failure on one engine is recorded and the
 * loop continues, so a missing copilot CLI never blocks wiring claude/codex.
 * Never throws. Engines are de-duplicated, preserving first-seen order.
 *
 * Note: claude-mem install is idempotent and the heavy first-run work
 * (plugin download, bun/npm install) is shared, so later engines in the loop
 * only register their IDE hook — fast.
 */
export function ensureInstalledForEngines(
  engines: Engine[],
  opts: MemoryBackendOpts = {},
): MemoryWireResult {
  const seen = new Set<Engine>();
  const wired: Engine[] = [];
  const failed: Array<{ engine: Engine; reason: string }> = [];
  for (const engine of engines) {
    if (seen.has(engine)) continue;
    seen.add(engine);
    const res = installForEngine(engine, opts);
    if (res.ok) wired.push(engine);
    else failed.push({ engine, reason: res.reason ?? "unknown" });
  }
  return { wired, failed };
}

/** Render the markdown guide block appended to WORKFLOW_POLICY.md. Pure. */
export function buildMemoryGuide(): string {
  return `${GUIDE_HEADER} (VibeFlow)

Before writing a spec, plan, or making a non-trivial design decision, query
claude-mem for relevant past workflows and decisions in this repo:

\`\`\`
claude-mem search "<topic or task name>"
\`\`\`

Treat the top hits as required reading. If a past decision contradicts the
current task, surface the conflict in your uncertainty — do not silently
re-litigate it.
`;
}

/**
 * Append the guide to <base>/.vibeflow/WORKFLOW_POLICY.md when not already
 * present. Idempotent (keyed on the guide header) and best-effort: returns
 * false when the policy file is absent or the block already exists. Never throws.
 */
export function appendMemoryGuide(base: string): boolean {
  const path = ctxPathIn(base, "WORKFLOW_POLICY.md");
  if (!existsSync(path)) return false;
  const current = readFileSync(path, "utf8");
  if (current.includes(GUIDE_HEADER)) return false;
  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSafe(path, `${current}${sep}${buildMemoryGuide()}`);
  return true;
}
