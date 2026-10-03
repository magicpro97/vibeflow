// src/commands/dispatch-reviewer-llm.ts
//
// ADR-001 phase 2: LLM review layer that fires after the local makeReviewer gate passes.
import { spawnSync } from "node:child_process";
import { ENGINES, type Engine } from "../core.js";
import { LOG_CHANNEL } from "../core/log-contract.js";
import { type OwnedAiRouteRunner, runOwnedAiRoute } from "../dispatch/owned-ai-route.js";
import { outBusOnly } from "../logbus.js";
import { resolveReviewerEngine } from "../review-engine.js";
import { outcomeProbe, tuningFor, withTypesafeGuard } from "../typesafe-health.js";
import type { TypesafeSettings } from "../typesafe-settings.js";
// TYPE-ONLY: erased at compile time, so it evaluates nothing. The HTTP client module is loaded
// by the `await import` inside the gate in `runLLMReview` (C27-c).
import type { judgeAssessment } from "../typesafe.js";
import { buildReviewerPrompt } from "./orchestrate-reviewer.js";
import { parseGoalScore } from "./tools-detect.js";

/** The System One seam. Everything is injected so a test never opens a socket and a test's
 *  `userRoot` keeps the breaker's health record in a temp dir. */
export interface ReviewerTypesafeOpts {
  judge?: typeof judgeAssessment;
  settings?: TypesafeSettings;
  env?: NodeJS.ProcessEnv;
  /** Forwarded VERBATIM into `withTypesafeGuard`'s `HealthIo`. */
  userRoot?: string;
}

export interface LLMReviewOpts {
  goal: string;
  spec?: string;
  diff: string;
  llmFn?: (prompt: string) => Promise<string>;
  ownedRoute?: OwnedAiRouteRunner;
  cwd?: string;
  /** The engine that implemented the unit — the reviewer auto-picks a DIFFERENT
   *  tool than this (ADR-001 cross-tool review). */
  implementer?: string;
  /** Engines detected as ready (vf doctor / engineReady probe). */
  available?: string[];
  typesafe?: ReviewerTypesafeOpts;
}

/** The judge's contribution to the audit record. It NEVER participates in `pass`/`reason`/
 *  `score` on the `source: "engine"` branch — it is there so a judge/engine disagreement is
 *  visible after the fact. */
export interface ReviewerJudgeRecord {
  source: "jev" | "engine";
  model?: string;
  confidence?: number;
  latencyMs?: number;
  /** Set ONLY on the passing fall-through branch (the judge said pass AND the engine ran). */
  agreed?: boolean;
}

export interface LLMReviewResult {
  pass: boolean;
  reason: string;
  /** #545: calibrated judge score 0..1 parsed from the reviewer's trailing SCORE line. */
  score?: number;
  /** The reviewer engine chosen (cross-tool: different from implementer when possible). */
  reviewerEngine?: string;
  /** Same-family warning when the reviewer engine == the implementer's. */
  warning?: string;
  /** Present on EVERY result: the engine's own verdict is always the returned one. */
  judge?: ReviewerJudgeRecord;
}

/** The per-call System One audit record. Bus-only by construction (`outBusOnly` writes the
 *  durable event when a bus exists and no-ops otherwise), so a reviewer run never tees a
 *  per-call line to the console. `score`/`confidence` appear only for an answer that cleared
 *  `runAtConfidence`; `agreed` only for one that also reached the accept branch. */
function auditJudge(
  model: string,
  ms: number,
  detail: {
    score?: number;
    confidence?: number;
    agreed?: boolean;
    phase: "short-circuit" | "fall-through";
  },
): void {
  outBusOnly(LOG_CHANNEL.HOOK, `System One judge (reviewer): ${detail.phase}`, {
    meta: {
      kind: "typesafe",
      caller: "reviewer",
      model,
      ms,
      ...(detail.score === undefined ? {} : { score: detail.score }),
      ...(detail.confidence === undefined ? {} : { confidence: detail.confidence }),
      ...(detail.agreed === undefined ? {} : { agreed: detail.agreed }),
    },
  });
}

/**
 * ADR-001: LLM review after local gate passes.
 * Reviewer sees ONLY goal+spec+diff (buildReviewerPrompt strips dispatch context).
 * Reviewer engine is auto-routed to a DIFFERENT tool than the implementer when a
 * second engine is available (resolveReviewerEngine), reducing correlated approval.
 * Injectable llmFn keeps this unit-testable without a real engine.
 */
