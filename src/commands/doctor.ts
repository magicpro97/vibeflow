import {
  type DoctorOwnedProcessInject,
  inspectDoctorOwnedProcesses,
  printDoctorOwnedProcessHealth,
} from "../dispatch/doctor-owned-process-health.js";
import { opencodePluginStale } from "../hooks/adapters.js";
import { sharedCatalogDir, sharedSkillNames } from "../skills/catalog.js";
import type { Engine, EngineReadiness } from "./_shared.js";
import {
  CTX7_AUTH_STATUS_REL,
  CTX_DIR,
  ENGINES,
  Spinner,
  c,
  cwd,
  existsSync,
  hasCommand,
  isAbsolute,
  isGitRepo,
  join,
  out,
  panel,
  preflightAll,
  preflightAllAsync,
  readFileSync,
  resolve,
  statSync,
  table,
} from "./_shared.js";
import { legacyWriterFence } from "./capability/legacy-fence.js";

/** Shape written by `ensureCtx7Auth` (issue #630). Untrusted on-disk JSON —
 *  callers must not assume the fields are present/well-typed. */
interface Ctx7AuthStatus {
  authenticated?: unknown;
  mode?: unknown;
}

/** Print the persisted ctx7 auth decision (issue #630), if any. Observability
 *  only — absence of the file means no AI-enabled `vf init` has run yet, not
 *  an error, so this prints nothing rather than a warning. */
function printCtx7AuthStatus(base: string): void {
  const path = join(base, CTX_DIR, CTX7_AUTH_STATUS_REL);
  if (!existsSync(path)) return;
  let status: Ctx7AuthStatus;
  try {
    status = JSON.parse(readFileSync(path, "utf8")) as Ctx7AuthStatus;
  } catch {
    return; // malformed file — skip rather than crash `vf doctor`
  }
  if (status.authenticated === true) {
    out("vf", `  ctx7: ${c.green("authenticated")}`);
    return;
  }
  out(
    "vf",
    `  ${c.yellow("ctx7: unauthenticated — using HTTP fallback (rate-limited, no direct install)")}`,
  );
}

