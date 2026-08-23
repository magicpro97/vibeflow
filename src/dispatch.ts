import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import {
  CTX_DIR,
  type Engine,
  cwd,
  hasCommand,
  resolveCommand,
  sanitizeUnitName,
  writeFileSafe,
} from "./core.js";
import { parseEngineSummary, parseSessionId } from "./dispatch/prompt.js";
import {
  buildPublicDispatchResult,
  persistPublicDispatchEvidence,
  requireSafeNativeSessionId,
} from "./dispatch/public-redaction.js";
import {
  defaultAsyncSpawner,
  defaultSpawner,
  defaultSyncSpawner,
  makeAsyncSpawner,
} from "./dispatch/spawners.js";
import type {
  AsyncSpawner,
  DispatchResult,
  EngineCommandResult,
  EngineProbe,
  EngineUnavailable,
  Spawner,
  SyncResult,
} from "./dispatch/types.js";

// Re-export the full public surface so the 13 importers are unchanged
export type {
  AsyncSpawner,
  AsyncSpawnerOpts,
  DispatchResult,
  EngineCommandResult,
  EngineProbe,
  EngineSummary,
  EngineUnavailable,
  Spawner,
  SyncResult,
} from "./dispatch/types.js";
export {
  defaultAsyncSpawner,
  defaultSpawner,
  defaultSyncSpawner,
  makeAsyncSpawner,
} from "./dispatch/spawners.js";
export { buildEnginePrompt, parseEngineSummary, parseSessionId } from "./dispatch/prompt.js";

export function isUnavailable(r: EngineCommandResult): r is EngineUnavailable {
  return "unavailable" in r;
}

/** Best-effort read of `copilot --version` (lightweight; used only for the version guard).
 *  Issue #88: on Windows copilot is an npm binstub installed as `copilot.cmd` (or `.bat`).
 *  `Bun.which` returns the .cmd path and CreateProcess cannot execute .cmd shims
 *  directly — direct `Bun.spawnSync([resolved, "--version"])` fails with ENOENT
 *  "uv_spawn 'copilot.cmd'". Route through `defaultSyncSpawner` so we get the
 *  same `cmd.exe /c copilot --version` wrapping the dispatch path already uses
 *  (M2 parity; fix mirrors the auto-shell added in PR28 audit Task 4). */
