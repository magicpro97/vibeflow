// src/review-engine.ts
//
// Reviewer-engine selection (ADR-001 hardening): prefer a reviewer running on a
// DIFFERENT tool than the implementer. Same model + different tool (claude-code
// vs codex vs copilot) = different ecosystem, system prompt, and harness — enough
// divergence to reduce correlated approval bias without a 2nd API key.

import { DEFAULT_REVIEW_ENGINE } from "./commands/review.js";

export interface PickOpts {
  /** Explicit --engine flag (highest priority). */
  flag?: string;
  /** VF_REVIEW_ENGINE env var. */
  env?: string;
  /** The engine that implemented the unit (auto-pick avoids this). */
  implementer?: string;
  /** Engines detected as ready (from vf doctor / engineReady probe). */
  available?: string[];
}

/** Resolve the reviewer engine. Priority: flag > env > different-from-implementer
 *  auto-pick > implementer (same-family fallback) > DEFAULT_REVIEW_ENGINE. */
export function pickReviewerEngine(opts: PickOpts): string {
  if (opts.flag?.trim()) return opts.flag;
  if (opts.env?.trim()) return opts.env;
  const available = opts.available ?? [];
  const different = available.find((e) => e !== opts.implementer);
  if (different) return different;
  if (opts.implementer && available.includes(opts.implementer)) return opts.implementer;
  return DEFAULT_REVIEW_ENGINE;
}

export interface ResolvedReviewer {
  /** The chosen reviewer engine. */
  engine: string;
  /** Set when the reviewer engine equals the implementer's — same-tool review
   *  has correlated blind spots. Surface it to the audit trail. */
  warning?: string;
}

/** Resolve the reviewer engine AND flag the same-family case. When the pick lands
 *  on the implementer's own engine (only one tool available, or explicitly forced),
 *  emit a warning: cross-tool review needs a 2nd engine (codex/copilot) installed. */
export function resolveReviewerEngine(opts: PickOpts): ResolvedReviewer {
  const engine = pickReviewerEngine(opts);
  if (opts.implementer && engine === opts.implementer) {
    return {
      engine,
      warning: `review(warn): reviewer engine "${engine}" == implementer — same-tool review has correlated blind spots; install a 2nd engine (codex/copilot) for cross-tool review`,
    };
  }
  return { engine };
}
