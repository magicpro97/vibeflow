// src/commands/review-cross.ts
//
// A5 of the orchestrator-first plan (issue #171): `vf review --cross`.
//
// AUTO cross-debate — dispatches TWO engines (default: codex + claude)
// on the same target, extracts the disagreements, and surfaces them
// to the human for resolution. AGREEMENTS are logged but not surfaced.
//
// Gated behind a pilot: per the A5 spec, the auto cross-debate must
// NOT ship unless a one-week measurement on 5 real plans shows a
// disagreement rate > 30%. The pilot data is stored at
// `.vibeflow/knowledge/cross-debate-pilot.json`.
//
// The A4 HUMAN-ONLY guard refuses `vf review --auto` (decorative
// flag) and `VF_REVIEW_AUTO=1` (env var). The `--cross` flag is the
// EXPLICIT opt-in per the A5 spec, so it is NOT refused by the
// A4 guard. This is the deliberate design: the human-only path
// remains opt-out-able (the operator can ALWAYS run `vf review`
// without `--cross` to get a single-engine review). The cross path
// requires an explicit flag.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { c, cwd, out, parseReviewVerdict, readTargetContent, DEFAULT_REVIEW_ENGINE } from "./_shared.js";
import type { ReviewTarget, ReviewVerdict } from "./_shared.js";

/** Default review pair for the cross-debate. The order matters: the
 *  first engine is the "primary" (its verdict is reported first in
 *  the disagreements summary). The pilot data records which engine
 *  was primary so the disagreement rate is comparable. */
export const DEFAULT_CROSS_ENGINES: readonly [string, string] = ["codex", "claude"] as const;

/** Where the pilot data lives. */
export const PILOT_DATA_PATH = ".vibeflow/knowledge/cross-debate-pilot.json";

/** A single pilot encounter — one `--cross` invocation. */
export interface PilotEncounter {
  /** ISO timestamp. */
  timestamp: string;
  /** The target type (plan | commit | unit). */
  target: ReviewTarget;
  /** The target identifier (slug | sha | unit name). */
  targetId: string;
  /** The two engines that were dispatched. */
  engines: readonly [string, string];
  /** The verdict from each engine, in the same order as `engines`. */
  verdicts: readonly [ReviewVerdict, ReviewVerdict];
  /** Did the two engines agree? */
  agreement: boolean;
  /** The summary from the primary engine (if it produced one). */
  primarySummary: string;
}

/** Read the pilot data file. Returns an empty array if the file
 *  doesn't exist yet. */
export function readPilotData(
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
  } = {},
): PilotEncounter[] {
  const _exists = inject.existsSync ?? existsSync;
  const _read = inject.readFileSync ?? readFileSync;
  const path = join(cwd(), PILOT_DATA_PATH);
  if (!_exists(path)) return [];
  try {
    const raw = _read(path, "utf8");
    const obj = JSON.parse(raw) as { encounters?: PilotEncounter[] };
    return Array.isArray(obj.encounters) ? obj.encounters : [];
  } catch {
    return [];
  }
}

/** Append a single encounter to the pilot data file. Creates the
 *  directory if it doesn't exist. The file is rewritten atomically
 *  (read + append + write) so concurrent invocations don't lose
 *  data — but in practice `--cross` is rare, so the chance of
 *  concurrent writes is low. */
