import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Engine } from "../core.js";
import { WORK_UNIT_STATUS } from "../core/workflow-contract.js";
import {
  type AsyncSpawner,
  type EngineCommandResult,
  engineCommand,
  isUnavailable,
  makeAsyncSpawner,
  materializePrompt,
} from "../dispatch.js";
import type { UnitDispatcher, UnitOutcome } from "../orchestrator/run.js";
import { backoffPlan, detectQuota } from "../safety/quota.js";
import { AI_INIT_TIMEOUT_MS } from "./types.js";

/** Build the default dispatcher: per unit, run a single engine call with
 *  the unit's `spec` as the prompt. Returns a `UnitOutcome` whose
 *  evidence cites the unit's `scope` paths (so the reviewer can gate
 *  on real on-disk artifacts via the file-exists check).
 *
 *  This is the production dispatcher; tests inject a fake dispatcher
 *  (or a fake `engineCommandFn` + `spawner`) to stay deterministic.
 *
 *  Contract: status="verifying" on success (production never says "done"
 *  — the reviewer must), confidence=1, evidence=unit.scope. status="blocked"
 *  on any engine error (timeout, non-zero exit, unavailable binary), with
 *  evidence=[] so the reviewer rejects the unit deterministically.
 *
 *  Retry policy: when the engine exits non-zero with a rate-limit signal
 *  (HTTP 429, "rate limit", "too many requests"), the dispatcher retries
 *  the same call up to `maxRetries` times with exponential backoff +
 *  full jitter, honoring a server `retry-after` hint as a floor. This
 *  prevents one transient Copilot / Claude / Codex rate-limit from
 *  poisoning an entire agent-team wave (previously a single 429 on the
 *  workflow-state-writer took out the whole final wave). Other non-zero
 *  exits (auth, syntax, missing binary) are NOT retried — retrying
 *  cannot help. */
export function defaultAiInitDispatcher(
  engine: Engine,
  opts: {
    engineCommandFn?: (engine: Engine) => EngineCommandResult;
    spawner?: AsyncSpawner;
    timeoutMs?: number;
    /** Max retry attempts on a rate-limit signal. Default 2 (3 total tries). */
    maxRetries?: number;
    /** Base delay (ms) for exponential backoff. Default 2000. */
    backoffBaseMs?: number;
    /** Cap (ms) on a single backoff delay. Default 60000. */
    backoffCapMs?: number;
    /** Test seam: inject a sleep fn to keep the suite deterministic. */
    sleep?: (ms: number) => Promise<void>;
    evidenceRoot?: string;
  } = {},
): UnitDispatcher {
  const {
    engineCommandFn,
    spawner,
    timeoutMs = AI_INIT_TIMEOUT_MS,
    maxRetries = 2,
    backoffBaseMs = 2000,
    backoffCapMs = 60_000,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    evidenceRoot = join(process.cwd(), ".vibeflow", "attempts"),
  } = opts;
  const resolveInvocation = engineCommandFn ?? engineCommand;
  const asyncSpawn = spawner ?? makeAsyncSpawner({ timeoutMs });
  // Probe the engine invocation once at dispatcher construction time so we can
  // surface the copilot `--version` warning (github/copilot-cli#1606 class —
  // silent breaking auto-updates that drop `-p --allow-all`). The legacy
  // `runAiInit` path surfaces this via `announceLaunch`; the agent-team path
  // never calls that, so we have to do it here. Warn-once is the right call
  // because the warning is per-installation, not per-unit — but since a single
  // dispatcher handles all units, emitting on the first invocation is fine
  // (and avoids per-unit stderr noise on the typical 7-unit agent-team run).
  const probedInvocation = resolveInvocation(engine);
  let warnedDegraded = false;
  return async (unit): Promise<UnitOutcome> => {
    const invocation = probedInvocation;
    if (isUnavailable(invocation)) {
      const reason = invocation.unavailable;
      process.stderr.write(`[ai-init-dispatcher] engine ${engine} unavailable: ${reason}\n`);
      return {
        status: WORK_UNIT_STATUS.BLOCKED,
        confidence: 0,
        evidence: [`engine-unavailable:${engine}:${reason}`],
      };
    }
    if (invocation.warning && !warnedDegraded) {
      warnedDegraded = true;
      process.stderr.write(`[ai-init-dispatcher] ${engine}: ${invocation.warning}\n`);
    }
    const materialized = materializePrompt(
      { cmd: invocation.cmd, args: invocation.args, promptMode: invocation.promptMode },
      unit.spec ?? "",
    );
    let lastNonZero = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await asyncSpawn(materialized.cmd, materialized.args, materialized.input, {
        attemptId: randomUUID(),
        engine,
        evidenceRoot,
      });
      if (result.timedOut) {
        const reason = `timed out after ${timeoutMs}ms`;
        process.stderr.write(`[ai-init-dispatcher] ${unit.name} ${reason}\n`);
        return {
          status: WORK_UNIT_STATUS.BLOCKED,
          confidence: 0,
          evidence: [`dispatcher-timeout:${unit.name}:${reason}`],
        };
      }
      if (result.status === 0) {
        return {
          status: WORK_UNIT_STATUS.VERIFYING,
          confidence: 1,
          evidence: [...(unit.scope ?? [])],
        };
      }
      const sig = detectQuota({
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr ?? "",
      });
      const plan = backoffPlan(sig, attempt, {
        baseMs: backoffBaseMs,
        capMs: backoffCapMs,
        maxRetries,
      });
      if (plan.retry) {
        process.stderr.write(
          `[ai-init-dispatcher] ${unit.name} ${sig.kind ?? "rate-limited"} ` +
            `(exit ${result.status}); retrying in ${plan.delayMs}ms ` +
            `(attempt ${attempt + 1}/${maxRetries})\n`,
        );
        await sleep(plan.delayMs);
        continue;
      }
      // Non-retryable non-zero exit: stop retrying and report blocked.
      lastNonZero = result.status;
      break;
    }
    const reason = `exit ${lastNonZero}`;
    process.stderr.write(`[ai-init-dispatcher] ${unit.name} ${reason}\n`);
    return {
      status: WORK_UNIT_STATUS.BLOCKED,
      confidence: 0,
      evidence: [`dispatcher-nonzero:${unit.name}:${reason}`],
    };
  };
}
