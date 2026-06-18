// size-waiver: #186 — dispatch.ts split into dispatch/{resolve,materialize,spawn,bridge}; see issue #186
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import type { ProjectContext, UnitBrief } from "./adapters.js";
import { dispatchPrompt } from "./adapters.js";
import { type Engine, hasCommand, resolveCommand, writeFileSafe } from "./core.js";

// Re-export of `Bun.spawn` under a stable name so the test seam (`AsyncSpawnerOpts.spawn`)
// can be typed as `typeof bunSpawn` and tests can pass any function with the same
// signature. We resolve `Bun.spawn` lazily on each call so tests that temporarily
// replace `Bun.spawn` (e.g. the Windows shim auto-shell tests) still hit the mock —
// binding once would freeze the reference and bypass the mock. Production callers
// never see the seam.
const bunSpawn = ((...args: unknown[]) =>
  (Bun.spawn as (...a: any[]) => any)(...args)) as unknown as typeof Bun.spawn;

// Confidence fallback for engine runs with no JSON summary block
const MIN_PRODUCTIVE_TURNS = 3;
const HIGH_PRODUCTIVE_TURNS = 10;
const CONFIDENCE_PRODUCTIVE = 0.85;
const CONFIDENCE_MODERATE = 0.7;
/** Structured summary an engine is asked to emit at the end of a dispatch. */
export interface EngineSummary {
  skills_used?: string[];
  files_changed?: string[];
  commands_run?: string[];
  tests_run?: string[];
  confidence?: number;
  uncertainty?: string;
}

export interface DispatchResult {
  engine: Engine;
  mode: "bridge" | "cli" | "dry";
  ok: boolean;
  raw: string;
  summary?: EngineSummary;
  reason?: string;
  /** Non-fatal advisory (e.g. an unverifiable Copilot CLI version). */
  warning?: string;
}

export type Spawner = (
  cmd: string,
  args: string[],
  input: string,
) => { status: number; stdout: string; stderr?: string };

/** Sync spawn result — `stderr` is captured (M2 parity) so error output never leaks to TTY. */
export interface SyncResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Async spawn seam: genuinely overlapping process launches for the parallel path.
 *  Test seams may omit fields that production never inspects (e.g. `stderr`); the in-process
 *  chain only requires status + stdout for the dispatch contract.
 *
 *  `stderr` is optional so existing tests that only construct `{ status, stdout }` keep
 *  compiling — but production code that needs to inspect stderr (e.g. rate-limit
 *  detection in `defaultAiInitDispatcher`) should pass an `onStderrChunk` hook on
 *  `AsyncSpawnerOpts` and the spawner will accumulate it onto the returned object. */
export type AsyncSpawner = (
  cmd: string,
  args: string[],
  input: string,
) => Promise<{ status: number; stdout: string; stderr?: string; timedOut?: boolean }>;

export interface AsyncSpawnerOpts {
  timeoutMs?: number;
  graceMs?: number;
  shell?: boolean;
  /** Called for each stdout chunk (engine progress / tool output). */
  onChunk?: (text: string) => void;
  /** M2: called for each stderr chunk (engine warnings, errors, progress noise).
   *  Bytes that used to inherit the parent TTY now flow through this hook so the logbus
   *  is the SOLE destination — the bus owns user-facing visibility. */
  onStderrChunk?: (text: string) => void;
  /** M2: kill process if no stdout/stderr received within this window (resets on each chunk). */
  idleTimeoutMs?: number;
  /** Test seam: inject a fake spawner (compatible with `Bun.spawn`'s argv + opts signature)
   *  to exercise the spawner without launching real subprocesses. Production callers must
   *  omit this; the spawner falls back to `Bun.spawn` (which now runs `detached: true` on
   *  POSIX so the engine + its tool children share a process group that we can kill
   *  together). */
  spawn?: typeof bunSpawn;
}

// Test seam: exported so unit tests can exercise the function body
// (line 67-68) by mocking Bun.spawnSync.
export function defaultSpawner(
  cmd: string,
  args: string[],
  input: string,
  inject: { spawnSync?: (cmd: string, args: string[], input: string) => SyncResult } = {},
): SyncResult {
  const _spawnSync = inject.spawnSync ?? defaultSyncSpawner;
  return _spawnSync(cmd, args, input);
}

/** Test seam: a sync spawner that pipes stderr (M2 parity with the async path) and detects
 *  Windows .cmd/.bat shims (Task 4 audit fix: previously, `defaultSpawner` used `Bun.spawnSync`
 *  without `stderr: "pipe"`, leaking the child's stderr to the parent TTY; and without the
 *  Windows shim auto-detect that `makeAsyncSpawner` performs, the sync path failed with
 *  `ENOENT` on `copilot.cmd` and similar npm shims). */