export async function runLLMReview(opts: LLMReviewOpts): Promise<LLMReviewResult> {
  const { engine: reviewerEngine, warning } = resolveReviewerEngine({
    env: process.env.VF_REVIEW_ENGINE,
    implementer: opts.implementer,
    available: opts.available,
  });
  if (!(ENGINES as readonly string[]).includes(reviewerEngine)) {
    throw new Error(`unsupported reviewer engine: ${reviewerEngine}`);
  }
  const prompt = buildReviewerPrompt({ goal: opts.goal, spec: opts.spec, diff: opts.diff });

  // Declared OUTSIDE the judge block: the passing branch falls through, so the engine result
  // below is the one that carries the judge's recorded (non-authoritative) opinion.
  let recorded: { model: string; ms: number; confidence: number; saidPass?: boolean } | undefined;
  const { judge, settings, env, userRoot } = opts.typesafe ?? {};
  // `timeoutMs` arrives COERCED (500-10 000 ms): the only production caller forwards
  // `readSettings` output (`dispatch-reviewer.ts`); a hand-built block is its embedder's contract.
  const timeoutMs = settings?.timeoutMs;
  if (settings?.enabled && settings.callSites.reviewer && timeoutMs !== undefined) {
    // C27-c: `src/typesafe.ts` (the HTTP client) is evaluated ONLY here, inside the gate — a
    // disabled run, or `callSites.reviewer: false`, never loads it. The injectable double still
    // wins, so a test's `judge` is what actually runs.
    const judgeFn = judge ?? (await import("../typesafe.js")).judgeAssessment;
    // Defence layer 4: the guard classifies the outcome, updates the breaker and hands back
    // `null` on ANY failure — so a throwing judge can never reject out of `runLLMReview` and
    // abort the run, and no HTTP is attempted while the breaker is `open`.
    // The classified-failure channel. `judgeAssessment` collapses `{ ok: false, class }` to
    // `null`, so the outcome the vendor actually returned reaches the breaker ONLY through this
    // probe — without it a 401/429/422/5xx is indistinguishable from "no answer" and would be
    // recorded as a SUCCESS, leaving the streak/trip ladder unreachable.
    const startedAt = performance.now();
    const probe = outcomeProbe();
    const result = await withTypesafeGuard(
      "reviewer",
      () =>
        judgeFn(opts.diff, {
          settings,
          env,
          goal: opts.goal,
          timeoutMs,
          onOutcome: probe.onOutcome,
          ...(userRoot === undefined ? {} : { userRoot }),
        }),
      {
        ...(userRoot === undefined ? {} : { userRoot }),
        out: outBusOnly,
        tuning: tuningFor(settings),
        outcome: probe.outcome,
      },
    );
    // The `runAtConfidence` FLOOR (Behaviour item 3) — the discard gate, and the ONLY
    // consumer of that setting. An answer below the floor is dropped whole: `recorded` stays
    // undefined, so nothing below it records a confidence or reaches the accept check, and
    // the path is byte-identical to a `null` judge. Two comparisons, not one: the floor
    // decides whether the answer exists, `acceptAtConfidence` decides whether it may act.
    // A score answer with NO confidence field reads as zero, so a bare score can never act.
    const confidence = result?.covers.confidence ?? 0;
    // Absence discards OUTRIGHT, not merely compared: `?? 0` alone stops discarding at the
    // clamp (0), where a bare score cleared both gates although the note above promises it
    // never acts. `confidence` still feeds the audit record below.
    if (
      result !== null &&
      result.covers.confidence !== undefined &&
      confidence >= settings.runAtConfidence
    ) {
      const ms = Math.round(performance.now() - startedAt);
      // JUDGE-ESCALATE-ONLY (see § Judge authority): the judge may short-circuit ONLY the
      // failing branch. `opts.diff` is written by whoever opened the pull request, so a
      // confident `pass` must not be the reason `makeVibflowLLMFn` is skipped — on that
      // branch we fall through and let the engine decide, recording its agreement for audit.
      if (confidence >= settings.acceptAtConfidence) {
        const score = result.covers.score;
        const testsOk = result.tests ? result.tests.noul >= settings.judgeTestFloor : true;
        if (score < settings.judgePassLevel || !testsOk) {
          // `goal_score` is a 0..1 contract, so the normalization CLAMPS a vendor overshoot
          // back into range rather than handing the caller 4/3.
          const normalized = Math.min(1, Math.max(0, score / settings.judgeScoreLevels));
          auditJudge(settings.model, ms, {
            score: normalized,
            confidence,
            phase: "short-circuit",
          });
          return {
            pass: false,
            reason: `System One judge: score ${score.toFixed(2)} / tests ${result.tests ? result.tests.noul.toFixed(2) : "n/a"}`,
            score: normalized,
            reviewerEngine: "typesafe",
            judge: { source: "jev", model: settings.model, confidence, latencyMs: ms },
          };
        }
        // Passing branch: NO early return. Remember the opinion, then continue to the engine.
        recorded = { model: settings.model, ms, confidence, saidPass: true };
      } else {
        // Between the floor and accept: a recorded second opinion that decides nothing.
        recorded = { model: settings.model, ms, confidence };
      }
    }
  }

  const llmFn =
    opts.llmFn ??
    makeVibflowLLMFn(
      reviewerEngine as Engine,
      opts.ownedRoute ?? runOwnedAiRoute,
      opts.cwd ?? process.cwd(),
    );
  if (!llmFn) throw new Error("VIBEFLOW_AI is not set");
  const raw = await llmFn(prompt);
  const pass = /^COVERED/i.test(raw.trim());
  const reason = pass ? "LLM reviewer: COVERED" : `LLM reviewer: ${raw.trim().slice(0, 300)}`;
  const score = parseGoalScore(raw);
  // The engine's verdict is the returned verdict. The judge's opinion rides along, recorded
  // and never consulted: `agreed: false` is the judge/engine disagreement signal, and it
  // changes nothing above. `agreed` exists only once the judge REACHED the accept branch, so
  // a below-accept answer records a confidence and no agreement — it was never allowed to act.
  const agreed = recorded?.saidPass === undefined ? undefined : recorded.saidPass === pass;
  if (recorded !== undefined) {
    auditJudge(recorded.model, recorded.ms, {
      confidence: recorded.confidence,
      ...(agreed === undefined ? {} : { agreed }),
      phase: "fall-through",
    });
  }
  return {
    pass,
    reason,
    reviewerEngine,
    ...(score !== undefined ? { score } : {}),
    ...(warning ? { warning } : {}),
    judge: {
      source: "engine",
      ...(recorded === undefined ? {} : { confidence: recorded.confidence }),
      ...(agreed === undefined ? {} : { agreed }),
    },
  };
}

