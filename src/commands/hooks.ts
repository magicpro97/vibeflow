// `vf hook` / `vf hook --selftest` / `vf hooks` subcommands extracted
// from src/commands.ts (issue #80, phase 7/14). Pure byte-equivalent
// move: bodies preserved verbatim, only relative import paths adjusted
// (./_shared.js, ../safety/checkpoint.js, ../discovery/context7.js, etc.)
//
// Fail-closed posture preserved for `hook` (issue #79, PR #107):
// - no input ever arrived → allow (fallback session, return 0)
// - non-empty but unparseable input → BLOCK on the live tool gate
//   (return 2) — was: fail-open, security bug; now: fail-closed
// - parseable + evaluateHook → presentDecision JSON + correct exit code
// - 1 MiB stdin cap (CWE-400)
//
// `hookSelftest` writes an auditable report to
// .vibeflow/knowledge/hook-selfcheck.json (survives checkpoint gitignore).
// Fail-closed on regressions: any failed case → return 1.
//
// `hooks` (the cluster CLI) is the small surface around `installHooks`:
// `install` writes core.hooksPath=.githooks (fail-closed on git errors,
// per PR28 audit Task 7 M3 — was: silent return bad status); `status`
// reads back core.hooksPath + live-guardrail probe; `emit` dry-runs by
// default and only writes engine configs with explicit --yes
// (hot-reloads the agent, so consent is mandatory).
//
// size-waiver: #462 — web UI approval path adds ~60 lines waiver: #462 owner:magicpro97 expires:2027-12-31

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "../core.js";
import { readLocalSpec, specStaleSignals } from "../spec-freshness.js";
import {
  CTX_DIR,
  type Engine,
  type HookConfig,
  c,
  cwd,
  engineHookFiles,
  evaluateHook,
  guardrailOffNote,
  liveGuardrailArmed,
  out,
  parseHookInput,
  presentAntigravityDecision,
  presentDecision,
  readSettings,
  resolveHookPolicy,
  runSelftest,
  writeFileSafe,
  writeSettings,
} from "./_shared.js";
import type { SelftestReport } from "./_shared.js";
import { type LastVerify, readLastVerify } from "./tools-detect.js";

/**
 * #624 Task 3: build the Stop-gate verify check. Returns a block-reason string when
 * the working tree has uncommitted code changes but no PASSING `vf verify` marker is
 * recorded for the CURRENT git HEAD — forcing the agent to run `vf verify` before it
 * ends its turn. Returns null (allow the stop) when the tree is clean, or a passing
 * marker exists for HEAD. Fail-open: any git/marker error → null (never trap the agent
 * on our own bookkeeping failure). `.vibeflow/`-only churn does not count as code change.
 */
export function buildVerifyGate(base: string): (input: HookInput) => string | null {
  return () => {
    try {
      const dirty = spawnSync("git", ["status", "--porcelain"], {
        cwd: base,
        encoding: "utf8",
      });
      if (dirty.status !== 0) return null; // not a git repo / git error → fail open
      const changed = dirty.stdout
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter((p) => p && !p.startsWith(".vibeflow/"));
      if (changed.length === 0) return null; // no code changes → nothing to verify
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf8" });
      const sha = head.status === 0 ? head.stdout.trim() : "HEAD";
      const marker: LastVerify | null = readLastVerify(base);
      if (marker?.passed && marker.sha === sha) return null; // verified this commit
      return "Uncommitted code changes with no passing `vf verify` for the current commit. Run `vf verify` and include its output before ending.";
    } catch {
      return null; // fail open — never block on our own error
    }
  };
}

// Architectural note (preserved from src/commands.ts pre-extraction, issue #80
// phase 7/14): `liveGuardrailArmed` lives in src/commands/seams.ts (the test-seam
// cluster, phase 2/14) and is imported here. Its semantics — re-stated for
// reviewers who land on this file first:
//
//   "True when an engine's hook config actually delegates to `vf hook`
//    (the only way the live per-tool-call guardrail is armed). For Claude
//    Code, a `PreToolUse` entry in `.claude/settings.json` whose command
//    points at our CLI. For GitHub Copilot, a `preToolUse` entry in
//    `.github/hooks/copilot.json` whose `bash` / `powershell` field points
//    at our CLI. Codex has no native pre-tool veto, so its config alone
//    does not arm the guardrail. The probe matches on either the
//    `# vibeflow-guardrail` sentinel (Copilot) or a `dist/cli.js hook`
//    argv (Claude) so unrelated mentions of "vf hook" can never read as
//    ON (issue #79 re-review)."