export function defaultSyncSpawner(cmd: string, args: string[], input: string): SyncResult {
  const resolvedCmd = resolveCommand(cmd) ?? cmd;
  const needsShell = shouldUseWindowsShell(cmd, resolvedCmd);
  const spawnArgs = needsShell
    ? process.platform === "win32"
      ? ["cmd.exe", "/c", cmd, ...args]
      : ["/bin/sh", "-c", [cmd, ...args].join(" ")]
    : [cmd, ...args];
  // Pipe stderr so child error output is captured in the result (M2) and never leaks to the
  // parent TTY. Previously `Bun.spawnSync([cmd, ...args], { ..., stdout: "pipe" })` only piped
  // stdout — `stderr` defaulted to inherit on Bun under some versions, leaking engine errors
  // (e.g. Claude / Codex JSON parse failures) directly to the user's terminal.
  const r = Bun.spawnSync(spawnArgs, {
    stdin: Buffer.from(input, "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/** Exit status surfaced when a hung engine is force-killed by the timeout (matches GNU timeout). */
const TIMEOUT_STATUS = 124;
/** Default grace between SIGTERM and the hard SIGKILL when a process group ignores the term. */
const DEFAULT_GRACE_MS = 3000;

function hasWindowsShimSibling(path: string): boolean {
  if (extname(path)) return false;
  return existsSync(`${path}.cmd`) || existsSync(`${path}.bat`);
}

function shouldUseWindowsShell(cmd: string, resolvedCmd: string): boolean {
  if (process.platform !== "win32") return false;
  if (/\.(?:cmd|bat)$/i.test(resolvedCmd)) return true;
  if (cmd.toLowerCase() === "copilot") return true;
  return hasWindowsShimSibling(resolvedCmd);
}

interface AsyncResult {
  status: number;
  stdout: string;
  /** M2: accumulated stderr — not surfaced through the public AsyncSpawner type, but kept
   *  internally so debug logs can dump it on a non-zero exit. */
  stderr: string;
  timedOut?: boolean;
}

/**
 * Build an async spawner using node child_process.spawn (no shell). Unlike spawnSync it does
 * NOT block the event loop, so multiple lanes truly overlap under the parallel runner. The
 * prompt is written to stdin so we never interpolate it into a shell string.
 *
 * The child is spawned `detached: true` (POSIX) so it becomes its own process group leader;
 * on timeout / cancel we `process.kill(-pid, ...)` the WHOLE group with SIGTERM, then SIGKILL
 * after `graceMs`, so the engine's own tool-subprocesses (Claude's `node` tool processes,
 * Codex's `bash -c` helpers, Copilot's mcp-server children) die too rather than orphaning.
 * On Windows `process.kill(-pid, ...)` is not supported, so we fall back to single-pid
 * `proc.kill(...)` and orphan-subprocess cleanup is best-effort.
 *
 * M2: stderr is now PIPED (not inherited) and routed to {@link AsyncSpawnerOpts.onStderrChunk}.
 * The bus owns the destination — bytes no longer leak to the parent TTY. Order is preserved
 * because each `data` event is dispatched in arrival order on the same event loop tick; the
 * logbus fanout is synchronous, so the bus sees stdout/stderr chunks in the same order the
 * child emitted them.
 */
// Test seam: callers can inject a fake `spawn` to simulate group-kill behavior in unit
// tests without spawning real subprocesses. `onStderrChunk` and `onChunk` are kept on
// opts for back-compat; M2 fanout goes through these callbacks.
export function makeAsyncSpawner(opts: AsyncSpawnerOpts = {}): AsyncSpawner {
  const {
    timeoutMs,
    graceMs = DEFAULT_GRACE_MS,
    idleTimeoutMs,
    shell,
    onChunk,
    onStderrChunk,
  } = opts;
  const _spawn = opts.spawn ?? bunSpawn;
  return async (cmd, args, input): Promise<AsyncResult> => {
    // On Windows, .cmd/.bat shims (e.g. copilot.cmd installed by npm)
    // cannot be executed directly via CreateProcess. Detect and
    // auto-enable shell mode so the existing spawner works without
    // every caller having to pass shell: true. Resolve the command
    // path first; if the resolved path is a .cmd/.bat shim, use
    // shell. The explicit `shell` opt still wins if caller sets it.
    const resolvedCmd = resolveCommand(cmd) ?? cmd;
    const needsShell = shell ?? shouldUseWindowsShell(cmd, resolvedCmd);
    const spawnArgs = needsShell
      ? process.platform === "win32"
        ? ["cmd.exe", "/c", cmd, ...args]
        : ["/bin/sh", "-c", [cmd, ...args].join(" ")]
      : [cmd, ...args];
    // `detached: true` makes the child a process-group leader on POSIX so we can later
    // `process.kill(-pid, ...)` the entire group (engine + its tool children). On Windows
    // detached has no effect on group formation, so we skip it and use single-pid kill.
    const proc = _spawn(spawnArgs, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
      env: { ...process.env },
    });
    try {
      proc.stdin?.write(input);
    } catch (err) {
      // B3: if stdin.write throws (EPIPE / child already exited), kill the
      // child and wait for it to actually exit before re-throwing, otherwise
      // the orphan process keeps running with a closed pipe.
      try {
        proc.kill();
      } catch {
        // Process may have already exited — nothing to kill.
      }
      try {
        await proc.exited;
      } catch {
        // proc.exited can reject if the kill itself fails; swallow so the
        // original stdin error is what the caller sees.
      }
      throw err;
    }
    proc.stdin?.end();

    const stdoutReader = proc.stdout?.getReader();
    const stderrReader = proc.stderr?.getReader();
    const decoder = new TextDecoder();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    let term: Timer | undefined;
    let graceTerm: Timer | undefined;
    // Group-leader pid: the SIGN that the child was spawned detached on POSIX. On Windows
    // there is no group-kill equivalent, so we kill the direct child only.
    const isPosixGroupLeader = process.platform !== "win32" && proc.pid != null;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!isPosixGroupLeader || proc.pid == null) {
        try {
          proc.kill(signal);
        } catch {
          // Process already exited.
        }
        return;
      }
      try {
        // Negative pid = process group (POSIX). Kills the engine AND its tool children.
        process.kill(-proc.pid, signal);
      } catch {
        // Group may already be gone (child exited naturally between SIGTERM and SIGKILL).
        try {
          proc.kill(signal);
        } catch {
          // Best-effort fallback to direct kill.
        }
      }
    };
    const killProc = () => {
      if (timedOut) return;
      timedOut = true;
      killGroup("SIGTERM");
      if (graceMs > 0)
        graceTerm = setTimeout(() => {
          killGroup("SIGKILL");
        }, graceMs);
    };
    if (timeoutMs != null) {
      term = setTimeout(killProc, timeoutMs);
    }

    let idle: Timer | undefined;
    const resetIdle = () => {
      if (idle != null) clearTimeout(idle);
      if (idleTimeoutMs != null) idle = setTimeout(killProc, idleTimeoutMs);
    };
    resetIdle();

    await Promise.all([
      (async () => {
        while (stdoutReader) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          const s = decoder.decode(value);
          onChunk?.(s);
          stdout += s;
          resetIdle();
        }
      })(),
      (async () => {
        while (stderrReader) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          const s = decoder.decode(value);
          stderr += s;
          onStderrChunk?.(s);
          resetIdle();
        }
      })(),
    ]);

    if (term) {
      clearTimeout(term);
    }
    if (idle) {
      clearTimeout(idle);
    }
    const exitCode = await proc.exited;
    if (graceTerm) {
      clearTimeout(graceTerm);
    }
    const status = timedOut ? TIMEOUT_STATUS : (exitCode ?? 1);
    return { status, stdout, stderr, timedOut };
  };
}

