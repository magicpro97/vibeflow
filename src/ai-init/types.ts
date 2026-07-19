import type { AiInitIntake, AiInitUnit } from "../ai-init-workflow/types.js";
import { CTX_DIR, type Engine } from "../core.js";
import type { AsyncSpawner, EngineCommandResult, makeAsyncSpawner } from "../dispatch.js";
import type { QuotaStatus } from "../engine-quota.js";
import type { UnitDispatcher } from "../orchestrator/run.js";
import type { EngineReadiness } from "../preflight.js";
import type { ProjectProfile } from "../scanner.js";

/** Instruction files by selected engine. */
const INSTRUCTION_FILES_BY_ENGINE: Record<Engine, readonly string[]> = {
  claude: ["CLAUDE.md"],
  codex: ["AGENTS.md"],
  copilot: ["AGENTS.md", ".github/copilot-instructions.md"],
  opencode: ["AGENTS.md"],
  antigravity: ["AGENTS.md"],
};
/** When `engines` is empty/absent, default to a single engine's scope
 *  instead of ALL engines. This prevents the instruction-writer from
 *  silently targeting unselected engines (Phase 2 engine-scoping
 *  contract). Copilot matches the INIT_DEFAULT_ENGINE in
 *  ai-init-workflow.ts — the widest single-engine scope so the
 *  reviewer can still pass on either AGENTS.md or copilot-instructions. */
const CONTEXT_FALLBACK_ENGINE: Engine = "copilot";

/** AI init timeout: 30 minutes for enrichment (increased from 10m). */
const AI_INIT_TIMEOUT_MS = 1_800_000;

/** Temp directory for full-file context (no truncation). */
const AI_CONTEXT_DIR = `${CTX_DIR}/ai-context`;

/** Name of the slim-prompt companion file (RAG pattern). */
const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

const PERMISSION_DENIED_RE = /permission[\s_-]*denied|could not request permission|not authorized/i;
const UNAVAILABLE_RE = /not found|unavailable|not installed|cli not found|missing/i;

/** Hard cap on autopilot retries. No point looping if all 3 alternatives also fail. */
const AUTOPILOT_MAX_RETRIES = 3;

export interface AiInitResult {
  ok: boolean;
  engine?: Engine;
  reason?: string;
  prompt?: string;
  raw?: string;
  /**
   * Autopilot fallback chain. Present only when the caller passed
   * `autopilot: true` AND the originally requested engine was not
   * the one that ultimately ran. Lets the CLI surface a
   * "you asked for copilot, fell back to claude" message.
   * `original` is the engine the caller requested via --engine.
   * `used` is the engine that actually executed the work.
   */
  fallback?: { original: Engine; used: Engine };
}

export interface AiInitOpts {
  base: string;
  timeoutMs?: number;
  dryRun?: boolean;
  spawner?: AsyncSpawner;
  /** When set, skip ready check and use this engine directly (for --engine flag). */
  forceEngine?: Engine;
  /**
   * When true, fall back to the next-best ready engine if the chosen
   * engine is unavailable OR returns a permission/unauthorized error.
   * Capped at 3 retries; the fallback engine must be DIFFERENT from
   * the one that just failed (no point retrying the same engine).
   * The result includes `fallback: { original, used }` so the caller
   * can surface "you asked for X, ran on Y".
   */
  autopilot?: boolean;
  /** Inject preflight for tests (avoids live engine probes). */
  preflight?: (engines: Engine[], opts: { probe: boolean }) => EngineReadiness[];
  /** CLI-side ctx7 auth state. false means use fallback without prompting login. */
  ctx7Auth?: boolean;
  /** Streaming callbacks forwarded to internal spawners (shell pipe path). */
  onChunk?: (text: string) => void;
  onStderrChunk?: (text: string) => void;
  engineCommandFn?: (engine: Engine) => EngineCommandResult;
  buildPrompt?: (profile: ProjectProfile, base: string) => string;
  makeAsyncSpawner?: typeof makeAsyncSpawner;
  /**
   * Test seam: lets unit tests inject a custom per-iteration
   * executor. The autopilot loop calls this in place of the real
   * `runAiInitOnce` to simulate unreachable code paths (e.g. the
   * post-loop fallback). Production callers never set this.
   */
  runOnceForTest?: (
    opts: AiInitOpts,
    tried: Set<Engine>,
    cachedPrompt?: string,
    cachedProfile?: ProjectProfile,
  ) => Promise<AiInitResult & { __profile?: ProjectProfile }>;
}

export interface AiInitWorkflowResult {
  ok: boolean;
  engine?: Engine;
  reason?: string;
  /** Per-unit work-unit state (post-dispatch). Empty when the planner
   *  produced no units or the run failed before dispatch. The
   *  orchestrator preserves each input's shape (via `...unit` in
   *  applyOutcome), so AiInitUnit fields like `acceptance` are kept
   *  (MINOR-5: typed as AiInitUnit[] here, not WorkUnit[]). */
  units: AiInitUnit[];
  /** Per-unit review verdicts in dispatch order. */
  reviews: Array<{ unit: string; pass: boolean; reason: string }>;
  /** True when every unit passed review and reached confidence 1.0. */
  goalMet: boolean;
  /** How the workflow was blocked (when ok=false). Distinguishes the
   *  pre-dispatch "no engine" case from the mid-flight "engine failed"
   *  case so the CLI can pick the right recovery message. */
  blockKind?: "no-engine" | "engine-failed" | "wave-blocked";
  /** When the workflow was blocked mid-flight, the units that DID pass
   *  before the block. Always a subset of `units` (those with status
   *  "verifying" / "done"). Empty when the block happened at the
   *  pre-dispatch preflight (no engine ready). */
  passedUnits?: string[];
  /** P0-4: units held back because quota was below the skip threshold.
   *  These were never dispatched (no engine call), so they did not
   *  consume any rate-limit budget. The user can re-run `vf init`
   *  after the quota window resets to get them. Empty when the
   *  quota was healthy enough to dispatch everything. */
  skippedUnits?: string[];
}

