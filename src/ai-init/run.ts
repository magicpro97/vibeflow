import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ENGINES, type Engine } from "../core.js";
import {
  type EngineCommandResult,
  engineCommand,
  isUnavailable,
  makeAsyncSpawner,
  materializePrompt,
} from "../dispatch.js";
import { preflightAllAsync } from "../preflight.js";
import type { ProjectProfile } from "../scanner.js";
import { scanRepo } from "../scanner.js";
import { listContextFiles, renderSlimPrompt, selectBestEngine } from "./prompt.js";
import {
  AI_INIT_TIMEOUT_MS,
  AUTOPILOT_MAX_RETRIES,
  type AiInitOpts,
  type AiInitResult,
  PERMISSION_DENIED_RE,
  UNAVAILABLE_RE,
} from "./types.js";

// DI: injected by the facade after module load. writeContextFiles must stay
// in the depth-1 facade (import.meta.url skill-template read at line ~477).
type WriteContextFilesFn = (
  base: string,
  profile: ProjectProfile,
  engines?: string[],
  ctx7Auth?: boolean,
) => string[];

let _writeContextFiles: WriteContextFilesFn | undefined;

export function __setRunDeps(writeContextFiles: WriteContextFilesFn): void {
  _writeContextFiles = writeContextFiles;
}

/** Resolve the injected writer, asserting it was wired by the facade at module
 *  load (ai-init.ts calls __setRunDeps). Throws a clear error instead of a
 *  silent `undefined is not a function` if that wiring ever regresses. */
function writeContextFilesDep(): WriteContextFilesFn {
  if (!_writeContextFiles) {
    throw new Error("ai-init: writeContextFiles dependency not wired (call __setRunDeps)");
  }
  return _writeContextFiles;
}

/**
 * Run the AI-powered init phase.
 *
 * 1. Check engine readiness (or use forced engine)
 * 2. Scan the project
 * 3. Build the analysis prompt (writes full context files, no truncation)
 * 4. Spawn the engine headless with the prompt
 * 5. Return the result
 *
 * The engine writes files directly in the project directory via its own tools.
 * On failure, the caller's Phase 1 deterministic output remains intact.
 *
 * Autopilot mode: when `opts.autopilot === true`, if the chosen engine is
 * unavailable OR returns a permission/unauthorized error, retry with the
 * next-best ready engine (skipping already-tried ones). Capped at
 * {@link AUTOPILOT_MAX_RETRIES} retries. Non-autopilot callers see the
 * pre-existing single-shot behavior — the autopilot loop is opt-in.
 */
export async function runAiInit(opts: AiInitOpts): Promise<AiInitResult> {
  const { autopilot = false } = opts;
  const originalRequested = opts.forceEngine;

  const tried = new Set<Engine>();
  let lastResult: AiInitResult | null = null;
  let prompt: string | undefined;
  let profile: ProjectProfile | null = null;

  for (let attempt = 0; attempt <= AUTOPILOT_MAX_RETRIES; attempt++) {
    const iterOpts: AiInitOpts =
      autopilot && opts.forceEngine && tried.size > 0 ? { ...opts, forceEngine: undefined } : opts;
    const result: AiInitResult & { __profile?: ProjectProfile; __break?: boolean } =
      opts.runOnceForTest
        ? await opts.runOnceForTest(iterOpts, tried, prompt ?? undefined, profile ?? undefined)
        : await runAiInitOnce(iterOpts, tried, prompt ?? undefined, profile ?? undefined);
    if ((result as { __break?: boolean }).__break) {
      lastResult = result as AiInitResult;
      break;
    }
    if (result.ok) {
      if (autopilot && originalRequested && result.engine && result.engine !== originalRequested) {
        result.fallback = { original: originalRequested, used: result.engine };
      }
      return result;
    }
    lastResult = result;
    prompt = opts.buildPrompt ? result.prompt : undefined;
    profile = (result as { __profile?: ProjectProfile }).__profile ?? profile;
    const candidateThisAttempt = result.engine ?? originalRequested;
    if (candidateThisAttempt) tried.add(candidateThisAttempt);
    if (!autopilot) return result;
    const reason = result.reason ?? "";
    const isPermission = PERMISSION_DENIED_RE.test(reason);
    const isInvocationUnavail =
      result.engine !== undefined && UNAVAILABLE_RE.test(reason) && !result.raw;
    const isForceUnready =
      result.engine === undefined && attempt === 0 && originalRequested !== undefined;
    const isTimedOut = /timed out/i.test(reason);
    if (!isPermission && !isInvocationUnavail && !isForceUnready && !isTimedOut) {
      if (tried.size > 1 && autopilot) {
        return {
          ...result,
          reason: `${result.engine ?? "engine"} ${result.reason ?? "failed"} — exhausted ${AUTOPILOT_MAX_RETRIES} autopilot fallbacks; original request was ${originalRequested ?? "auto"}`,
        };
      }
      if (originalRequested && !result.engine) {
        return {
          ...result,
          reason: `forced engine ${originalRequested} is not ready and no fallback engine is available — run \`vf doctor --probe\` to diagnose`,
        };
      }
      return result;
    }
  }

  return (
    lastResult ?? {
      ok: false,
      reason: "autopilot loop exited without a result",
    }
  );
}

