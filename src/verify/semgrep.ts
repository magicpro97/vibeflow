import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface SemgrepResult {
  ok: boolean;
  findings: number;
  raw: string;
  missing: boolean;
}

export function runSemgrep(projectRoot: string): SemgrepResult {
  const cfg = join(projectRoot, ".semgrep.yml");
  if (!existsSync(cfg)) {
    return { ok: true, findings: 0, raw: "no .semgrep.yml", missing: true };
  }
  const r = spawnSync(
    "semgrep",
    ["scan", "--config", cfg, "--error", "--quiet", "--json", projectRoot],
    { encoding: "utf8" },
  );
  if (r.status === 0) return { ok: true, findings: 0, raw: r.stdout, missing: false };
  // --error exits non-zero on findings
  try {
    const parsed = JSON.parse(r.stdout || "{}");
    const findings = (parsed.results ?? []).length;
    return { ok: false, findings, raw: r.stdout, missing: false };
  } catch {
    return { ok: false, findings: -1, raw: r.stdout || r.stderr, missing: false };
  }
}