function copilotVersion(cmd = "copilot"): string | undefined {
  try {
    const r = defaultSyncSpawner(cmd, ["--version"], "");
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {
    /* fall through to undefined */
  }
  return undefined;
}

interface DispatchOpts {
  engine: Engine;
  prompt: string;
  mode: "bridge" | "cli" | "dry";
  bridgeCmd?: string;
  /** Injectable PATH-presence probe so tests can force absent without spawning a real engine. */
  has?: (cmd: string) => boolean;
  /**
   * Work-unit name for file-based copilot dispatch (#526 item 7). When set and the
   * resolved engine takes its prompt via argv (copilot, promptMode "arg"), the
   * prompt is written to `.vibeflow/dispatch/<unit>.md` and a short pointer arg is
   * passed instead — sidestepping copilot's ~32K argv limit. claude/codex read
   * stdin and are untouched.
   */
  unit?: string;
  /** Repo root for the dispatch file (defaults to cwd()). */
  base?: string;
  /** Test seam: injected writer so unit tests capture the dispatch file without real FS. */
  writeDispatchFile?: (path: string, content: string) => void;
  /**
   * Bridge-mode stderr sink. The async path streams stderr
   * per-chunk via the spawner's onStderrChunk; the bridge path
   * uses Bun.spawnSync and can only emit the full stderr after
   * the process exits. Callers wire this to the same logbus
   * channel so both paths are visible.
   */
  onStderrChunk?: (text: string) => void;
  /** #618 PR2a: resume the engine's prior session (claude only) instead of a fresh
   *  dispatch. Absent = fresh (default). codex/copilot ignore it until PR2b. */
  resumeSessionId?: string;
}

/**
 * Copilot's CLI takes the prompt as an argv arg (promptMode "arg"), but argv is
 * capped at ~32K, so large prompts fail (documented at ai-init/run.ts:211).
 * #526 item 7: write the assembled prompt to `.vibeflow/dispatch/<unit>.md` and
 * return a SHORT pointer prompt for copilot to read instead. Bounded regardless
 * of the real prompt size (the whole point). `unit` is untrusted (planner/LLM
 * origin), so it is sanitized against path traversal via sanitizeUnitName.
 */
export function writeDispatchPrompt(
  unit: string,
  prompt: string,
  opts: { base?: string; writeFile?: (path: string, content: string) => void } = {},
): string {
  const rel = `${CTX_DIR}/dispatch/${sanitizeUnitName(unit)}.md`;
  // Absolute path: copilot resolves the pointer against ITS cwd, which is not
  // always `base` (e.g. `--isolate` runs the engine in a worktree; the server
  // orchestrates a registered repo ≠ process.cwd()). A relative pointer would
  // then miss the file and copilot would silently run on an empty prompt — worse
  // than the pre-#526 loud argv-limit failure. An absolute pointer is cwd-safe.
  const base = opts.base ?? cwd();
  const abs = base.startsWith("/") ? `${base.replace(/\/+$/, "")}/${rel}` : join(base, rel);
  (opts.writeFile ?? writeFileSafe)(abs, prompt);
  return `Read ${abs.replace(/\\/g, "/")} and follow it`;
}

/** Prompt actually fed to materializePrompt: the short file-pointer for copilot
 *  (when a unit name is supplied), else the prompt unchanged. */
function preparePrompt(cli: { promptMode?: "stdin" | "arg" }, opts: DispatchOpts): string {
  if (opts.engine === "antigravity") return opts.prompt;
  if (cli.promptMode !== "arg" || opts.unit === undefined) return opts.prompt;
  return writeDispatchPrompt(opts.unit, opts.prompt, {
    base: opts.base,
    writeFile: opts.writeDispatchFile,
  });
}

function copilotCommand(probe: EngineProbe): EngineCommandResult {
  const has = probe.has ?? hasCommand;
  if (!has("copilot")) {
    return {
      unavailable: "copilot CLI not found — install GitHub Copilot CLI then re-run",
    };
  }
  // Version guard: the Copilot CLI has a history of silent breaking auto-updates
  // (github/copilot-cli#1606 removed `--headless --stdio`). If we cannot determine the
  // version we proceed but surface a warning so the caller can message the user.
  const version = (probe.version ?? copilotVersion)("copilot");
  const warning = version
    ? undefined
    : "could not determine `copilot --version`; verify `copilot -p` still works (github/copilot-cli#1606)";
  // `--allow-all` is the omnibus permission flag — it covers
  // --allow-all-tools, --allow-all-paths, AND --allow-all-urls.
  // Without --allow-all-urls, the engine hits "Permission denied
  // and could not request permission from user" when it tries
  // to fetch any URL (e.g. GitHub API for `gh auth status`,
  // docs lookup, MCP server handshakes). The individual
  // --allow-all-* flags are still listed in the help text but
  // --allow-all is the supported umbrella as of copilot 0.3+.
  return {
    cmd: "copilot",
    args: ["-p", "--allow-all"],
    promptMode: "arg",
    warning,
  };
}

/**
 * Headless invocation per engine (verified against current CLI docs):
 *   claude          -> claude -p --output-format json            (fresh)
 *   claude (resume) -> claude -p -r <id> --output-format json   (#618 PR2a)
 *   codex           -> codex exec -                              (stdin prompt)
 *   copilot         -> copilot -p <prompt> --allow-all-tools
 * Claude and Codex receive the prompt on stdin; Copilot's current CLI requires it as the
 * `-p/--prompt` option value, so we pass it as a single argv element without a shell.
 * `gh -p` is NOT a valid fallback (gh has no global -p flag) so copilot resolves to an explicit
 * unavailability when the binary is absent rather than a bogus command.
 */
export function engineCommand(
  engine: Engine,
  probe: EngineProbe = {},
  /** When true, append the permissive flag (--dangerously-skip-permissions for
   *  Claude, --allow-all for Copilot already present). Used in AI init /
   *  workflow dispatch to avoid permission-denial stalls (eccho 2026-06-18). */
  dangerouslySkipPermissions = false,
  /** #618 PR2a: when set AND engine supports resume (claude only in PR2a), the
   *  invocation resumes that session instead of starting fresh. codex/copilot
   *  ignore this until PR2b. */
  resumeSessionId?: string,
): EngineCommandResult {
  if (resumeSessionId) requireSafeNativeSessionId(engine, resumeSessionId);
  switch (engine) {
    case "claude": {
      // #618 PR2a: `-r <id>` resumes a session (claude requires it alongside -p/--print).
      const args = resumeSessionId
        ? ["-p", "-r", resumeSessionId, "--output-format", "json"]
        : ["-p", "--output-format", "json"];
      if (dangerouslySkipPermissions) {
        args.push("--dangerously-skip-permissions");
      }
      return { cmd: "claude", args };
    }
    case "codex":
      // #618 PR2b-2: `--json` enables JSONL output (thread_id + summary);
      // `resume <id>` continues a crashed session. Prompt stays on stdin (`-`).
      return resumeSessionId
        ? { cmd: "codex", args: ["exec", "resume", resumeSessionId, "--json", "-"] }
        : { cmd: "codex", args: ["exec", "--json", "-"] };
    case "copilot":
      return copilotCommand(probe);
    case "opencode":
      return {
        cmd: "opencode",
        args: ["run", "--format", "json", "--auto", "-"],
        promptMode: "stdin",
      };
    case "antigravity":
      return resumeSessionId
        ? { cmd: "agy", args: ["--conversation", resumeSessionId, "-p"], promptMode: "arg" }
        : { cmd: "agy", args: ["-p"], promptMode: "arg" };
  }
}

/** Resolve the CLI command for an engine, honouring an injected spawner (test mode). */
function resolveCli(
  engine: Engine,
  hasSpawner: boolean,
  has: (cmd: string) => boolean = hasCommand,
  /** #618 PR2a: resume session id forwarded to engineCommand (claude only). */
  resumeSessionId?: string,
):
  | { ok: true; cmd: string; args: string[]; promptMode?: "stdin" | "arg"; warning?: string }
  | { ok: false; reason: string } {
  // With an injected spawner we never touch the real PATH, so treat the engine as present.
  const invocation = engineCommand(
    engine,
    hasSpawner ? { has: () => true } : { has },
    false,
    resumeSessionId,
  );
  if (isUnavailable(invocation)) return { ok: false, reason: invocation.unavailable };
  if (!hasSpawner && !has(invocation.cmd)) {
    return { ok: false, reason: `${invocation.cmd} CLI not found` };
  }
  return {
    ok: true,
    cmd: hasSpawner ? invocation.cmd : (resolveCommand(invocation.cmd) ?? invocation.cmd),
    args: invocation.args,
    promptMode: invocation.promptMode,
    warning: invocation.warning,
  };
}

function bridgeCommand(opts: DispatchOpts): string | undefined {
  return opts.bridgeCmd ?? process.env.VIBEFLOW_AI;
}

export function materializePrompt(
  cli: { cmd: string; args: string[]; promptMode?: "stdin" | "arg" },
  prompt: string,
): { cmd: string; args: string[]; input: string } {
  const normCmd = cli.cmd.replace(/\\/g, "/");
  if (
    basename(normCmd, extname(normCmd)) === "agy" &&
    Buffer.byteLength(prompt, "utf8") >= 30 * 1024
  ) {
    throw new Error("Antigravity prompt too large for agy argv; shorten or split the task");
  }
  if (cli.promptMode !== "arg") return { cmd: cli.cmd, args: cli.args, input: prompt };
  const promptFlag = cli.args.findIndex((arg) => arg === "-p" || arg === "--prompt");
  if (promptFlag === -1) return { cmd: cli.cmd, args: [...cli.args, prompt], input: "" };
  const args = [...cli.args];
  args.splice(promptFlag + 1, 0, prompt);
  return { cmd: cli.cmd, args, input: "" };
}

/**
 * Dispatch a prompt to an engine (synchronous).
 *  - mode "bridge": pipe to $VIBEFLOW_AI (default, engine-agnostic, offline-friendly)
 *  - mode "cli":    shell out to the real engine CLI (opt-in)
 *  - mode "dry":    write the prompt only; run nothing
 */
export function runDispatch(opts: DispatchOpts & { spawner?: Spawner }): DispatchResult {
  const { engine, prompt, mode } = opts;
  const attemptId = randomUUID();
  const spawn = opts.spawner ?? defaultSpawner;
  if (mode === "dry") return { attemptId, engine, mode, ok: true, raw: "" };
  if (mode === "bridge") {
    const cmd = bridgeCommand(opts);
    if (!cmd) {
      return { attemptId, engine, mode, ok: false, raw: "", reason: "VIBEFLOW_AI is not set" };
    }
    // VIBEFLOW_AI is a shell command string (may include args) — spawn via shell unless a
    // test injected its own spawner.
    const bridgeSpawn =
      opts.spawner ??
      ((c: string, a: string[], input: string): SyncResult => {
        const shell =
          process.platform === "win32" ? ["cmd.exe", "/c", c, ...a] : ["/bin/sh", "-c", c];
        const r = Bun.spawnSync(shell, {
          stdin: Buffer.from(input, "utf8"),
          stdout: "pipe",
          stderr: "pipe",
        });
        // Bridge path can't stream stderr per-chunk; emit the full
        // content through the same sink the async path uses (PR28
        // audit Task 7 / M5).
        const stderrText = r.stderr.toString();
        if (stderrText) opts.onStderrChunk?.(stderrText);
        return { status: r.exitCode, stdout: r.stdout.toString(), stderr: stderrText };
      });
    return buildPublicDispatchResult(
      opts,
      bridgeSpawn(cmd, [], prompt),
      "bridge command failed",
      undefined,
      attemptId,
    );
  }
  const cli = resolveCli(engine, Boolean(opts.spawner), opts.has, opts.resumeSessionId);
  if (!cli.ok) return { attemptId, engine, mode, ok: false, raw: "", reason: cli.reason };
  const invocation = materializePrompt(cli, preparePrompt(cli, opts));
  return buildPublicDispatchResult(
    opts,
    spawn(invocation.cmd, invocation.args, invocation.input),
    `${cli.cmd} failed`,
    cli.warning,
    attemptId,
  );
}

/**
 * Async variant of {@link runDispatch} for the parallel path: uses a non-blocking spawn so
 * lanes genuinely overlap under {@link runParallel} (spawnSync would serialize them). The
 * injectable {@link AsyncSpawner} keeps it testable without launching real engines.
 */
export async function runDispatchAsync(
  opts: DispatchOpts & { spawner?: AsyncSpawner },
): Promise<DispatchResult> {
  const { engine, prompt, mode } = opts;
  const attemptId = randomUUID();
  const spawn = opts.spawner ?? defaultAsyncSpawner;
  if (mode === "dry") return { attemptId, engine, mode, ok: true, raw: "" };
  if (mode === "bridge") {
    const cmd = bridgeCommand(opts);
    if (!cmd) {
      return { attemptId, engine, mode, ok: false, raw: "", reason: "VIBEFLOW_AI is not set" };
    }
    // VIBEFLOW_AI is a shell command string (may include args), consistent with aiGenerate's
    // shell:true spawn. Use a shell-aware spawner unless a test injected its own.
    const bridgeSpawn = opts.spawner ?? makeAsyncSpawner({ shell: true });
    return buildPublicDispatchResult(
      opts,
      await bridgeSpawn(cmd, [], prompt),
      "bridge command failed",
      undefined,
      attemptId,
    );
  }
  const cli = resolveCli(engine, Boolean(opts.spawner), opts.has, opts.resumeSessionId);
  if (!cli.ok) return { attemptId, engine, mode, ok: false, raw: "", reason: cli.reason };
  const invocation = materializePrompt(cli, preparePrompt(cli, opts));
  return buildPublicDispatchResult(
    opts,
    await spawn(invocation.cmd, invocation.args, invocation.input),
    `${cli.cmd} failed`,
    cli.warning,
    attemptId,
  );
}

/** Persist a dispatch result as evidence inside a work unit's `evidence/` folder. */
export function persistDispatch(unitDir: string, result: DispatchResult): string {
  return persistPublicDispatchEvidence(unitDir, result);
}