export async function hook(
  inject: {
    stdin?: { on: any; once: any; resume: any; pause: any };
    stdinTimeoutMs?: number;
    antigravity?: boolean;
  } = {},
): Promise<number> {
  const antigravity = inject.antigravity === true;
  // Claude Code spawns the hook with a JSON payload on stdin but does NOT
  // close the pipe. The kernel/pipe can split the payload across multiple
  // "data" events (e.g. > 64 KiB crosses the typical pipe chunk boundary),
  // so we MUST accumulate chunks until the stream ends (or times out) and
  // only then try to parse. Using `once("data", …)` (the old shape) read
  // only the first chunk, truncating multi-chunk JSON; parseHookInput then
  // failed on the partial prefix and the live tool gate fail-opened —
  // letting any unrecognized input through. The fix uses `on("data", …)`
  // with a balanced-brace check to detect a complete JSON object, falling
  // back to the timeout if the stream never produces a complete payload.
  // A 5 s timeout guards against a hook that receives no input at all
  // (fallback session where the hook pipe is /dev/null or similar).
  const stdin = inject.stdin ?? process.stdin;
  const timeoutMs = inject.stdinTimeoutMs ?? 5000;
  const MAX_STDIN_BYTES = 1 * 1024 * 1024; // 1 MiB hard cap (security: CWE-400)
  let raw = "";
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    stdin.pause();
  };
  const finish = (resolve: () => void) => {
    clearTimeout(timer);
    settle();
    resolve();
  };
  let timer: ReturnType<typeof setTimeout>;
  await new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      // Timeout: either no data at all (fallback session, fail-open) or
      // partial data (truncated stream, fail-CLOSED on the live gate).
      finish(resolve);
    }, timeoutMs);
    stdin.on("data", (chunk: Buffer) => {
      if (settled) return;
      const text = chunk.toString("utf8");
      // Cap total bytes read to avoid OOM from a hostile/greedy peer.
      if (raw.length + text.length > MAX_STDIN_BYTES) {
        raw = raw + text.slice(0, MAX_STDIN_BYTES - raw.length);
        finish(resolve);
        return;
      }
      raw += text;
      // Try to detect a complete JSON object. If parseHookInput succeeds
      // and yields a non-null HookInput, the payload is complete. This
      // handles multi-chunk JSON without waiting for `end` (which may
      // never come — Claude Code keeps the pipe open).
      if (raw.trim()) {
        try {
          const parsed = parseHookInput(raw);
          if (parsed !== null) {
            finish(resolve);
            return;
          }
        } catch {
          // Not yet a complete JSON; keep accumulating until timeout.
        }
      }
    });
    stdin.resume();
  });
  // Decide the gate outcome.
  // - raw is empty (no input ever arrived): fallback session, fail-OPEN.
  // - raw is non-empty but parseHookInput fails: hostile/truncated input,
  //   fail-CLOSED on the live tool gate (was: fail-open, security bug).
  const trimmed = raw.trim();
  if (!trimmed) {
    out(
      "vf",
      JSON.stringify({
        decision: "allow",
        risk: "none",
        reasons: ["no hook input — allowing (fallback session)"],
      }),
    );
    return 0;
  }
  const input = parseHookInput(trimmed);
  if (!input) {
    out(
      "vf",
      JSON.stringify({
        decision: "block",
        risk: "high",
        reasons: ["unrecognized hook input — blocking (fail-closed on live tool gate)"],
      }),
    );
    return 2;
  }
  // Load the repo's stored hook policy so the live gate honors the templates the
  // user kept (and any custom rules). readSettings is fail-safe: a missing/garbage
  // SETTINGS.json yields the all-on default, so the gate never silently weakens.
  const policy = resolveHookPolicy(readSettings(cwd()).hooks);
  // Task 4: advisory spec-drift signal (warn, never block) — compare the current
  // spec against the dispatch-time snapshot for this task. specStaleSignals is
  // best-effort (never throws), so the live gate never fails on freshness grounds.
  const specStale = (hi: HookInput): string[] =>
    hi.taskId ? specStaleSignals(cwd(), hi.taskId, readLocalSpec(cwd())) : [];
  const result = evaluateHook(input, () => process.env, policy, specStale);
  // presentDecision emits the structured Claude "ask" envelope for PreToolUse approvals while
  // keeping the exit-code veto (2) correct for block / require_approval on every engine.
  const { json, exitCode } = antigravity
    ? presentAntigravityDecision(result)
    : presentDecision(result, input, buildVerifyGate(cwd()));
  out("vf", json);
  // #542: mirror the decision onto the durable "hook" logbus channel (until now a
  // defined-but-unused channel). Keeps the existing hook-audit.log; adds the ordered
  // stream so a run's hook decisions interleave with dispatch/verdict events.
  try {
    out("hook", `${input.event}: ${result.decision} (${result.risk})`, {
      level: "info",
      unit: input.taskId,
      meta: { kind: "hook", decision: result.decision, risk: result.risk },
    });
  } catch {
    /* never fail the gate on a logging error */
  }

  // Web UI approval path (issue #462): when require_approval and UI is running
  if (result.decision === "require_approval") {
    const base = cwd();
    const uiPortFile = join(base, CTX_DIR, ".ui-port");
    if (existsSync(uiPortFile)) {
      let uiPort: number | null = null;
      try {
        const data = JSON.parse(readFileSync(uiPortFile, "utf8")) as { port?: unknown };
        uiPort = typeof data.port === "number" ? data.port : null;
      } catch {
        /* ignore */
      }
      if (uiPort) {
        const hookMode = process.env.VF_HOOK_MODE ?? "default"; // yolo | auto-pilot | default
        const auditPath = join(base, CTX_DIR, "knowledge", "hook-audit.log");
        const appendAudit = (entry: object) => {
          try {
            appendFileSync(auditPath, `${JSON.stringify(entry)}\n`);
          } catch {
            /* best-effort */
          }
        };
        if (hookMode === "yolo" || hookMode === "allow-all") {
          appendAudit({
            mode: hookMode,
            decision: "allow",
            input,
            result,
            at: new Date().toISOString(),
          });
          out(
            "vf",
            JSON.stringify({
              decision: "allow",
              risk: result.risk,
              reasons: ["auto-allowed: yolo mode"],
            }),
          );
          return 0;
        }
        // default: POST pending, long-poll for user click
        const id = randomUUID();
        const serverBase = `http://127.0.0.1:${uiPort}`;
        try {
          // Register this hook with the server so UI can poll it
          await fetch(`${serverBase}/api/hook/pending`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id, input, result }),
          });
        } catch {
          /* server may not be up */
        }
        // Long-poll — no timeout, waits for user click
        try {
          const res = await fetch(`${serverBase}/api/hook/response/${id}`);
          const { decision: userDecision } = (await res.json()) as { decision: string };
          out(
            "vf",
            JSON.stringify({ decision: userDecision, risk: result.risk, reasons: result.reasons }),
          );
          return userDecision === "allow" ? 0 : 2;
        } catch {
          /* fall through to original exitCode */
        }
      }
    }
  }

  return exitCode;
}