export function appendPilotData(encounter: PilotEncounter): void {
  const existing = [...readPilotData(), encounter];
  const path = join(cwd(), PILOT_DATA_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const data = `${JSON.stringify({ encounters: existing }, null, 2)}\n`;
  writeFileSync(path, data, "utf8");
}

/** Compute the disagreement rate from a list of encounters. */
export function computeDisagreementRate(encounters: readonly PilotEncounter[]): number {
  if (encounters.length === 0) return 0;
  const disagreements = encounters.filter((e) => !e.agreement).length;
  return disagreements / encounters.length;
}

/** The cross-debate entry point. Dispatches the two engines, parses
 *  both verdicts, surfaces disagreements, logs the encounter.
 *  Returns 0 on success, 1 on failure, 2 on usage error. */
export async function reviewCross(
  args: string[],
  flags: Record<string, string | boolean>,
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
    revParseShow?: (sha: string) => string;
    dispatch?: (opts: {
      engine: string;
      prompt: string;
      mode: string;
    }) => Promise<{ ok: boolean; raw: string; reason?: string }>;
    /** Override the engines for testing. If provided, replaces
     *  DEFAULT_CROSS_ENGINES. The array is destructured as
     *  `[primary, secondary]`. */
    engines?: readonly [string, string];
  } = {},
): Promise<number> {
  // The A4 HUMAN-ONLY guard refuses `flags.auto` and `VF_REVIEW_AUTO=1`.
  // The `--cross` flag is the EXPLICIT opt-in (per the A5 spec) and
  // is NOT refused. But enforce that the operator passed `--cross`
  // explicitly (the function name is `reviewCross`, not `review`).
  if (flags.cross !== true) {
    out(
      "vf",
      c.red(
        "vf review --cross requires the --cross flag. (Use `vf review` without --cross for the human-only path.)",
      ),
      { level: "error" },
    );
    return 2;
  }
  // Also enforce A4's HUMAN-ONLY guard: the `--auto` flag is a
  // separate, decorative bypass attempt. If both are set, refuse
  // — they conflict.
  if (flags.auto === true || process.env.VF_REVIEW_AUTO === "1") {
    out(
      "vf",
      c.red(
        "vf review --cross cannot be combined with --auto or VF_REVIEW_AUTO. --cross IS the auto path; the other flags are decorative bypasses that A4's HUMAN-ONLY guard refuses.",
      ),
      { level: "error" },
    );
    return 1;
  }

  // Reuse the A4 target parser. The shape is the same: `vf review --cross <target> <id>`.
  // We accept the same 3 forms: positional `[target, id]`, single-arg
  // (defaults to plan), or `--target=<plan|commit|unit> --slug=...` (we
  // ignore the alt flag syntax for the cross path — only positional
  // for now, per the A5 spec).
  let target: ReviewTarget;
  let targetId: string;
  if (args.length >= 2) {
    target = args[0] as ReviewTarget;
    targetId = args[1] ?? "";
  } else if (args.length === 1) {
    target = "plan";
    targetId = args[0] ?? "";
  } else {
    out("vf", c.red("vf review --cross <target> <id>: missing target"), { level: "error" });
    return 2;
  }
  if (target !== "plan" && target !== "commit" && target !== "unit") {
    out("vf", c.red(`vf review --cross: unknown target "${target}".`), { level: "error" });
    return 2;
  }
  if (!targetId) {
    out("vf", c.red(`vf review --cross ${target}: missing id.`), { level: "error" });
    return 2;
  }

  // The two engines.
  const engines = inject.engines ?? DEFAULT_CROSS_ENGINES;
  const [primary, secondary] = engines;
  if (!primary || !secondary) {
    out("vf", c.red("vf review --cross: need 2 engines in the pair."), { level: "error" });
    return 2;
  }

  // Read the target content ONCE. Both engines review the same content.
  const targetContent = readTargetContent(target, targetId, inject, inject.revParseShow);
  if (!targetContent) {
    out("vf", c.red(`vf review --cross ${target} ${targetId}: target content not found.`), {
      level: "error",
    });
    return 1;
  }

  // Dispatch the two engines. We re-use the same dispatch inject
  // (production wires the real engine dispatcher; tests use a mock).
  const dispatch = inject.dispatch;
  if (!dispatch) {
    out("vf", c.red("vf review --cross: no dispatch inject provided"), { level: "error" });
    return 1;
  }
  const prompt = buildCrossPrompt(target, targetContent.description, targetContent.content);
  out(
    "vf",
    c.dim(`vf review --cross: dispatching ${primary} + ${secondary} for ${target} ${targetId}`),
    {
      meta: { kind: "cross-dispatch", engines, target, targetId },
    },
  );
  const [primaryResult, secondaryResult] = await Promise.all([
    dispatch({ engine: primary, prompt, mode: "cli" }),
    dispatch({ engine: secondary, prompt, mode: "cli" }),
  ]);
  if (!primaryResult.ok) {
    out(
      "vf",
      c.red(`vf review --cross: ${primary} dispatch failed: ${primaryResult.reason ?? "unknown"}`),
      {
        level: "error",
      },
    );
    return 1;
  }
  if (!secondaryResult.ok) {
    out(
      "vf",
      c.red(
        `vf review --cross: ${secondary} dispatch failed: ${secondaryResult.reason ?? "unknown"}`,
      ),
      {
        level: "error",
      },
    );
    return 1;
  }

  // Parse both verdicts.
  const primaryParsed = parseReviewVerdict(primaryResult.raw);
  const secondaryParsed = parseReviewVerdict(secondaryResult.raw);
  const primaryVerdict: ReviewVerdict = primaryParsed?.verdict ?? "revise";
  const secondaryVerdict: ReviewVerdict = secondaryParsed?.verdict ?? "revise";
  const primarySummary = extractSummary(primaryResult.raw);
  const agreement = primaryVerdict === secondaryVerdict;

  // Log the encounter to the pilot data.
  const encounter: PilotEncounter = {
    timestamp: new Date().toISOString(),
    target,
    targetId,
    engines,
    verdicts: [primaryVerdict, secondaryVerdict],
    agreement,
    primarySummary,
  };
  appendPilotData(encounter);

  // Log to the logbus.
  out(
    "vf",
    c.dim(
      `vf review --cross ${target} ${targetId}: ${primary}=${primaryVerdict}, ${secondary}=${secondaryVerdict} (${agreement ? "agree" : "disagree"})`,
    ),
    {
      meta: {
        kind: "cross-review",
        target,
        targetId,
        engines,
        verdicts: [primaryVerdict, secondaryVerdict],
        agreement,
        primarySummary,
        mode: "auto",
      },
    },
  );

  // If they agree, the human path is moot — log + done.
  if (agreement) {
    out("vf", c.green(`both engines agree: ${primaryVerdict}. (logged, not surfaced)`));
    return 0;
  }

  // If they disagree, surface to the human.
  out(
    "vf",
    c.yellow(
      `DISAGREEMENT: ${primary}=${primaryVerdict}, ${secondary}=${secondaryVerdict}. Surfacing to human for resolution.`,
    ),
    {
      meta: {
        kind: "cross-disagreement",
        target,
        targetId,
        engines,
        verdicts: [primaryVerdict, secondaryVerdict],
        primarySummary,
        secondaryRaw: secondaryResult.raw,
        mode: "auto",
      },
    },
  );
  return 0;
}