/** Get git diff for a set of file paths relative to cwd.
 *  Result form: `ok` distinguishes a genuine empty diff (ok:true, "") from a git failure
 *  (ok:false) so a security caller can fail CLOSED instead of treating "couldn't read" as
 *  "nothing risky". `diff` is UNtruncated — callers that only want a bounded preview truncate
 *  themselves (see {@link getUnitDiff}). */
export function getUnitDiffResult(
  cwd: string,
  scope: string[],
  _spawn = spawnSync,
): { diff: string; ok: boolean } {
  try {
    const args = ["diff", "HEAD~1", "HEAD", "--", ...(scope.length ? scope : ["."])];
    const r = _spawn("git", args, { encoding: "utf8", cwd });
    // A non-zero exit (bad revision, not a repo, git missing) means we could NOT read the
    // diff — surface it as ok:false rather than an empty (but "successful") diff.
    if (r.status !== 0 || r.error) return { diff: "", ok: false };
    return { diff: (r.stdout as string) ?? "", ok: true };
  } catch {
    return { diff: "", ok: false };
  }
}

/** Get git diff for a set of file paths relative to cwd, truncated to a bounded preview.
 *  Back-compat shape used by the LLM reviewer (a truncated prompt is fine there). Swallows
 *  git failure to `""` — do NOT use for security decisions; use {@link getUnitDiffResult}. */
export function getUnitDiff(cwd: string, scope: string[], _spawn = spawnSync): string {
  return getUnitDiffResult(cwd, scope, _spawn).diff.slice(0, 4000);
}

/**
 * Build an llmFn that calls VIBEFLOW_AI bridge (same bridge as dispatch).
 * Returns undefined when VIBEFLOW_AI is not set — caller skips LLM review.
 * ponytail: only bridge mode; add cli-engine path when needed.
 */
export function makeVibflowLLMFn(
  engine: Engine,
  ownedRoute: OwnedAiRouteRunner = runOwnedAiRoute,
  cwd = process.cwd(),
): ((prompt: string) => Promise<string>) | undefined {
  const cmd = process.env.VIBEFLOW_AI;
  if (!cmd) return undefined;
  return async (prompt: string): Promise<string> => {
    const result = await ownedRoute({
      engine,
      command: cmd,
      input: prompt,
      cwd,
      shell: true,
      timeoutMs: 30_000,
    });
    return result.stdout;
  };
}
