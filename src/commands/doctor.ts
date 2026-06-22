// src/commands/doctor.ts
//
// `vf doctor` subcommand + the resolveRepo / detectRepo helpers it owns.
// Issue #80, phase 3/14.
//
// Contents:
// - readinessMark, printReadiness: visual helpers for the doctor table.
// - doctor: the main exported subcommand. Takes flags + optional
//   injection seams (readiness array, hasCommand override) so unit
//   tests can exercise the "missing required tool" and "engine probe
//   failed" branches without spawning real binaries.
// - resolveRepo: validate a user-supplied repo path; fall back to
//   cwd if the path is empty or not a directory.
// - detectRepo + RepoDetection: probe a repo for engine-specific
//   marker files and CLI presence. Used by the UI shell and the
//   server (`src/server.ts`) at runtime.
//
// All helpers used by `doctor` (liveGuardrailArmed, guardrailOffNote)
// come from the seams module via the barrel.

import type { Engine, EngineReadiness } from "./_shared.js";
import {
  ENGINES,
  Spinner,
  c,
  cwd,
  existsSync,
  guardrailOffNote,
  hasCommand,
  isAbsolute,
  isGitRepo,
  join,
  liveGuardrailArmed,
  out,
  panel,
  preflightAll,
  preflightAllAsync,
  resolve,
  statSync,
  table,
} from "./_shared.js";

/** Color a readiness level for the doctor table. */
function readinessMark(level: EngineReadiness["level"]): string {
  if (level === "ready") return c.green("✓");
  if (level === "no-binary") return c.dim("•");
  return c.yellow("!");
}

/**
 * Print per-engine readiness under the presence table. Without --probe this is a fast
 * presence/auth check; with --probe it runs the live round-trip. Informational only —
 * the hard gate lives in applyIntake/run, not here.
 */
function printReadiness(
  probe: boolean,
  list = preflightAll(ENGINES, { probe }),
): EngineReadiness[] {
  out("vf", c.bold(`\nEngine readiness${probe ? " (live probe)" : " (presence/auth)"}:`));
  for (const r of list) {
    out("vf", `  ${readinessMark(r.level)} ${r.engine}: ${c.dim(r.detail)}`);
  }
  if (!probe) out("vf", c.dim("  (run `vf doctor --probe` for a live engine round-trip)"));
  return list;
}

export async function doctor(
  flags: Record<string, string | boolean> = {},
  inject: {
    readiness?: EngineReadiness[];
    // Test seam: lets unit tests inject a custom hasCommand to
    // exercise the "missing required tool" branch (line 203-204).
    hasCommand?: (cmd: string) => boolean;
  } = {},
): Promise<number> {
  const _hasCommand = inject.hasCommand ?? hasCommand;
  const checks: Array<[string, boolean, "required" | "optional"]> = [
    ["node", _hasCommand("node"), "required"],
    ["git", _hasCommand("git"), "required"],
    ["bun", _hasCommand("bun"), "optional"],
    ["claude", _hasCommand("claude"), "optional"],
    ["codex", _hasCommand("codex"), "optional"],
    ["copilot", _hasCommand("copilot"), "optional"],
    ["gh", _hasCommand("gh"), "optional"],
    ["docker", _hasCommand("docker"), "optional"],
  ];
  out("vf", panel("VibeFlow", c.bold("environment check")));
  let missingRequired = 0;
  const toolRows: string[][] = [];
  for (const [name, ok, kind] of checks) {
    const mark = ok ? c.green("✔") : kind === "required" ? c.red("✗") : c.yellow("•");
    const status = ok ? c.green("ok") : kind === "required" ? c.red("missing") : c.dim("missing");
    if (!ok && kind === "required") missingRequired++;
    toolRows.push([mark, name, status]);
  }
  out("vf", table(["", "tool", "status"], toolRows));
  out("vf", `\n  git repository: ${isGitRepo() ? c.green("yes") : c.yellow("no")}`);
  out("vf", `  ${liveGuardrailArmed(cwd()) ? c.green("live guardrail: ON") : guardrailOffNote()}`);

  // Issue #163 (F2): stale logbus lock detection
  const lockFile = join(cwd(), ".vibeflow", "logs", "current", "current.log.lock");
  if (existsSync(lockFile)) {
    try {
      const stat = statSync(lockFile);
      const ageSec = (Date.now() - stat.mtimeMs) / 1000;
      if (ageSec > 60) {
        out(
          "vf",
          `  ${c.yellow("!")} logbus lock is stale (${Math.round(ageSec)}s old) — a prior session may have crashed`,
        );
      }
    } catch {
      // stat failed — ignore
    }
  }

  const probe = Boolean(flags.probe);
  const refresh = Boolean(flags.refresh);
  if (refresh) {
    const { invalidateAllProbes } = await import("../probe-cache.js");
    invalidateAllProbes();
    out("vf", c.dim("probe cache cleared"));
  }
  let readiness: EngineReadiness[];
  if (inject.readiness) {
    readiness = inject.readiness;
  } else if (probe) {
    const spinner = new Spinner();
    spinner.start("Running engine probes (parallel)…");
    readiness = await preflightAllAsync(ENGINES, { probe: true, skipCache: refresh });
    spinner.succeed("Engine probes complete");
  } else {
    readiness = preflightAll(ENGINES, { probe: false, skipCache: refresh });
  }
  printReadiness(probe, readiness);

  if (missingRequired > 0) {
    out("vf", c.red(`\n${missingRequired} required tool(s) missing.`));
    return 1;
  }
  const probeFailed = probe ? readiness.filter((r) => r.level === "probe-failed") : [];
  if (probeFailed.length > 0) {
    out(
      "vf",
      c.yellow(
        `\n${probeFailed.length} engine probe(s) failed: ${probeFailed.map((r) => r.engine).join(", ")}. Other tools are present.`,
      ),
    );
    return 1;
  }
  out("vf", c.green("\nReady."));
  return 0;
}

/** Validate and resolve a user-supplied repo path to an absolute existing directory. */
export function resolveRepo(path?: string): string {
  if (!path || !path.trim()) return cwd();
  const abs = isAbsolute(path) ? path : resolve(cwd(), path);
  try {
    if (statSync(abs).isDirectory()) return abs;
  } catch {
    /* fall through */
  }
  return cwd();
}

export interface RepoDetection {
  repo: string;
  isGit: boolean;
  engines: Record<Engine, boolean>;
  clis: Record<Engine, boolean>;
}

/** Detect which engines a repo already carries (by marker files) and which CLIs are present. */
export function detectRepo(path?: string): RepoDetection {
  const repo = resolveRepo(path);
  const has = (rel: string) => existsSync(join(repo, rel));
  return {
    repo,
    isGit: has(".git"),
    engines: {
      claude: has("CLAUDE.md") || has(".claude"),
      codex: has("AGENTS.md") || has(".codex"),
      copilot: has(".github/copilot-instructions.md"),
    },
    clis: {
      claude: hasCommand("claude"),
      codex: hasCommand("codex"),
      copilot: hasCommand("copilot") || hasCommand("gh"),
    },
  };
}