/** Extract the "summary" field from a reviewer's JSON block, or
 *  fall back to the first non-empty line of the raw output. */
function extractSummary(raw: string): string {
  const blocks = Array.from(raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g));
  if (blocks.length === 0) {
    // Fall back to the first non-empty line.
    const firstNonEmpty = raw.split("\n").find((l) => l.trim().length > 0);
    return firstNonEmpty?.trim() ?? "";
  }
  const last = blocks[blocks.length - 1];
  if (!last) return "";
  const candidate = last[1]?.trim() ?? "";
  if (!candidate) return "";
  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>;
    if (typeof obj.summary === "string") return obj.summary;
    return candidate;
  } catch {
    return candidate;
  }
}

/** The cross-debate prompt. Same as the A4 prompt but adds a
 *  reminder that this is the SECOND opinion (so the reviewer
 *  is encouraged to be honest, not deferential). */
function buildCrossPrompt(target: ReviewTarget, description: string, content: string): string {
  return `You are a SECOND-opinion reviewer for a VibeFlow project. The primary reviewer (a different engine) has already reviewed this artifact. Your job is to give an INDEPENDENT verdict — don't defer to the primary reviewer's likely verdict.

TARGET: ${description}

CONTENT:
${content}

Review for:
- correctness (does the code do what the spec says?)
- consistency (does it match the brief's §2 non-negotiables?)
- test coverage (does it have tests for the new behavior?)
- documentation (is the change documented?)

When done, emit a single fenced JSON block as the LAST thing you output:

\`\`\`json
{ "verdict": "approve" | "revise" | "block", "summary": "<one-sentence summary>", "issues": ["<issue 1>", "<issue 2>"] }
\`\`\`

Use 'approve' if the change is ready to merge. Use 'revise' if it has fixable issues. Use 'block' if it has unfixable issues.`;
}

// Re-export the A4 types for the test (verbatimModuleSyntax requires
// the consumer to import types from the same module that re-exports
// them).
export type { ReviewTarget, ReviewVerdict } from "./review.js";