/** Default async spawner — {@link makeAsyncSpawner} with no timeout (behavior unchanged). */
const defaultAsyncSpawner: AsyncSpawner = makeAsyncSpawner();

/** Probe seam so engine-availability / version checks are injectable in tests. */
export interface EngineProbe {
  has?: (cmd: string) => boolean;
  version?: (cmd: string) => string | undefined;
}

export interface EngineInvocation {
  cmd: string;
  args: string[];
  /** Copilot CLI requires the prompt as the `-p` option value; other engines read stdin. */
  promptMode?: "stdin" | "arg";
  /** Non-fatal advisory surfaced to the caller (does not block dispatch). */
  warning?: string;
}

export interface EngineUnavailable {
  unavailable: string;
}

export type EngineCommandResult = EngineInvocation | EngineUnavailable;

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

/**
 * Headless invocation per engine (verified against current CLI docs):
 *   claude  -> claude -p --output-format json   (print mode, JSON envelope on stdout)
 *   codex   -> codex exec -                      (non-interactive, `-` reads prompt from stdin)
 *   copilot -> copilot -p <prompt> --allow-all-tools
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
): EngineCommandResult {
  switch (engine) {
    case "claude": {
      const args = ["-p", "--output-format", "json"];
      if (dangerouslySkipPermissions) {
        args.push("--dangerously-skip-permissions");
      }
      return { cmd: "claude", args };
    }
    case "codex":
      return { cmd: "codex", args: ["exec", "-"] };
    case "copilot": {
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
      return { cmd: "copilot", args: ["-p", "--allow-all"], promptMode: "arg", warning };
    }
  }
}

/** Build the dispatch prompt and append the required JSON-summary contract. */
export function buildEnginePrompt(engine: Engine, ctx: ProjectContext, units: UnitBrief[]): string {
  return [
    dispatchPrompt(engine, ctx, units),
    "When finished, emit a single fenced JSON block as the LAST thing you output:",
    "```json",
    '{ "skills_used": [], "files_changed": [], "commands_run": [], "tests_run": [], "confidence": 0.0, "uncertainty": "" }',
    "```",
    "",
  ].join("\n");
}