/** Where the dogfood self-test report lands — knowledge/ survives checkpoint gitignore. */
const SELFCHECK_REL = `${CTX_DIR}/knowledge/hook-selfcheck.json`;

/**
 * `vf hook --selftest` (item 3): run the FIXED attack+benign corpus through the real decision
 * path with NO engine spawn, write an auditable report to .vibeflow/knowledge/hook-selfcheck.json,
 * and return 0 only when every case holds (each attack blocked, each benign allowed). A regression
 * returns nonzero. `now`/`base` are injectable so tests stay deterministic and never dirty the repo.
 */
export function hookSelftest(
  inject: {
    base?: string;
    now?: () => string;
    // Test seam: inject a custom runSelftest to simulate regressions
    // (i.e. report.failed > 0) for the failure-branch coverage at
    // line 2068-2069.
    runSelftest?: (now: () => string) => SelftestReport;
  } = {},
): number {
  const base = inject.base ?? cwd();
  const now = inject.now ?? (() => new Date().toISOString());
  const report = (inject.runSelftest ?? runSelftest)(now);
  writeFileSafe(join(base, SELFCHECK_REL), JSON.stringify(report, null, 2));
  for (const c0 of report.cases) {
    const mark = c0.pass ? c.green("✓") : c.red("✗");
    out("vf", `${mark} [${c0.expected}→${c0.actual}] ${c0.risk} · ${c0.input}`);
  }
  if (report.failed > 0) {
    out("vf");
    out("vf", c.red(`${report.failed}/${report.cases.length} self-test case(s) regressed.`), {
      level: "error",
    });
    return 1;
  }
  out(
    "vf",
    c.green(`\nhook self-test: ${report.passed}/${report.cases.length} pass → ${SELFCHECK_REL}`),
  );
  return 0;
}

