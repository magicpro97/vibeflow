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
import { type Engine, ctxPathIn, cwd, hasCommand, writeFileSafe } from "./core.js";

/** Default bound for the (network-bound) installer; keeps init from hanging. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 180_000;

/** The header the guide block is keyed on (idempotency + spec contract). */
const GUIDE_HEADER = "## Memory: claude-mem";

/** Header the copilot guide block is keyed on (idempotency). */
const COPILOT_GUIDE_HEADER = "## Memory: GitHub Copilot";

/**
 * VibeFlow engine → claude-mem `--ide` identifier. These are the exact IDs
 * claude-mem's installer accepts (`claude-code`, `codex-cli`, `copilot-cli`);
 * a wrong id makes the installer exit non-zero with "Unknown IDE".
 */
export const ENGINE_IDE: Record<Engine, string> = {
  claude: "claude-code",
  codex: "codex-cli",
  copilot: "copilot-cli",
  opencode: "opencode-cli",
  antigravity: "antigravity-cli",
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
  /** Injectable copilot guide appender. Defaults to {@link appendCopilotMemoryGuide}. */
  appendCopilotGuide?: (base: string) => boolean;
  /**
   * Pinned claude-mem version (e.g. `"1.2.3"`, `"@1.2.3"`, or `"latest"`).
   * MUST-FIX (PR #160 review): default `npx -y claude-mem` always
   * fetches the latest, which is a supply-chain risk. Operators can
   * pin via `VF_CLAUDE_MEM_VERSION` env var or the `memory.version`
   * field in `.vibeflow/SETTINGS.json`. Default is `"12"` — the newest band
   * before the account/email (better-auth) era; production deployments may
   * pin tighter.
   */
  version?: string;
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
  // MUST-FIX (PR #160 review): allow pinning claude-mem version.
  // `npx -y claude-mem@<version>` installs a specific version;
  // `npx -y claude-mem` (the original) always fetches latest. The
  // version is read from the env first, then opts, then "latest".
  // Default pin: "12" is the newest claude-mem band before the better-auth
  // account/email login era (13.x). It carries the codex-cli/copilot-cli ide
  // ids (added in 10.7.0) and never prompts for an account, so a fresh install
  // is one-shot. Override: opts.version → VF_CLAUDE_MEM_VERSION → "12".
  const version = opts.version ?? process.env.VF_CLAUDE_MEM_VERSION ?? "12";
  const pkg = version === "latest" ? "claude-mem" : `claude-mem@${version}`;
  try {
    const r = spawn(
      "npx",
      ["-y", pkg, "install", "--ide", ide, "--provider", "claude", "--no-auto-start"],
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
  const appendCopilot = opts.appendCopilotGuide ?? appendCopilotMemoryGuide;
  const seen = new Set<Engine>();
  const wired: Engine[] = [];
  const failed: Array<{ engine: Engine; reason: string }> = [];
  for (const engine of engines) {
    if (seen.has(engine)) continue;
    seen.add(engine);
    if (engine === "copilot") {
      // Copilot uses its own native /memory feature, not claude-mem. We only
      // drop a guidance line; the append result is advisory (a missing policy
      // file is not a failure), so copilot is always reported wired.
      appendCopilot(opts.cwd ?? cwd());
      wired.push(engine);
      continue;
    }
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

/** Render the markdown guide telling a Copilot session to enable native memory. Pure. */
export function buildCopilotMemoryGuide(): string {
  return `${COPILOT_GUIDE_HEADER} (VibeFlow)

When running in GitHub Copilot CLI, enable session memory by typing the
slash command at the start of your session:

\`\`\`
/memory on
\`\`\`

VibeFlow cannot enable this for you — it is an interactive command, not a
headless flag. Once enabled, Copilot persists memory across this project's
sessions.
`;
}

/**
 * Append the copilot guide to <base>/.vibeflow/WORKFLOW_POLICY.md when not
 * already present. Idempotent (keyed on the copilot header) and best-effort:
 * returns false when the policy file is absent or the block already exists.
 * Never throws.
 */
export function appendCopilotMemoryGuide(base: string): boolean {
  const path = ctxPathIn(base, "WORKFLOW_POLICY.md");
  if (!existsSync(path)) return false;
  const current = readFileSync(path, "utf8");
  if (current.includes(COPILOT_GUIDE_HEADER)) return false;
  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSafe(path, `${current}${sep}${buildCopilotMemoryGuide()}`);
  return true;
}