/** Scan a string for balanced top-level `{...}` objects (string-aware so nested braces work). */
function extractJsonObjects(s: string): string[] {
  const objs: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        objs.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objs;
}

/** Coerce a parsed JSON value into an EngineSummary, unwrapping the claude JSON envelope. */
function asSummary(parsed: unknown): EngineSummary | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  // claude -p --output-format json wraps free-form text in `.result`; the VibeFlow summary
  // is emitted inside that text, so recurse into it first.  Skip empty strings — an empty
  // result means the model didn't return anything useful (e.g. a no-op investigation round).
  if (typeof obj.result === "string" && (obj.result as string).trim() !== "") {
    const inner = parseEngineSummary(obj.result as string);
    if (inner) return inner;
  }
  // `--json-schema` forces a structured object into `.structured_output`.
  if (obj.structured_output && typeof obj.structured_output === "object") {
    return obj.structured_output as EngineSummary;
  }
  if (obj.result && typeof obj.result === "object") return obj.result as EngineSummary;
  // Claude JSON envelope (type: "result", has session_id): the transport layer, not the
  // model's summary text. When result is empty but the model did meaningful work through
  // tool calls (num_turns > 0, success), synthesize evidence from the metadata so the
  // investigation/dispatch loop doesn't lose confidence on a session that was productive.
  if (typeof obj.type === "string" && obj.type === "result" && "session_id" in obj) {
    const turns = typeof obj.num_turns === "number" ? obj.num_turns : 0;
    if (turns > 0 && obj.subtype === "success") {
      // Try to extract confidence from the envelope's .result text first
      let confidence = 0;
      if (typeof obj.result === "string" && obj.result.trim()) {
        const inner = parseEngineSummary(obj.result);
        if (inner && typeof inner.confidence === "number") confidence = inner.confidence;
      }
      // Fallback: engine ran successfully with tool calls but produced no JSON summary.
      // 0.85 was the old hardcoded value — it was correct for productive sessions (15+ turns,
      // $0.70+ in tool calls) but wrong because it masked ZERO-turn failed rounds. Use a
      // graduated scale so a truly productive session still gets a reasonable confidence,
      // while short/no-op dispatches get a low one that investigation must raise.
      if (confidence === 0 && turns >= MIN_PRODUCTIVE_TURNS) {
        confidence = turns >= HIGH_PRODUCTIVE_TURNS ? CONFIDENCE_PRODUCTIVE : CONFIDENCE_MODERATE;
      }
      const cost = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0;
      return {
        confidence,
        skills_used: [],
        files_changed: [],
        commands_run: [],
        tests_run: [],
        uncertainty: `Ran ${turns} turns via tool calls ($${cost.toFixed(2)}). No text summary — review evidence manually.`,
      };
    }
    return undefined;
  }
  return obj as EngineSummary;
}

function tryParseSummary(block: string): EngineSummary | undefined {
  try {
    return asSummary(JSON.parse(block.trim()));
  } catch {
    return undefined;
  }
}

/**
 * Extract the engine summary from stdout, robust to three shapes (last valid wins):
 *  (a) a fenced ```json block, (b) the claude `--output-format json` envelope (`.result` /
 *  `.structured_output`), (c) a bare object. Uses balanced-brace scanning so nested objects
 *  parse correctly (the old `lastIndexOf("{")` slice broke on `{"a":{"b":1}}`).
 */
