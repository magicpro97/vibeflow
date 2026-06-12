import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface SemgrepResult {
  ok: boolean;
  /** Number of findings. 0 means clean; -1 means parse error (see parseError). */
  findings: number;
  raw: string;
  missing: boolean;
  /**
   * True only when semgrep exited non-zero AND its stdout could not be parsed
   * as JSON. Distinct from "0 findings" so downstream code can surface a
   * clear error rather than printing "✗ semgrep: -1 finding(s)".
   */
  parseError: boolean;
}

export function runSemgrep(projectRoot: string): SemgrepResult {
  const cfg = join(projectRoot, ".semgrep.yml");
  if (!existsSync(cfg)) {
    return { ok: true, findings: 0, raw: "no .semgrep.yml", missing: true, parseError: false };
  }
  const r: SpawnSyncReturns<string> = spawnSync(
    "semgrep",
    ["scan", "--config", cfg, "--error", "--quiet", "--json", projectRoot],
    { encoding: "utf8" },
  );
  if (r.status === 0) {
    return { ok: true, findings: 0, raw: r.stdout, missing: false, parseError: false };
  }
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
  // --error exits non-zero on findings
  try {
    const parsed = JSON.parse(r.stdout || "{}");
    const findings = (parsed.results ?? []).length;
    return { ok: false, findings, raw: r.stdout, missing: false, parseError: false };
  } catch (err) {
    return {
      ok: false,
      findings: 0,
      raw: r.stdout || r.stderr,
      missing: false,
      parseError: true,
    };
  }
}
