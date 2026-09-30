// The System One (Jev) verdict for the goal-coverage call site. Lifted out of
// `src/commands/tools-detect.ts` so that file stays under the 400-line cap; the gate travels with
// the code so a disabled run still never reaches the judge.
//
// C27-c: `src/typesafe.ts` (the HTTP client) is evaluated ONLY here, inside the gate, and the
// injectable double still wins — so a disabled run never loads the client module.
import { outBusOnly } from "../logbus.js";
import { outcomeProbe, tuningFor, withTypesafeGuard } from "../typesafe-health.js";
import type { TypesafeSettings } from "../typesafe-settings.js";
import type { judgeAssessment } from "../typesafe.js";

/** A refusal the caller may short-circuit on. A confident `covered: true` is NOT one of these:
 *  see JUDGE-ESCALATE-ONLY below. */
export type GoalCoverageVerdict = { covered: false; uncovered: string[]; score: number };

/**
 * Returns the judge's refusal, or `null` when the call site is off, the block is disabled, or the
 * judge was confident the goal IS covered. `null` means "fall through unchanged", never "allowed".
 */
export async function typesafeGoalCoverageVerdict(input: {
  goal: string;
  diff: string;
  judge?: typeof judgeAssessment;
  settings?: TypesafeSettings;
  env?: NodeJS.ProcessEnv;
  /** Forwarded VERBATIM into `withTypesafeGuard`'s `HealthIo`. */
  userRoot?: string;
}): Promise<GoalCoverageVerdict | null> {
  const { goal, diff, judge, settings, env, userRoot } = input;
  const timeoutMs = settings?.timeoutMs;
  if (!settings?.enabled || !settings.callSites.goalCoverage || timeoutMs === undefined) {
    return null;
  }
  const judgeFn = judge ?? (await import("../typesafe.js")).judgeAssessment;
  // Defence layer 4: the guard classifies the outcome, updates the breaker and hands back
  // `null` on ANY failure, so a throwing judge never rejects out of the caller.
  //
  // `outcome: probe.outcome` is REQUIRED, not decoration. The guard reads `inject.outcome?.()`
  // and falls back to `FAILURE_CLASS.NONE`, so a guard call that omits it records every vendor
  // failure as a SUCCESS: the failStreakLimit ladder never advances, the file-backed breaker
  // never trips, and a run against a rotated-away key looks healthy forever. `judgeAssessment`
  // never throws (classified failures collapse to null), so the guard's catch arm cannot
  // classify in its place. Mirrors src/commands/dispatch-reviewer-llm.ts.
  const probe = outcomeProbe();
  const j = await withTypesafeGuard(
    "goalCoverage",
    () =>
      judgeFn(diff || "(no diff available)", {
        settings,
        env,
        goal,
        timeoutMs,
        onOutcome: probe.onOutcome,
      }),
    {
      ...(userRoot === undefined ? {} : { userRoot }),
      out: outBusOnly,
      tuning: tuningFor(settings),
      outcome: probe.outcome,
    },
  );
  // The `acceptAtConfidence` FLOOR: an answer below it is dropped whole, so the path is
  // byte-identical to a `null` judge. A score answer with NO confidence reads as zero.
  const confidence = j?.covers.confidence ?? 0;
  // JUDGE-ESCALATE-ONLY (see § Judge authority): `diff` and `goal` are both
  // attacker-influenced (a diff is written by whoever opened the PR, a goal can come from an
  // issue body), so only the NEGATIVE answer may short-circuit. A confident `covered: true`
  // falls through and the bridge in the caller decides — the bridge is authoritative for a
  // POSITIVE coverage claim.
  if (j !== null && confidence >= settings.acceptAtConfidence) {
    const covered =
      j.covers.score >= settings.judgePassLevel && (j.tests?.noul ?? 1) >= settings.judgeTestFloor;
    if (!covered) {
      // `score` is a 0..1 contract, so normalization CLAMPS a vendor overshoot into range.
      return {
        covered: false,
        uncovered: [
          `System One judge score ${j.covers.score.toFixed(2)} (confidence ${confidence.toFixed(2)})`,
        ],
        score: Math.min(1, Math.max(0, j.covers.score / settings.judgeScoreLevels)),
      };
    }
  }
  return null;
}