export function installHooks(base?: string): number {
  const dir = base ?? cwd();
  // Write the portable .githooks/* files first, THEN point git at them. Only the
  // git-level hooks (pre-commit/post-checkout/post-merge) — engine configs like
  // .claude/settings.json stay behind `emit --yes` because they hot-reload a live
  // PreToolUse hook into a running agent.
  for (const [rel, content] of Object.entries(engineHookFiles())) {
    if (!rel.startsWith(".githooks/")) continue;
    const dest = join(dir, rel);
    writeFileSafe(dest, content);
    try {
      chmodSync(dest, 0o755);
    } catch {
      /* best-effort: non-POSIX filesystems may not support the exec bit */
    }
  }
  // PR28 audit Task 7 (M3): the old code only printed a green success line when
  // git exited 0. On non-zero exit (not a git repo, read-only filesystem, missing
  // .githooks dir, etc.) it silently returned the bad status — the user saw
  // nothing. Now we surface the git stderr AND a hint about the most likely cause.
  // The stdio is still "inherit" for stdout so the git output stays visible in
  // CI / scripted invocations; we just need to know when it FAILED.
  const r = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
    cwd: dir,
    stdio: ["ignore", "inherit", "pipe"],
  });
  const status = r.status ?? 0;
  if (status === 0) {
    out("vf", c.green("Installed: core.hooksPath → .githooks"));
    out("vf");
    out("vf", liveGuardrailArmed(dir) ? c.green("live guardrail: ON") : guardrailOffNote());
    return 0;
  }
  // Failure: surface stderr + likely cause. The hint text is intentionally generic —
  // the most common failure in this codebase is "not a git repo" (this command is
  // sometimes run from a fresh clone before `git init`), followed by "filesystem is
  // read-only" (CI on a release branch) and "permission denied on .git/config".
  const stderr = r.stderr?.toString()?.trim() ?? "";
  out(
    "vf",
    c.red(
      `git config core.hooksPath failed (status ${status}). ${stderr ? `git said: ${stderr}. ` : ""}Are you inside a git repo with write access to .git/config?`,
    ),
    { level: "error" },
  );
  return status;
}

/** Project-relative paths to engine-owned settings files that must be merged. */
const CLAUDE_SETTINGS_REL = ".claude/settings.json";
const ANTIGRAVITY_HOOKS_REL = ".agents/hooks.json";

/**
 * Merge the generated `hooks` block into an EXISTING `.claude/settings.json`,
 * preserving every other key (permissions, model, env, …). Unlike the three
 * VibeFlow-owned hook files (.codex/, .github/hooks/, .githooks/), this file is
 * Claude Code's own user/project settings — a wholesale overwrite would silently
 * destroy a user's unrelated config (the data-loss bug this guards against).
 *
 * Mirrors writeClaudeMcp's posture: a corrupt existing file is LEFT UNTOUCHED
 * (returns null) so we never clobber JSON we can't safely read; the caller then
 * skips that file and warns. `generated` is the full claudeHookConfig() string;
 * only its top-level `hooks` key is taken.
 */
function mergeClaudeSettings(absPath: string, generated: string): string | null {
  const incoming = JSON.parse(generated) as { hooks: unknown };
  if (!existsSync(absPath)) return JSON.stringify(incoming, null, 2);
  let existing: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(absPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    existing = parsed as Record<string, unknown>;
  } catch {
    return null; // not valid JSON — refuse to overwrite (fail-safe for user data)
  }
  return JSON.stringify({ ...existing, hooks: incoming.hooks }, null, 2);
}

