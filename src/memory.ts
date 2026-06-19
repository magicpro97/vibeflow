// src/memory.ts
//
// claude-mem integration backend for `vf init` (Phase 1.5). Thin, pure,
// and injectable: every side effect (PATH lookup, subprocess, file I/O)
// goes through a seam so unit tests never shell out. All functions are
// best-effort — they return a result, never throw — because memory is an
// enrichment, not a gate: a failed install or a missing policy file must
// not block init.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { ctxPathIn, hasCommand, writeFileSafe } from "./core.js";

/** Default bound for the (network-bound) installer; keeps init from hanging. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 180_000;

/** The header the guide block is keyed on (idempotency + spec contract). */
const GUIDE_HEADER = "## Memory: claude-mem";

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
 * Install claude-mem non-interactively. No-op (ok) when already present.
 * Runs `npx -y claude-mem install --provider claude --no-auto-start` so the
 * installer never blocks on its own prompts. Bounded; never throws.
 */
export async function ensureInstalled(
  opts: MemoryBackendOpts = {},
): Promise<{ ok: boolean; reason?: string }> {
  if (isInstalled({ has: opts.has })) return { ok: true };
  const spawn = opts.spawner ?? spawnSync;
  try {
    const r = spawn(
      "npx",
      ["-y", "claude-mem", "install", "--provider", "claude", "--no-auto-start"],
      { encoding: "utf8", timeout: opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS, cwd: opts.cwd },
    );
    if (r.status === 0) return { ok: true };
    const stderr = typeof r.stderr === "string" ? r.stderr.trim() : "";
    return { ok: false, reason: stderr ? stderr : `claude-mem install exited ${r.status}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
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