// ponytail: inlined from seams.ts (#391) — guardrail diagnostics
const GUARDRAIL_SENTINEL = "vibeflow-guardrail";
function _commandDelegatesToVibeflow(cmd: string): boolean {
  if (cmd.includes(GUARDRAIL_SENTINEL)) return true;
  return /dist\/cli\.js"?\s+hook\b/.test(cmd);
}
function _hookDelegatesToVibeflow(command: unknown, args: unknown): boolean {
  if (Array.isArray(args)) {
    const strs = args.filter((a): a is string => typeof a === "string");
    if (strs.some((a) => /[\\/]dist[\\/]cli\.js$/.test(a)) && strs.includes("hook")) return true;
  }
  return typeof command === "string" && _commandDelegatesToVibeflow(command);
}
export function liveGuardrailArmed(base: string): boolean {
  try {
    const raw = readFileSync(join(base, ".claude", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: unknown; args?: unknown }> }> };
    };
    const pre = parsed.hooks?.PreToolUse;
    if (
      Array.isArray(pre) &&
      pre.some((e) => (e.hooks ?? []).some((h) => _hookDelegatesToVibeflow(h.command, h.args)))
    )
      return true;
  } catch {
    /* not armed via Claude */
  }
  try {
    const raw = readFileSync(join(base, ".github", "hooks", "copilot.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      hooks?: { preToolUse?: Array<{ bash?: unknown; powershell?: unknown }> };
    };
    const pre = parsed.hooks?.preToolUse;
    if (
      Array.isArray(pre) &&
      pre.some(
        (e) =>
          _commandDelegatesToVibeflow(typeof e.bash === "string" ? e.bash : "") ||
          _commandDelegatesToVibeflow(typeof e.powershell === "string" ? e.powershell : ""),
      )
    )
      return true;
  } catch {
    /* not armed via Copilot */
  }
  // Opencode plugin: `.opencode/plugins/vf-guard.ts` (plural — the documented
  // directory) auto-loads and shells out to `vf hook`. We don't parse the TS
  // source — we just look for the generator's stable marker so a hand-rolled
  // plugin that doesn't actually delegate to `vf hook` does NOT report as armed.
  try {
    const raw = readFileSync(join(base, ".opencode", "plugins", "vf-guard.ts"), "utf8");
    // The generator's plugin always references the literal `"hook"` arg in
    // its `spawnSync` call. A hand-rolled plugin that doesn't delegate to
    // `vf hook` is missing that arg, so the sentinel + arg check is enough.
    if (raw.includes(GUARDRAIL_SENTINEL) && /["']hook["']/.test(raw)) return true;
  } catch {
    /* not armed via opencode */
  }
  return false;
}
/** #624 Task 4: the COMMIT-TIME git guardrail — .githooks/pre-commit routed via
 *  core.hooksPath. #748: git guardrails are armed only when BOTH .githooks/pre-commit
 *  and .githooks/pre-push exist, so the doctor message keeps them distinct. */
export function gitGuardrailArmed(base: string): boolean {
  try {
    const preCommit = statSync(join(base, ".githooks", "pre-commit"));
    const prePush = statSync(join(base, ".githooks", "pre-push"));
    return preCommit.isFile() && prePush.isFile() && preCommit.size > 0 && prePush.size > 0;
  } catch {
    return false;
  }
}

export function guardrailOffNote(): string {
  return c.yellow(
    "live guardrail: OFF — risky tool calls are NOT intercepted. Run `vf hooks emit --yes` to arm the PreToolUse gate.",
  );
}

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
function printReadiness(probe: boolean, list: EngineReadiness[]): EngineReadiness[] {
  out("vf");
  out("vf", c.bold(`Engine readiness${probe ? " (live probe)" : " (presence/auth)"}:`));
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
    // Test seam: override the base directory used for live-guardrail
    // detection and opencode-plugin staleness checks. Defaults to cwd().
    base?: string;
    // Test seam: override the `emitHookFiles` used by `--fix` so unit tests
    // can force the "wrote nothing" / "threw" defensive branches without
    // mock.module() (which leaks across test files in the same process).
    emitHookFiles?: (base: string, engines?: Engine[]) => string[];
  } & DoctorOwnedProcessInject = {},
): Promise<number> {
  const _hasCommand = inject.hasCommand ?? hasCommand;
  const base = inject.base ?? cwd();
  const checks: Array<[string, boolean, "required" | "optional"]> = [
    ["node", _hasCommand("node"), "required"],
    ["git", _hasCommand("git"), "required"],
    ["bun", _hasCommand("bun"), "optional"],
    ["claude", _hasCommand("claude"), "optional"],
    ["codex", _hasCommand("codex"), "optional"],
    ["copilot", _hasCommand("copilot"), "optional"],
    ["agy", _hasCommand("agy"), "optional"],
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
  out("vf");
  out("vf", `  git repository: ${isGitRepo() ? c.green("yes") : c.yellow("no")}`);
  out(
    "vf",
    `  git guardrails: ${gitGuardrailArmed(base) ? c.green("ON (pre-commit + pre-push)") : c.yellow("OFF — run 'vf hooks install' or re-init to arm .githooks/pre-commit + pre-push")}`,
  );
  out("vf", `  ${liveGuardrailArmed(base) ? c.green("live guardrail: ON") : guardrailOffNote()}`);
  out(
    "vf",
    c.yellow(
      "  codex hook coverage: native Bash/shell only; config is global at ~/.codex/ (Edit/Write/apply_patch/MCP calls remain unguarded)",
    ),
  );
  const legacyFence = legacyWriterFence(base);
  out(
    "vf",
    `  compatibility writers: ${
      legacyFence.blocked ? c.yellow(`BLOCKED — ${legacyFence.details}`) : c.green("clear")
    }`,
  );
  printCtx7AuthStatus(base);

  // #624: detect a stale opencode plugin. The generator hard-codes the
  // absolute CLI path; if the user reinstalled/moved the CLI the plugin
  // silently falls back to "allow" — a quiet loss of the guardrail.
  const opencodeStale = opencodePluginStale(base);
  if (opencodeStale?.stale) {
    const fix = Boolean(flags.fix);
    if (fix) {
      try {
        const emitHookFiles = inject.emitHookFiles ?? (await import("./hooks.js")).emitHookFiles;
        // emitHookFiles always re-emits .githooks/* (VibeFlow-owned, engine-
        // agnostic), so filter to the opencode plugin only — that's what the
        // user came here to fix.
        const all = emitHookFiles(base, ["opencode"]);
        const written = all.filter((rel) => rel.startsWith(".opencode/"));
        if (written.length > 0) {
          out(
            "vf",
            c.green(
              `  ✓ opencode plugin refreshed (${written.join(", ")}) — hard-coded path now matches current CLI ${opencodeStale.expected}`,
            ),
          );
        } else {
          out(
            "vf",
            c.yellow("  ! could not refresh opencode plugin (emitHookFiles wrote nothing)"),
          );
        }
      } catch (e) {
        out(
          "vf",
          c.yellow(
            `  ! opencode plugin is STALE and auto-refresh failed: ${(e as Error).message}. Run \`vf hooks emit --yes\` manually.`,
          ),
        );
      }
    } else {
      out(
        "vf",
        c.yellow(
          `  ⚠ opencode plugin is STALE: hard-coded path ${opencodeStale.actual ?? "(missing)"} does not match current CLI ${opencodeStale.expected}. Run \`vf doctor --fix\` to refresh automatically, or \`vf hooks emit --yes\` manually.`,
        ),
      );
    }
  }

  // Issue #631: shared skill catalog report
  const catalogPath = sharedCatalogDir();
  const catalogSkills = sharedSkillNames();
  out(
    "vf",
    `  shared catalog: ${c.dim(catalogPath)} (${catalogSkills.length} skill${catalogSkills.length === 1 ? "" : "s"})`,
  );

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
  const ownedProcessHealth = inspectDoctorOwnedProcesses(base, Boolean(flags.fix), inject);
  printDoctorOwnedProcessHealth(ownedProcessHealth);

  const probe = Boolean(flags.probe);
  const refresh = Boolean(flags.refresh);
  if (refresh) {
    const { invalidateAllProbes } = await import("../preflight.js");
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
    out("vf");
    out("vf", c.red(`${missingRequired} required tool(s) missing.`), { level: "error" });
    return 1;
  }
  const probeFailed = probe ? readiness.filter((r) => r.level === "probe-failed") : [];
  if (probeFailed.length > 0) {
    out(
      "vf",
      c.yellow(
        `\n${probeFailed.length} engine probe(s) failed: ${probeFailed.map((r) => r.engine).join(", ")}. Other tools are present.`,
      ),
      { level: "error" },
    );
    return 1;
  }
  if (ownedProcessHealth.uncertain.length > 0) {
    out("vf");
    out(
      "vf",
      c.yellow(
        "Owned CLI recovery remains uncertain. Run `vf doctor --fix` or inspect the records manually.",
      ),
      {
        level: "error",
      },
    );
    return 1;
  }
  out("vf");
  out("vf", c.green("Ready."));
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
      opencode: has("AGENTS.md"),
      antigravity: has("AGENTS.md"),
    },
    clis: {
      claude: hasCommand("claude"),
      codex: hasCommand("codex"),
      copilot: hasCommand("copilot") || hasCommand("gh"),
      opencode: hasCommand("opencode"),
      antigravity: hasCommand("agy"),
    },
  };
}