/**
 * Run a single attempt of the AI init against a specific engine. The
 * caller (runAiInit) is responsible for selecting which engine and
 * looping on autopilot. This function does not know about retries.
 *
 * The `tried` set lets the autopilot loop pass already-failed engines
 * down to the next-best selector so we never retry the same engine
 * twice in one run.
 */
async function runAiInitOnce(
  opts: AiInitOpts,
  tried: Set<Engine> = new Set(),
  cachedPrompt?: string,
  cachedProfile?: ProjectProfile,
): Promise<AiInitResult & { __profile?: ProjectProfile }> {
  const {
    base,
    timeoutMs = AI_INIT_TIMEOUT_MS,
    dryRun = false,
    spawner,
    forceEngine,
    preflight,
  } = opts;

  const probe = preflight ?? ((engines, pg) => preflightAllAsync(engines, pg));
  const readiness = await probe(ENGINES, { probe: true });
  let engine: Engine | null = null;
  if (forceEngine) {
    const match = readiness.find((r) => r.engine === forceEngine && r.level === "ready");
    engine = match ? forceEngine : null;
  } else {
    const base = selectBestEngine(readiness);
    if (tried.size > 0 && base) {
      const filtered = readiness.map((r) =>
        tried.has(r.engine) ? { ...r, level: "no-binary" as const } : r,
      );
      engine = selectBestEngine(filtered);
    } else {
      engine = base;
    }
  }

  if (!engine) {
    return {
      ok: false,
      reason: forceEngine
        ? `forced engine ${forceEngine} is not ready — run \`vf doctor --probe\` to diagnose`
        : "no ready engine found — run `vf doctor --probe` to check engine status",
    };
  }

  const profile = cachedProfile ?? scanRepo(base);

  const prompt =
    cachedPrompt ??
    (opts.buildPrompt
      ? opts.buildPrompt(profile, base)
      : renderSlimPrompt(profile, base, listContextFiles(base, profile, engine)));

  if (dryRun) {
    return {
      ok: true,
      engine,
      prompt,
      reason: "dry run — prompt ready for inspection",
      __profile: profile,
    };
  }

  const invocation: EngineCommandResult = (
    opts.engineCommandFn ?? ((e) => engineCommand(e, undefined, true))
  )(engine);

  if (isUnavailable(invocation)) {
    writeContextFilesDep()(base, profile, [engine], opts.ctx7Auth);
    return { ok: false, engine, reason: invocation.unavailable, prompt, __profile: profile };
  }

  if (process.platform === "win32" && engine === "copilot" && prompt.length > 30_000) {
    return {
      ok: false,
      engine,
      reason: `copilot prompt is ${prompt.length} chars; Windows cmd-line limit is ~32K. Switch to claude or codex (they read from stdin).`,
      prompt,
      __profile: profile,
    };
  }

  writeContextFilesDep()(base, profile, [engine], opts.ctx7Auth);

  const materialized = materializePrompt(
    { cmd: invocation.cmd, args: invocation.args, promptMode: invocation.promptMode },
    prompt,
  );
  const args = materialized.args;
  const input = materialized.input;

  const evidenceRoot = join(base, ".vibeflow", "attempts");
  const asyncSpawn = spawner ?? makeAsyncSpawner({ timeoutMs, evidenceRoot });

  const result = await asyncSpawn(materialized.cmd, args, input, {
    attemptId: randomUUID(),
    engine,
    evidenceRoot,
  });

  if (result.timedOut) {
    return {
      ok: false,
      engine,
      reason: `${engine} AI analysis timed out after ${timeoutMs / 1000}s — engine may be stuck, rate-limited, or overloaded. Deterministic context files are in place. Try --dry-run to inspect the prompt, a different --engine, or check engine auth/network.`,
      raw: result.stdout,
      __profile: profile,
    };
  }

  if (result.status !== 0) {
    const r = result as { status: number; stdout: string; stderr?: string; timedOut?: boolean };
    const stderrHint = r.stderr ? ` — ${r.stderr.slice(0, 500)}` : "";
    return {
      ok: false,
      engine,
      reason: `${engine} exited with status ${result.status}${stderrHint}`,
      raw: result.stdout,
      __profile: profile,
    };
  }

  return { ok: true, engine, raw: result.stdout, __profile: profile };
}
