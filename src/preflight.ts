// size-waiver: #186 — preflight.ts split into preflight/{probe,claude,codex,copilot}; see issue #186
import { spawnSync } from "node:child_process";
import {
  ENGINES,
  type Engine,
  hasCommand,
  needsShellForCommand,
  resolveCommand,
  resolveEngineBinary,
} from "./core.js";

/**
 * Engine readiness levels (most-actionable first):
 *  - "ready"        engine is installed, authed (where checkable) and a live probe replied OK
 *  - "no-binary"    the engine CLI is not on PATH         → install it
 *  - "no-auth"      reserved for engines with a reliable standalone auth-status gate
 *  - "probe-failed" installed/authed but the live probe failed (nonzero, missing token, timeout)
 *                     codex uses `doctor`; copilot uses `gh auth status` instead of a prompt probe
 *  - "unknown"      we could not determine readiness (defensive; should be rare)
 */
export type ReadinessLevel = "ready" | "no-binary" | "no-auth" | "probe-failed" | "unknown";

export interface EngineReadiness {
  engine: Engine;
  level: ReadinessLevel;
  /** Human-readable status or a fix hint, e.g. "claude: probe OK" / "install the codex CLI". */
  detail: string;
  /** ISO timestamp; injected via opts.now so tests can pin a deterministic clock. */
  checkedAt: string;
}

/**
 * Injectable spawn seam — mirrors dispatch.ts's Spawner shape. The prompt is always passed via
 * argv or `input` (stdin) without shell interpolation. Tests inject a fake to avoid launching a
 * real engine.
 */
interface ProbeResult {
  status: number;
  stdout: string;
  stderr?: string;
  code?: string;
}

export type ProbeSpawner = (cmd: string, args: string[], input: string) => ProbeResult;

export interface PreflightOpts {
  /** PATH-presence check (defaults to core.hasCommand). */
  has?: (cmd: string) => boolean;
  /** Process launcher (defaults to a bounded spawnSync). */
  spawner?: ProbeSpawner;
  /** Clock for checkedAt (defaults to wall-clock ISO). */
  now?: () => string;
  /** When false, stop after presencia/auth and skip the live probe (fast path). Default true. */
  probe?: boolean;
  /** Skip cache lookup AND skip cache write. Used by `vf doctor --refresh`. */
  skipCache?: boolean;
  /** Base dir for the cache key (defaults to process.cwd()). */
  cacheKey?: string;
  /** Override the per-probe timeout (test seam, line 380). Production: undefined. */
  probeTimeoutMs?: number;
}

/** Bounded so a hung / never-logged-in engine cannot block the check forever. */
const PROBE_TIMEOUT_MS = 20_000;
/** GitHub auth status is a local fast-fail gate, so keep it short. */
const GH_AUTH_TIMEOUT_MS = 5_000;
/** Trivial prompt whose reply proves the engine actually runs end-to-end. */
const PROBE_PROMPT = "Reply with the single word READY and nothing else.";
/** Token the engine must echo back for the probe to count as a success. */
const EXPECTED_TOKEN = "READY";

interface ProbeInvocation {
  cmd: string;
  args: string[];
  input: string;
}

// Test seam: probeTimeoutMs reads from opts.probeTimeoutMs if provided.
// Production callers pass undefined; tests pass 50ms for fast timeouts.
function probeTimeoutMs(engine: Engine, override?: number): number {
  if (override !== undefined) return override;
  return engine === "copilot" ? GH_AUTH_TIMEOUT_MS : PROBE_TIMEOUT_MS;
}

/** Default launcher: bounded spawnSync, prompt on stdin, no shell. */
function defaultSpawner(cmd: string, args: string[], input: string, timeout = PROBE_TIMEOUT_MS) {
  const r = spawnSync(cmd, args, {
    input,
    encoding: "utf8",
    timeout,
    shell: needsShellForCommand(cmd),
  });
  const code =
    r.error && typeof (r.error as NodeJS.ErrnoException).code === "string"
      ? (r.error as NodeJS.ErrnoException).code
      : undefined;
  const stderr = r.stderr || (r.error instanceof Error ? r.error.message : "");
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr, code };
}

