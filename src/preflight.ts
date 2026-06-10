import { spawn, spawnSync } from "node:child_process";
import { ENGINES, type Engine, hasCommand } from "./core.js";

/**
 * Engine readiness levels (most-actionable first):
 *  - "ready"        engine is installed, authed (where checkable) and a live probe replied OK
 *  - "no-binary"    the engine CLI is not on PATH         → install it
 *  - "no-auth"      reserved for engines with a reliable standalone auth-status gate
 *  - "probe-failed" installed/authed but the live probe failed (nonzero, missing token, timeout)
 *                     codex uses `doctor` instead of `exec` to avoid a slow model round-trip
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
}

export type ProbeSpawner = (cmd: string, args: string[], input: string) => ProbeResult;

export interface PreflightOpts {
  /** PATH-presence check (defaults to core.hasCommand). */
  has?: (cmd: string) => boolean;
  /** Process launcher (defaults to a bounded spawnSync). */
  spawner?: ProbeSpawner;
  /** Clock for checkedAt (defaults to wall-clock ISO). */
  now?: () => string;
  /** When false, stop after presence/auth and skip the live probe (fast path). Default true. */
  probe?: boolean;
}

/** Bounded so a hung / never-logged-in engine cannot block the check forever. */
const PROBE_TIMEOUT_MS = 20_000;
/** Copilot CLI startup/model latency commonly exceeds 20s even for a one-token probe. */
const COPILOT_PROBE_TIMEOUT_MS = 60_000;
/** Trivial prompt whose reply proves the engine actually runs end-to-end. */
const PROBE_PROMPT = "Reply with the single word READY and nothing else.";
/** Token the engine must echo back for the probe to count as a success. */
const EXPECTED_TOKEN = "READY";

interface ProbeInvocation {
  cmd: string;
  args: string[];
  input: string;
}

function probeTimeoutMs(engine: Engine): number {
  return engine === "copilot" ? COPILOT_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS;
}

/** Default launcher: bounded spawnSync, prompt on stdin, no shell. */
function defaultSpawner(cmd: string, args: string[], input: string, timeout = PROBE_TIMEOUT_MS) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Headless probe argv per engine. Probe args may differ from dispatch when a cheaper check exists. */
function probeInvocation(engine: Engine, prompt = PROBE_PROMPT): ProbeInvocation {
  switch (engine) {
    case "claude":
      return { cmd: "claude", args: ["-p", "--output-format", "json"], input: prompt };
    case "codex":
      return { cmd: "codex", args: ["doctor"], input: prompt };
    case "copilot":
      return { cmd: "copilot", args: ["-p", prompt, "--allow-all-tools", "--silent"], input: "" };
  }
}

function probeAttempts(engine: Engine): ProbeInvocation[] {
  const primary = probeInvocation(engine);
  if (engine !== "copilot") return [primary];
  return [primary, { cmd: "copilot", args: ["-p", PROBE_PROMPT, "--allow-all-tools"], input: "" }];
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

function unsupportedSilentFlag(output: string): boolean {
  return /(?:unknown|unrecognized|unsupported).*(?:option|flag).*--silent|--silent.*(?:unknown|unrecognized|unsupported).*(?:option|flag)/i.test(
    output,
  );
}

function shouldRetryProbe(engine: Engine, attemptIndex: number, result: ProbeResult): boolean {
  return (
    engine === "copilot" &&
    attemptIndex === 0 &&
    unsupportedSilentFlag(`${result.stdout}\n${result.stderr ?? ""}`)
  );
}

function failedProbe(
  engine: Engine,
  result: ProbeResult,
): { level: ReadinessLevel; detail: string } {
  const output = `${result.stderr ?? ""}\n${result.stdout}`.trim();
  const hint = firstUsefulLine(output);
  const reason =
    result.status !== 0
      ? `nonzero exit ${result.status}${hint ? `: ${hint}` : ""}`
      : `missing token ${EXPECTED_TOKEN}`;
  return { level: "probe-failed", detail: `${engine}: probe failed (${reason})` };
}

function firstUsefulLine(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const nonWarnings = lines.filter((line) => !line.toLowerCase().startsWith("warning:"));
  return (
    nonWarnings.find((line) =>
      /(?:^✗|error|failed|unreachable|not found|No authentication)/i.test(line),
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

/** Run the live probe attempts; caller wraps thrown errors into probe-failed. */
function runProbe(
  engine: Engine,
  spawner: ProbeSpawner,
): { level: ReadinessLevel; detail: string } {
  const attempts = probeAttempts(engine);
  for (const [index, { cmd, args, input }] of attempts.entries()) {
    const result = spawner(cmd, args, input);
    if (probeSucceeded(engine, result.status, result.stdout))
      return { level: "ready", detail: "ready" };
    if (shouldRetryProbe(engine, index, result)) continue;
    return failedProbe(engine, result);
  }
  return { level: "probe-failed", detail: `${engine}: probe failed (no probe attempts)` };
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
      defaultSpawner(cmd, args, input, probeTimeoutMs(engine)));
  const now = opts.now ?? (() => new Date().toISOString());
  const stamp = (level: ReadinessLevel, detail: string): EngineReadiness => ({
    engine,
    level,
    detail,
    checkedAt: now(),
  });

  const { cmd } = probeInvocation(engine);
  if (!has(cmd)) return stamp("no-binary", installHint(engine));

  if (opts.probe === false) return stamp("ready", `${engine}: installed (probe skipped)`);

  const probe = runProbeSafe(engine, spawner);
  return stamp(probe.level, probe.detail);
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
export function checkEngineAsync(
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

  const { cmd } = probeInvocation(engine);
  if (!has(cmd)) return Promise.resolve(stamp("no-binary", installHint(engine)));

  const spawner = opts.spawner;

  if (opts.probe === false)
    return Promise.resolve(stamp("ready", `${engine}: installed (probe skipped)`));

  // When a spawner is injected (tests), use it synchronously — still returns a promise for
  // interface consistency so preflightAllAsync works with both sync and async spawners.
  if (spawner !== undefined) {
    const probe = runProbe(engine, spawner);
    return Promise.resolve(stamp(probe.level, probe.detail));
  }

  // Real async spawn: runs the actual engine process in parallel.
  const runAttempt = (attempt: ProbeInvocation): Promise<ProbeResult> =>
    new Promise((resolve) => {
      const child = spawn(attempt.cmd, attempt.args, { stdio: ["pipe", "pipe", "pipe"] });
      const timeout = setTimeout(() => {
        child.kill();
        resolve({ status: 124, stdout: "", stderr: `${engine}: probe timed out` });
      }, probeTimeoutMs(engine));

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ status: code ?? 1, stdout, stderr });
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ status: 1, stdout, stderr: err.message });
      });
      child.stdin.end(attempt.input);
    });

  return new Promise((resolve) => {
    const runAttempts = async () => {
      for (const [index, attempt] of probeAttempts(engine).entries()) {
        const result = await runAttempt(attempt);
        if (probeSucceeded(engine, result.status, result.stdout)) {
          resolve(stamp("ready", "ready"));
          return;
        }
        if (shouldRetryProbe(engine, index, result)) continue;
        const failed = failedProbe(engine, result);
        resolve(stamp(failed.level, failed.detail));
        return;
      }
      resolve(stamp("probe-failed", `${engine}: probe failed (no probe attempts)`));
    };

    runAttempts().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      resolve(stamp("probe-failed", `${engine}: probe failed (${msg})`));
    });
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