/** Options for {@link runAiInitWorkflow}. */
export interface AiInitWorkflowOpts {
  base: string;
  /** Trimmed intake answers (used to drive the per-unit spec). */
  intake: AiInitIntake;
  /** Engine to dispatch each unit to. When set, the planner skips the
   *  best-engine selection and pins the call. */
  forceEngine?: Engine;
  /** Test seam: same surface as `runAiInit`'s preflight (avoids live
   *  engine probes). */
  preflight?: (engines: Engine[], opts: { probe: boolean }) => EngineReadiness[];
  /** Injected dispatcher so unit tests can drive the orchestrator
   *  without spawning real engines. Production callers omit this and
   *  `runAiInitWorkflow` constructs `defaultAiInitDispatcher(engine)`
   *  internally (passing through the `engineCommandFn` + `spawner`
   *  seams below). */
  dispatcher?: UnitDispatcher;
  /** Test seam: injectable skill-curator so unit tests can drive the
   *  "ai-init-skill-curator" wave's whitelist-install reporting branch
   *  without a real curator run. Production omits this and
   *  `runAiInitWorkflow` calls `curateSkillsFromEvidence` directly. */
  curate?: (
    base: string,
    engine: Engine,
    options: { ctx7Authenticated?: boolean },
  ) => { installed: string[]; unmatched: string[] };
  /** Bounded-parallel concurrency. Defaults to DEFAULT_CONCURRENCY (3). */
  concurrency?: number;
  /**
   * Force wave-0 (the adapters with no dependencies — analyzer,
   * instruction-writer) to run sequentially
   * (concurrency=1) even when `concurrency` is set higher. Wave 1+
   * still runs with the configured concurrency. Default true.
   *
   * Rationale: Copilot / Claude / Codex treat parallel calls as a
   * burst and are more likely to rate-limit the wave. The wave-0
   * units are also the cheapest per-call, so the wall-clock cost
   * of serializing them is small (~2-4s) compared to the savings
   * in rate-limit risk. Set to false to restore the old parallel
   * behavior (e.g. for local engines with no quota). */
  sequentialWave0?: boolean;
  /**
   * Inter-unit delay (ms) inside a single wave. Default 0 (no
   * delay). When > 0, each unit waits `min + jittered(0..jitter)`
   * ms before starting, where `jitter` defaults to the same value.
   * Staggers parallel-ish calls so the engine sees a steadier
   * request stream instead of bursts. Pair with low `concurrency`
   * to mimic a sequential call shape while keeping wave structure. */
  interUnitDelayMs?: number;
  /** Test seam: forwards to `defaultAiInitDispatcher` when the default
   *  dispatcher is constructed. Mirrors `runAiInit`'s option. */
  engineCommandFn?: (engine: Engine) => EngineCommandResult;
  /** Test seam: forwards to `defaultAiInitDispatcher`. Mirrors
   *  `runAiInit`'s `spawner` option. */
  spawner?: AsyncSpawner;
  /** Test seam: per-unit engine-call timeout. Defaults to
   *  `AI_INIT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** CLI-side ctx7 auth state. false means generated instructions/specs use fallback. */
  ctx7Auth?: boolean;
  /**
   * P0-4: optional pre-flight quota state. When supplied and the
   * remaining quota is below `quotaSkipFinisherBelowPct` (default
   * 20%), the optional finisher unit (workflow-state-writer) is
   * NOT dispatched. It is reported as `skipped: low-quota`
   * on the workflow result so the user can see what was held back
   * and re-run `vf init` after the quota window resets to get the
   * rest. Phase-skill enrichment and the core adapters
   * (analyzer / instruction-writer / skill-curator / context-updater)
   * are NEVER skipped — they produce the reusable artifacts that
   * the rest of VibeFlow depends on. */
  quotaStatus?: QuotaStatus;
  /** Percent remaining (0-100) below which finishers are skipped.
   *  Default 20. Set to 0 to disable quota-aware skipping. */
  quotaSkipFinisherBelowPct?: number;
  /**
   * P1-4: backoff overrides for the default dispatcher. The CLI
   * init path sets `maxRetries=3` + `backoffCapMs=120_000` so a
   * transient 429 has 4 chances to recover with up to 2-minute
   * waits between tries. Other callers (e.g. `vf orchestrate`)
   * keep the strict defaults (2 retries, 60s cap) for faster
   * failure feedback. */
  dispatcherMaxRetries?: number;
  dispatcherBackoffBaseMs?: number;
  dispatcherBackoffCapMs?: number;
  /**
   * P1-7: collapse the optional finisher adapter into a
   * single `ai-init-finishers-batch` unit (default true). One
   * engine call. Set to false to restore the
   * per-finisher shape (used by tests that assert on individual
   * unit names). */
  batchFinishers?: boolean;
}

export {
  AI_CONTEXT_DIR,
  AI_INIT_TIMEOUT_MS,
  AUTOPILOT_MAX_RETRIES,
  CONTEXT_FALLBACK_ENGINE,
  INSTRUCTIONS_FILE,
  INSTRUCTION_FILES_BY_ENGINE,
  PERMISSION_DENIED_RE,
  UNAVAILABLE_RE,
};