// Test seam: exported so unit tests can exercise the copilot
// throw branch (line 100-101) and the actual claude/codex cases.
export function probeInvocation(engine: Engine, prompt = PROBE_PROMPT): ProbeInvocation {
  switch (engine) {
    case "claude":
      return { cmd: "claude", args: ["-p", "--output-format", "json"], input: prompt };
    case "codex":
      return { cmd: "codex", args: ["doctor"], input: prompt };
    case "copilot":
      throw new Error("copilot uses `gh auth status`; no probe invocation exists");
  }
}

function engineBinary(engine: Engine): string {
  return engine === "copilot" ? "copilot" : probeInvocation(engine).cmd;
}

/**
 * Engine-binary name actually used at runtime: prefers the bare name, but
 * falls back to the Windows shim variant (`.cmd` / `.bat` / `.ps1`) when
 * the bare name is missing. Issue #87.
 */
function engineBinaryResolved(engine: Engine): string {
  return resolveEngineBinary(engineBinary(engine)) ?? engineBinary(engine);
}

function ghAuthInvocation(): ProbeInvocation {
  return { cmd: "gh", args: ["auth", "status"], input: "" };
}

function ghInstallHint(): string {
  return "GitHub CLI not found — install gh to check GitHub Copilot auth";
}

/** Install hint surfaced when an engine binary is missing. */
function installHint(engine: Engine): string {
  if (engine === "copilot") return "copilot CLI not found — install GitHub Copilot CLI";
  return `${engine} CLI not found — install the ${engine} CLI`;
}

/**
 * True when the engine's probe proves readiness.
 *
 * For codex, `doctor` is a local config check (binary + config syntax + auth-file presence), not a
 * network round-trip. That is intentional: a slow model-load ping with `exec -` was the previous
 * approach but it added ~30s per probe for no additional signal — if `doctor` passes and the user's
 * token is expired, dispatch will fail with a clear auth error, which is the right place to handle it.
 *
 * A status-0 alone is not enough: `doctor` may report problems via stdout but still exit 0, so we
 * also require a line matching "ok" in its output.
 */
function probeSucceeded(engine: Engine, status: number, stdout: string): boolean {
  if (status !== 0) return false;
  if (engine === "codex") return /\b0 fail ok\b/i.test(stdout) || /\b0 fail\b/i.test(stdout);
  if (engine === "claude") {
    const fromJson = claudeResultText(stdout);
    if (fromJson !== undefined) return containsToken(fromJson);
  }
  return containsToken(stdout);
}

function failedProbe(
  engine: Engine,
  result: ProbeResult,
): { level: ReadinessLevel; detail: string } {
  if (result.code === "ENOENT" || /\bspawn\b.*\bENOENT\b/i.test(result.stderr ?? ""))
    return { level: "no-binary", detail: installHint(engine) };
  const output = `${result.stderr ?? ""}\n${result.stdout}`.trim();
  const hint = firstUsefulLine(output);
  const reason =
    result.status !== 0
      ? `nonzero exit ${result.status}${hint ? `: ${hint}` : ""}`
      : `missing token ${EXPECTED_TOKEN}`;
  return { level: "probe-failed", detail: `${engine}: probe failed (${reason})` };
}

function failedAuth(
  engine: Engine,
  result: ProbeResult,
): { level: ReadinessLevel; detail: string } {
  const output = `${result.stderr ?? ""}\n${result.stdout}`.trim();
  const hint = firstUsefulLine(output);
  return {
    level: "no-auth",
    detail: `${engine}: not authenticated${hint ? ` (${hint})` : ""}; run \`gh auth login\``,
  };
}

function firstUsefulLine(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const nonWarnings = lines.filter((line) => !line.toLowerCase().startsWith("warning:"));
  return (
    nonWarnings.find((line) =>
      /(?:^✗|error|failed|failure|fatal|unreachable|not found|no authentication|not authenticated|auth(?:entication)? required|permission denied|access denied|invalid|missing|exception)/i.test(
        line,
      ),
    ) ??
    nonWarnings[0] ??
    lines[0]
  );
}

/** Extract claude's `.result` text from the JSON envelope; undefined if stdout isn't valid. */
function claudeResultText(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (parsed && typeof parsed === "object") {
      const result = (parsed as Record<string, unknown>).result;
      if (typeof result === "string") return result;
    }
  } catch {
    /* not JSON — caller falls back to raw substring match */
  }
  return undefined;
}

