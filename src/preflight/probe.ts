import { spawnSync } from "node:child_process";
import { type Engine, needsShellForCommand, resolveEngineBinary } from "../core.js";
import type { ProbeResult, ProbeSpawner, ReadinessLevel } from "./types.js";

/** Bounded so a hung / never-logged-in engine cannot block the check forever. */
export const PROBE_TIMEOUT_MS = 20_000;
/** GitHub auth status is a local fast-fail gate, so keep it short. */
export const GH_AUTH_TIMEOUT_MS = 5_000;
/** Trivial prompt whose reply proves the engine actually runs end-to-end. */
export const PROBE_PROMPT = "Reply with the single word READY and nothing else.";
/** Token the engine must echo back for the probe to count as a success. */
export const EXPECTED_TOKEN = "READY";

export interface ProbeInvocation {
  cmd: string;
  args: string[];
  input: string;
}

// Test seam: probeTimeoutMs reads from opts.probeTimeoutMs if provided.
// Production callers pass undefined; tests pass 50ms for fast timeouts.
export function probeTimeoutMs(engine: Engine, override?: number): number {
  if (override !== undefined) return override;
  return engine === "copilot" ? GH_AUTH_TIMEOUT_MS : PROBE_TIMEOUT_MS;
}

/** Default launcher: bounded spawnSync, prompt on stdin, no shell. */
export function defaultSpawner(
  cmd: string,
  args: string[],
  input: string,
  timeout = PROBE_TIMEOUT_MS,
) {
  const needsShell = needsShellForCommand(cmd);
  // ponytail: when shell is needed AND path has spaces, quote the cmd.
  // Node's spawnSync with shell:true passes cmd unquoted to cmd.exe on
  // Windows, and cmd.exe /s strips the outer quotes — splitting on the
  // space (e.g. C:\Users\Linh Ngo\...\claude.cmd). Pre-quote to fix #439.
  const quotedCmd = needsShell && cmd.includes(" ") ? `"${cmd}"` : cmd;
  const r = spawnSync(quotedCmd, args, {
    input,
    encoding: "utf8",
    timeout,
    shell: needsShell,
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

export function engineBinary(engine: Engine): string {
  return engine === "copilot" ? "copilot" : probeInvocation(engine).cmd;
}

/**
 * Engine-binary name actually used at runtime: prefers the bare name, but
 * falls back to the Windows shim variant (`.cmd` / `.bat` / `.ps1`) when
 * the bare name is missing. Issue #87.
 */
export function engineBinaryResolved(engine: Engine): string {
  return resolveEngineBinary(engineBinary(engine)) ?? engineBinary(engine);
}

export function ghAuthInvocation(): ProbeInvocation {
  return { cmd: "gh", args: ["auth", "status"], input: "" };
}

export function ghInstallHint(): string {
  return "GitHub CLI not found — install gh to check GitHub Copilot auth";
}

/** Install hint surfaced when an engine binary is missing. */
export function installHint(engine: Engine): string {
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
export function probeSucceeded(engine: Engine, status: number, stdout: string): boolean {
  if (status !== 0) return false;
  if (engine === "codex") return /\b0 fail ok\b/i.test(stdout) || /\b0 fail\b/i.test(stdout);
  if (engine === "claude") {
    const fromJson = claudeResultText(stdout);
    if (fromJson !== undefined) return containsToken(fromJson);
  }
  return containsToken(stdout);
}

export function failedProbe(
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

export function failedAuth(
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

export function checkCopilotAuth(
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
export function hasGh(has: (cmd: string) => boolean, usesDefaultHas: boolean): boolean {
  if (has("gh")) return true;
  if (!usesDefaultHas) return false;
  return resolveEngineBinary("gh") !== undefined;
}

/** Run the live probe attempts; caller wraps thrown errors into probe-failed. */
export function runProbe(
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
export function runProbeSafe(
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