export function parseEngineSummary(stdout: string): EngineSummary | undefined {
  if (!stdout) return undefined;
  const fences = [...stdout.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const block of fences.reverse()) {
    const s = tryParseSummary(block);
    if (s) return s;
  }
  for (const block of extractJsonObjects(stdout).reverse()) {
    const s = tryParseSummary(block);
    if (s) return s;
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
   * Bridge-mode stderr sink. The async path streams stderr
   * per-chunk via the spawner's onStderrChunk; the bridge path
   * uses Bun.spawnSync and can only emit the full stderr after
   * the process exits. Callers wire this to the same logbus
   * channel so both paths are visible.
   */
  onStderrChunk?: (text: string) => void;
}

/** Resolve the CLI command for an engine, honouring an injected spawner (test mode). */
function resolveCli(
  engine: Engine,
  hasSpawner: boolean,
  has: (cmd: string) => boolean = hasCommand,
):
  | { ok: true; cmd: string; args: string[]; promptMode?: "stdin" | "arg"; warning?: string }
  | { ok: false; reason: string } {
  // With an injected spawner we never touch the real PATH, so treat the engine as present.
  const invocation = engineCommand(engine, hasSpawner ? { has: () => true } : { has });
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
  if (cli.promptMode !== "arg") return { cmd: cli.cmd, args: cli.args, input: prompt };
  const promptFlag = cli.args.findIndex((arg) => arg === "-p" || arg === "--prompt");
  if (promptFlag === -1) return { cmd: cli.cmd, args: [...cli.args, prompt], input: "" };
  const args = [...cli.args];
  args.splice(promptFlag + 1, 0, prompt);
  return { cmd: cli.cmd, args, input: "" };
}

function buildResult(
  opts: DispatchOpts,
  r: { status: number; stdout: string; stderr?: string; timedOut?: boolean },
  failReason: string,
  warning?: string,
): DispatchResult {
  const ok = r.status === 0;
  return {
    engine: opts.engine,
    mode: opts.mode,
    ok,
    raw: r.stdout,
    summary: parseEngineSummary(r.stdout),
    reason: ok ? undefined : r.timedOut ? "timeout" : failReason,
    warning,
  };
}

/**
 * Dispatch a prompt to an engine (synchronous).
 *  - mode "bridge": pipe to $VIBEFLOW_AI (default, engine-agnostic, offline-friendly)
 *  - mode "cli":    shell out to the real engine CLI (opt-in)
 *  - mode "dry":    write the prompt only; run nothing
 */
export function runDispatch(opts: DispatchOpts & { spawner?: Spawner }): DispatchResult {
  const { engine, prompt, mode } = opts;
  const spawn = opts.spawner ?? defaultSpawner;
  if (mode === "dry") return { engine, mode, ok: true, raw: "" };
  if (mode === "bridge") {
    const cmd = bridgeCommand(opts);
    if (!cmd) return { engine, mode, ok: false, raw: "", reason: "VIBEFLOW_AI is not set" };
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
    return buildResult(opts, bridgeSpawn(cmd, [], prompt), "bridge command failed");
  }
  const cli = resolveCli(engine, Boolean(opts.spawner), opts.has);
  if (!cli.ok) return { engine, mode, ok: false, raw: "", reason: cli.reason };
  const invocation = materializePrompt(cli, prompt);
  return buildResult(
    opts,
    spawn(invocation.cmd, invocation.args, invocation.input),
    `${cli.cmd} failed`,
    cli.warning,
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
  const spawn = opts.spawner ?? defaultAsyncSpawner;
  if (mode === "dry") return { engine, mode, ok: true, raw: "" };
  if (mode === "bridge") {
    const cmd = bridgeCommand(opts);
    if (!cmd) return { engine, mode, ok: false, raw: "", reason: "VIBEFLOW_AI is not set" };
    // VIBEFLOW_AI is a shell command string (may include args), consistent with aiGenerate's
    // shell:true spawn. Use a shell-aware spawner unless a test injected its own.
    const bridgeSpawn = opts.spawner ?? makeAsyncSpawner({ shell: true });
    return buildResult(opts, await bridgeSpawn(cmd, [], prompt), "bridge command failed");
  }
  const cli = resolveCli(engine, Boolean(opts.spawner), opts.has);
  if (!cli.ok) return { engine, mode, ok: false, raw: "", reason: cli.reason };
  const invocation = materializePrompt(cli, prompt);
  return buildResult(
    opts,
    await spawn(invocation.cmd, invocation.args, invocation.input),
    `${cli.cmd} failed`,
    cli.warning,
  );
}

/** Persist a dispatch result as evidence inside a work unit's `evidence/` folder. */
export function persistDispatch(unitDir: string, result: DispatchResult): string {
  const rel = `evidence/${result.engine}.result.json`;
  writeFileSafe(join(unitDir, rel), JSON.stringify(result, null, 2));
  return rel;
}