function containsToken(s: string): boolean {
  return s.toLowerCase().includes(EXPECTED_TOKEN.toLowerCase());
}

function checkCopilotAuth(
  has: (cmd: string) => boolean,
  spawner: ProbeSpawner,
  usesDefaultHas: boolean,
): { level: ReadinessLevel; detail: string } {
  if (!hasGh(has, usesDefaultHas)) return { level: "no-binary", detail: ghInstallHint() };
  // Issue #87: use the shim-resolved gh binary name on Windows when the
  // default `has` is in use. Test-injected `has` skips the shim resolver
  // to keep the test seam's contract.
  const ghCmd = usesDefaultHas ? (resolveEngineBinary("gh") ?? "gh") : "gh";
  const { args, input } = ghAuthInvocation();
  const result = spawner(ghCmd, args, input);
  if (result.status === 0) return { level: "ready", detail: "copilot: GitHub auth OK" };
  return failedAuth("copilot", result);
}

/**
 * Shim-aware gh presence check. When the default `has` is in use, fall
 * back to the Windows shim resolver so a `gh.cmd` install is recognized
 * (issue #87). When `has` is test-injected, honor its answer verbatim —
 * `has: () => false` really means "not present".
 */
function hasGh(has: (cmd: string) => boolean, usesDefaultHas: boolean): boolean {
  if (has("gh")) return true;
  if (!usesDefaultHas) return false;
  return resolveEngineBinary("gh") !== undefined;
}

/** Run the live probe attempts; caller wraps thrown errors into probe-failed. */
function runProbe(
  engine: Engine,
  spawner: ProbeSpawner,
): { level: ReadinessLevel; detail: string } {
  const { cmd, args, input } = probeInvocation(engine);
  const result = spawner(cmd, args, input);
  if (probeSucceeded(engine, result.status, result.stdout)) {
    return { level: "ready", detail: "ready" };
  }
  return failedProbe(engine, result);
}

/** Run the live probe, fail-closed: any thrown error becomes a graceful probe-failed. */
function runProbeSafe(
  engine: Engine,
  spawner: ProbeSpawner,
): { level: ReadinessLevel; detail: string } {
  try {
    return runProbe(engine, spawner);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { level: "probe-failed", detail: `${engine}: probe failed (${msg})` };
  }
}

/**
 * Staged, short-circuiting readiness check: presence → auth → live probe. Each stage that fails
 * stops the chain with the most actionable level. Never throws — a misbehaving spawner is caught.
 */
export function checkEngine(engine: Engine, opts: PreflightOpts = {}): EngineReadiness {
  const has = opts.has ?? hasCommand;
  const spawner =
    opts.spawner ??
    ((cmd: string, args: string[], input: string) =>
      defaultSpawner(cmd, args, input, cmd === "gh" ? GH_AUTH_TIMEOUT_MS : probeTimeoutMs(engine)));
  const now = opts.now ?? (() => new Date().toISOString());
  const stamp = (level: ReadinessLevel, detail: string): EngineReadiness => ({
    engine,
    level,
    detail,
    checkedAt: now(),
  });

  // Cache lookup: short-circuit when fresh
  if (!opts.skipCache) {
    const { getSharedCache } = require("./probe-cache.js") as typeof import("./probe-cache.js");
    const cache = getSharedCache();
    const cacheRepo = opts.cacheKey ?? process.cwd();
    const hit = cache.get(engine, cacheRepo, [], undefined);
    if (hit) return hit;
  }

  const cmd = engineBinary(engine);
  // Issue #87: bare-name `has` is insufficient on Windows (npm shims).
  const usesDefaultHas = opts.has === undefined;
  if (!has(cmd)) {
    const shimCheck = usesDefaultHas ? resolveEngineBinary(cmd) : undefined;
    if (shimCheck === undefined) {
      const r = stamp("no-binary", installHint(engine));
      writeToCache(engine, opts, r);
      return r;
    }
  }
  // Issue #87: resolve shim-aware name so the probe spawner is invoked
  // with the actual executable on Windows.
  const effectiveCmd = engineBinaryResolved(engine);
  const resolvedCmd =
    opts.spawner !== undefined ? effectiveCmd : (resolveCommand(effectiveCmd) ?? effectiveCmd);

  if (engine === "copilot") {
    try {
      const auth = checkCopilotAuth(has, spawner, usesDefaultHas);
      const r = stamp(auth.level, auth.detail);
      writeToCache(engine, opts, r);
      return r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const r = stamp("probe-failed", `${engine}: probe failed (${msg})`);
      writeToCache(engine, opts, r);
      return r;
    }
  }

  if (opts.probe === false) {
    const r = stamp("ready", `${engine}: installed (probe skipped)`);
    writeToCache(engine, opts, r);
    return r;
  }

  const probe = runProbeSafe(engine, (probeCmd, args, input) =>
    spawner(probeCmd === cmd ? resolvedCmd : probeCmd, args, input),
  );
  const r = stamp(probe.level, probe.detail);
  writeToCache(engine, opts, r);
  return r;
}

