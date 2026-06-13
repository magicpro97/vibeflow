import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface SemgrepResult {
  ok: boolean;
  /**
   * Number of findings.
   *  - >= 0  : findings count (only meaningful when ok=false)
   *  - -1    : semgrep ran but its stdout could not be parsed as JSON.
   *            Check parseError. Distinct from "0 findings" so downstream
   *            code can surface a clear error rather than printing
   *            "✗ semgrep: -1 finding(s)".
   */
  findings: number;
  raw: string;
  missing: boolean;
  /**
   * True only when semgrep ran (or was missing) but its stdout could not
   * be parsed as JSON. Mutually exclusive with `missing`. Downstream code
   * should report this as a config/syntax problem, not a finding.
   */
  parseError: boolean;
}

/** Minimal spawn signature for dependency injection in tests. */
type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts: SpawnSyncOptions,
) => SpawnSyncReturns<string>;

/**
 * Pure decision function: given a spawn result, produce the SemgrepResult.
 * Extracted so the contract can be unit-tested without spawning a real
 * semgrep binary (Bun resolves PATH at startup, not per-spawn, so PATH
 * mocking doesn't work — testing the decision function directly does).
 */
export function decideSemgrepResult(r: SpawnSyncReturns<string>): Omit<SemgrepResult, "missing"> & {
  missing: false;
} {
  // Exit 0 → clean
  if (r.status === 0) {
    return { ok: true, findings: 0, raw: r.stdout, missing: false, parseError: false };
  }
  // Status null + no error → unusual; treat as parse-error hard-fail rather
  // than silently passing as "missing" (which would lie about state).
  if (r.status === null && !r.error) {
    return {
      ok: false,
      findings: -1,
      raw: r.stdout || r.stderr || "semgrep exited with null status",
      missing: false,
      parseError: true,
    };
  }
  // --error exits non-zero on findings; try to parse
  try {
    const parsed = JSON.parse(r.stdout || "{}");
    const findings = (parsed.results ?? []).length;
    return { ok: false, findings, raw: r.stdout, missing: false, parseError: false };
  } catch {
    return {
      ok: false,
      findings: -1,
      raw: r.stdout || r.stderr,
      missing: false,
      parseError: true,
    };
  }
}

export function runSemgrep(projectRoot: string, options: { spawn?: SpawnFn } = {}): SemgrepResult {
  const cfg = join(projectRoot, ".semgrep.yml");
  if (!existsSync(cfg)) {
    return { ok: true, findings: 0, raw: "no .semgrep.yml", missing: true, parseError: false };
  }
  const spawn = options.spawn ?? spawnSync;
  const r = spawn(
    "semgrep",
    ["scan", "--config", cfg, "--error", "--quiet", "--json", projectRoot],
    { encoding: "utf8" },
  );
  // ENOENT: semgrep binary not installed — soft-pass via `missing`.
  const errCode = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (errCode === "ENOENT") {
    return {
      ok: true,
      findings: 0,
      raw: "semgrep not installed",
      missing: true,
      parseError: false,
    };
  }
  return { ...decideSemgrepResult(r), missing: false };
}