/** Merge only VibeFlow's named Antigravity hook, preserving every other top-level key. */
function mergeAntigravityHooks(absPath: string, generated: string): string | null {
  const incoming = JSON.parse(generated) as Record<string, unknown>;
  if (!existsSync(absPath)) return JSON.stringify(incoming, null, 2);
  try {
    const existing = JSON.parse(readFileSync(absPath, "utf8")) as unknown;
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) return null;
    return JSON.stringify({ ...existing, ...incoming }, null, 2);
  } catch {
    return null;
  }
}

/**
 * Merge the generated codex hooks block into an EXISTING `~/.codex/hooks.json`,
 * preserving every unrelated top-level and hooks key. Only PreToolUse and
 * PostToolUse are overwritten. Malformed existing JSON → return null (caller
 * skips and warns).
 */
function mergeCodexHooks(absPath: string, generated: string): string | null {
  const incoming = JSON.parse(generated) as {
    hooks: { PreToolUse?: unknown[]; PostToolUse?: unknown[] };
  };
  if (!existsSync(absPath)) return JSON.stringify(incoming, null, 2);
  let existing: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(absPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    existing = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const existingHooks =
    existing.hooks && typeof existing.hooks === "object" && !Array.isArray(existing.hooks)
      ? { ...(existing.hooks as Record<string, unknown>) }
      : {};
  return JSON.stringify(
    {
      ...existing,
      hooks: {
        ...existingHooks,
        PreToolUse: incoming.hooks.PreToolUse,
        PostToolUse: incoming.hooks.PostToolUse,
      },
    },
    null,
    2,
  );
}

/**
 * Idempotently ensure `[features] codex_hooks = true` in
 * `homedir()/.codex/config.toml` with minimal string editing.
 * Preserves all unrelated content. No-op if already `true`.
 */
function ensureCodexFeaturesToml(codexHome?: string): void {
  const home = codexHome ?? homedir();
  const configPath = join(home, ".codex", "config.toml");
  if (!existsSync(configPath)) {
    writeFileSafe(configPath, "[features]\ncodex_hooks = true");
    return;
  }
  const raw = readFileSync(configPath, "utf8");
  if (/codex_hooks\s*=\s*true/.test(raw)) return;
  if (/codex_hooks\s*=/.test(raw)) {
    writeFileSafe(configPath, raw.replace(/\bcodex_hooks\s*=\s*[^\n]+/, "codex_hooks = true"));
    return;
  }
  if (/\[features\]/.test(raw)) {
    writeFileSafe(configPath, raw.replace(/(\[features\])/, "$1\ncodex_hooks = true"));
    return;
  }
  const sep = raw.endsWith("\n") ? "" : "\n";
  writeFileSafe(configPath, `${raw}${sep}[features]\ncodex_hooks = true`);
}

/**
 * Write every engine hook config into `base`, all delegating to `vf hook`, and
 * chmod the shell git hooks executable. Returns the relative paths written.
 *
 * `.claude/settings.json` is Claude Code's SHARED settings file, so its `hooks`
 * key is MERGED into any existing file (preserving permissions/model/env); a
 * corrupt existing file is left untouched and skipped with a warning. The other
 * files are VibeFlow-owned and written wholesale.
 *
 * Shared by `vf hooks emit --yes` and the `vf init` hooks step so the two paths
 * can never drift. CALLER OWNS CONSENT: writing .claude/settings.json hot-reloads
 * a PreToolUse hook into a running agent, so only invoke this after an explicit
 * --yes / interactive opt-in.
 */
export function emitHookFiles(base: string, engines?: Engine[], codexHome?: string): string[] {
  const files = engineHookFiles(engines);
  const written: string[] = [];
  const hasCodex = ".codex/hooks.json" in files;
  if (hasCodex) {
    out(
      "vf",
      c.yellow(
        "! codex: writes to ~/.codex/hooks.json and ~/.codex/config.toml — GLOBAL, affects every repo using Codex on this machine, not just this one.",
      ),
    );
  }
  for (const [rel, content] of Object.entries(files)) {
    if (rel === ".codex/hooks.json") {
      const home = codexHome ?? homedir();
      const dest = join(home, ".codex", "hooks.json");
      const merged = mergeCodexHooks(dest, content);
      if (merged === null) {
        out("vf", c.yellow(`! ${rel} is not valid JSON — left untouched. Fix it, then re-run.`), {
          level: "error",
        });
        continue;
      }
      writeFileSafe(dest, merged);
      ensureCodexFeaturesToml(codexHome);
      written.push("~/.codex/hooks.json");
      continue;
    }
    const dest = join(base, rel);
    if (rel === CLAUDE_SETTINGS_REL || rel === ANTIGRAVITY_HOOKS_REL) {
      const merged =
        rel === CLAUDE_SETTINGS_REL
          ? mergeClaudeSettings(dest, content)
          : mergeAntigravityHooks(dest, content);
      if (merged === null) {
        out("vf", c.yellow(`! ${rel} is not valid JSON — left untouched. Fix it, then re-run.`), {
          level: "error",
        });
        continue;
      }
      writeFileSafe(dest, merged);
      written.push(rel);
      continue;
    }
    writeFileSafe(dest, content);
    // Git only runs hooks under core.hooksPath if they're executable — chmod the shell hooks.
    if (rel.startsWith(".githooks/")) {
      try {
        chmodSync(dest, 0o755);
      } catch {
        /* best-effort: non-POSIX filesystems may not support the bit */
      }
    }
    written.push(rel);
  }
  return written;
}

/**
 * Persist a chosen hook policy to SETTINGS.json AND write the engine hook configs
 * that arm the live guardrail. Used by `vf init`'s interactive hooks step. Returns
 * the engine config paths written so the caller can report them.
 *
 * Order matters: SETTINGS is written FIRST so that the instant the engine configs
 * land (and a watching agent hot-reloads its PreToolUse hook), the very next
 * `vf hook` invocation already reads the intended policy — never a stale all-on.
 */
export function armHooks(base: string, config: HookConfig, engines?: Engine[]): string[] {
  writeSettings(base, { hooks: config });
  return emitHookFiles(base, engines);
}

export function hooks(
  sub: string | undefined,
  flags: Record<string, string | boolean> = {},
  emit: typeof emitHookFiles = emitHookFiles,
): number {
  switch (sub) {
    case "install":
      return installHooks();
    case undefined:
    case "status": {
      const r = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" });
      const path = r.stdout.trim();
      out(
        "vf",
        path
          ? `core.hooksPath = ${path}`
          : c.yellow("core.hooksPath not set — run `vf hooks install`"),
      );
      // The live per-tool-call guardrail only exists if .claude/settings.json delegates a
      // PreToolUse hook to `vf hook`. Report it LOUDLY — a silent "OFF" reads as "protected".
      out("vf");
      out("vf", liveGuardrailArmed(cwd()) ? c.green("live guardrail: ON") : guardrailOffNote());
      return 0;
    }
    case "emit": {
      const files = engineHookFiles();
      // Default to a DRY RUN: writing .claude/settings.json hot-reloads a PreToolUse hook
      // into the running agent, so never overwrite engine configs without explicit --yes.
      if (!flags.yes || flags["dry-run"]) {
        for (const rel of Object.keys(files)) {
          const display = rel === ".codex/hooks.json" ? "~/.codex/hooks.json" : rel;
          out("vf", `${c.dim("[dry-run]")} ${display}`);
        }
        if (".codex/hooks.json" in files) {
          out(
            "vf",
            c.yellow(
              "! codex: writes to ~/.codex/hooks.json and ~/.codex/config.toml — GLOBAL, affects every repo using Codex on this machine, not just this one.",
            ),
          );
        }
        out(
          "vf",
          c.yellow(
            ".claude/settings.json installs a PreToolUse hook that affects the running agent.",
          ),
        );
        out("vf", c.dim("Re-run with --yes to write."));
        return 0;
      }
      // --yes: write per-engine hook configs into the active repo, all delegating to `vf hook`.
      for (const rel of emit(cwd())) {
        out("vf", `${c.green("+")} ${rel}`);
      }
      return 0;
    }
    default:
      out("vf", c.red(`Unknown: vf hooks ${sub}`), {
        level: "error",
      });
      return 2;
  }
}