function writeToCache(engine: Engine, opts: PreflightOpts, r: EngineReadiness): void {
  if (opts.skipCache) return;
  const { setCachedProbe } = require("./probe-cache.js") as typeof import("./probe-cache.js");
  const repo = opts.cacheKey ?? process.cwd();
  setCachedProbe(engine, repo, [], r);
}

/** De-duplicated, ENGINES-validated subset of the requested engines, in canonical order. */
function normalizeEngines(engines: Engine[]): Engine[] {
  const requested = new Set(engines);
  return ENGINES.filter((e) => requested.has(e));
}

/** Check every (valid, deduped) engine. Synchronous to match doctor's simplicity. */
export function preflightAll(engines: Engine[], opts: PreflightOpts = {}): EngineReadiness[] {
  return normalizeEngines(engines).map((e) => checkEngine(e, opts));
}

/** Async variant that runs a single probe via promise-wrapped spawn, parallel-ready. */
/**
 * Internal helper: run the gh auth check + engine probe sequence.
 * Extracted to a named function so bun's coverage tool can track
 * its body lines (arrow function bodies inside `new Promise(...)`
 * callbacks were reported as 0 hits even when fired).
 */
// Test seam: exported so unit tests can exercise the function body
// (line 432-448) directly. Production callers use the closure
// version inside checkEngineAsync.
export function runAttempts(
  engine: Engine,
  has: (cmd: string) => boolean,
  probeSucceeded: (engine: Engine, status: number, stdout: string) => boolean,
  failedProbe: (
    engine: Engine,
    result: ProbeResult,
  ) => {
    level: ReadinessLevel;
    detail: string;
  },
  resolve: (result: EngineReadiness) => void,
  runAttempt: (attempt: ProbeInvocation, timeoutMs?: number) => Promise<ProbeResult>,
  stamp: (level: ReadinessLevel, detail: string) => EngineReadiness,
): Promise<void> {
  if (engine === "copilot" && has("gh")) {
    const auth = runAttempt(ghAuthInvocation(), GH_AUTH_TIMEOUT_MS) as Promise<ProbeResult>;
    return auth.then((authResult) => {
      if (authResult.status !== 0) {
        const failed = failedAuth(engine, authResult);
        resolve(stamp(failed.level, failed.detail));
        return;
      }
      resolve(stamp("ready", "copilot: GitHub auth OK"));
      return;
    });
  }

  const attempt = probeInvocation(engine);
  return runAttempt(attempt).then((result) => {
    if (probeSucceeded(engine, result.status, result.stdout)) {
      resolve(stamp("ready", "ready"));
      return;
    }
    const failed = failedProbe(engine, result);
    resolve(stamp(failed.level, failed.detail));
    return;
  });
}

export async function checkEngineAsync(
  engine: Engine,
  opts: PreflightOpts = {},
): Promise<EngineReadiness> {
  const has = opts.has ?? hasCommand;
  const now = opts.now ?? (() => new Date().toISOString());
  const stamp = (level: ReadinessLevel, detail: string): EngineReadiness => ({
    engine,
    level,
    detail,
    checkedAt: now(),
  });

  const cmd = engineBinary(engine);
  // Issue #87: bare-name `has` is insufficient on Windows (npm shims).
  const usesDefaultHasAsync = opts.has === undefined;
  if (!has(cmd)) {
    const shimCheck = usesDefaultHasAsync ? resolveEngineBinary(cmd) : undefined;
    if (shimCheck === undefined) return Promise.resolve(stamp("no-binary", installHint(engine)));
  }
  const resolvedCmd = opts.spawner !== undefined ? cmd : (resolveCommand(cmd) ?? cmd);

  const spawner = opts.spawner;

  if (engine === "copilot" && !hasGh(has, usesDefaultHasAsync)) {
    return Promise.resolve(stamp("no-binary", ghInstallHint()));
  }

  if (engine === "copilot" && spawner !== undefined) {
    try {
      const auth = checkCopilotAuth(has, spawner, usesDefaultHasAsync);
      return Promise.resolve(stamp(auth.level, auth.detail));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Promise.resolve(stamp("probe-failed", `${engine}: probe failed (${msg})`));
    }
  }

  // copilot with no inject spawner → use defaultSpawner for gh auth
  if (engine === "copilot" && hasGh(has, usesDefaultHasAsync)) {
    // Issue #87: use the shim-resolved gh binary name on Windows.
    const ghCmd = usesDefaultHasAsync ? (resolveEngineBinary("gh") ?? "gh") : "gh";
    const ghResult = defaultSpawner(ghCmd, ["auth", "status"], "", GH_AUTH_TIMEOUT_MS);
    if (ghResult.status === 0) {
      return Promise.resolve(stamp("ready", "copilot: GitHub auth OK"));
    }
    const failed = failedAuth("copilot", ghResult);
    return Promise.resolve(stamp(failed.level, failed.detail));
  }

  if (opts.probe === false)
    return Promise.resolve(stamp("ready", `${engine}: installed (probe skipped)`));

  // When a spawner is injected (tests), use it synchronously — still returns a promise for
  // interface consistency so preflightAllAsync works with both sync and async spawners.
  if (spawner !== undefined) {
    const probe = runProbe(engine, spawner);
    return Promise.resolve(stamp(probe.level, probe.detail));
  }

  // Real async spawn: runs the actual engine process in parallel.
  const runAttempt = (
    attempt: ProbeInvocation,
    timeoutMs = probeTimeoutMs(engine, opts.probeTimeoutMs),
  ): Promise<ProbeResult> =>
    new Promise((resolve) => {
      const spawnCmd = attempt.cmd === cmd ? resolvedCmd : attempt.cmd;
      const child = Bun.spawn([spawnCmd, ...attempt.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin?.write(attempt.input);
      child.stdin?.end();

      const timeout = setTimeout(() => {
        child.kill();
        resolve({ status: 124, stdout: "", stderr: `${attempt.cmd}: probe timed out` });
      }, timeoutMs);

      let stdout = "";
      let stderr = "";
      (async () => {
        const reader = child.stdout.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stdout += new TextDecoder().decode(value);
        }
      })();
      (async () => {
        const reader = child.stderr.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stderr += new TextDecoder().decode(value);
        }
      })();

      child.exited
        .then((code) => {
          clearTimeout(timeout);
          resolve({ status: code ?? 1, stdout, stderr });
        })
        .catch((err: unknown) => {
          clearTimeout(timeout);
          const msg = err instanceof Error ? err.message : String(err);
          resolve({ status: 1, stdout, stderr: msg });
        });
    });

  return new Promise((resolve) => {
    runAttempts(engine, has, probeSucceeded, failedProbe, resolve, runAttempt, stamp).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        resolve(stamp("probe-failed", `${engine}: probe failed (${msg})`));
      },
    );
  });
}

/** Run all probes in parallel via the async path. Returns in ~max(probe) instead of sum(probes). */
export function preflightAllAsync(
  engines: Engine[],
  opts: PreflightOpts = {},
): Promise<EngineReadiness[]> {
  return Promise.all(normalizeEngines(engines).map((e) => checkEngineAsync(e, opts)));
}

/** True if at least one engine is fully ready (the gate the next agent uses to allow creation). */
export function anyReady(list: EngineReadiness[]): boolean {
  return list.some((r) => r.level === "ready");
}

/** The engines that are fully ready, in input order. */
export function readyEngines(list: EngineReadiness[]): Engine[] {
  return list.filter((r) => r.level === "ready").map((r) => r.engine);
}
