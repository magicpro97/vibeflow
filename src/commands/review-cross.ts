// src/commands/review-cross.ts
//
// A5 of the orchestrator-first plan (issue #171): `vf review --cross`.
//
// AUTO cross-debate — dispatches TWO engines (default: codex + claude)
// on the same target, extracts the disagreements, surfaces them
// to the human for resolution. AGREEMENTS are logged but not surfaced.
//
// Gated behind a pilot: per the A5 spec, the auto cross-debate must
// NOT ship unless a one-week measurement on 5 real plans shows a
// disagreement rate > 30%. The pilot data is stored at
// `.vibeflow/knowledge/cross-debate-pilot.json`.
//
// A4 HUMAN-ONLY guard refuses `--auto` and `VF_REVIEW_AUTO=1`.
// The `--cross` flag is the EXPLICIT opt-in (per the A5 spec) and
// is NOT refused. Combining `--cross` with `--auto` is a conflict
// (exit 1).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_REVIEW_ENGINE,
  type ReviewTarget,
  type ReviewVerdict,
  c,
  cwd,
  out,
  parseReviewVerdict,
  readTargetContent,
} from "./_shared.js";

/** Default review pair for the cross-debate. The first engine is
 *  the "primary" (its verdict is reported first in the
 *  disagreements summary). */
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
  /** True when one or both engines produced ok:true but unparseable
   *  output (so the verdict is a forced fallback, not a real signal).
   *  Used to keep the pilot data honest about parse failures. */
  parseFailed?: boolean;
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

/** Append a single encounter to the pilot data file. */
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
 *  both verdicts, surfaces disagreements, logs the encounter. */
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
    engines?: readonly [string, string];
  } = {},
): Promise<number> {
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

  let target: ReviewTarget;
  let targetId: string;
  switch (args.length) {
    case 0:
      out("vf", c.red("vf review --cross <target> <id>: missing target"), {
        level: "error",
      });
      return 2;
    case 1:
      target = "plan";
      targetId = args[0] ?? "";
      break;
    default:
      target = args[0] as ReviewTarget;
      targetId = args[1] ?? "";
      break;
  }
  if (target !== "plan" && target !== "commit" && target !== "unit") {
    out("vf", c.red(`vf review --cross: unknown target "${target}".`), {
      level: "error",
    });
    return 2;
  }
  if (!targetId) {
    out("vf", c.red(`vf review --cross ${target}: missing id.`), { level: "error" });
    return 2;
  }

  const engines = inject.engines ?? DEFAULT_CROSS_ENGINES;
  const [primary, secondary] = engines;
  if (!primary || !secondary) {
    out("vf", c.red("vf review --cross: need 2 engines in the pair."), {
      level: "error",
    });
    return 2;
  }

  const targetContent = readTargetContent(target, targetId, inject, inject.revParseShow);
  if (!targetContent) {
    out("vf", c.red(`vf review --cross ${target} ${targetId}: target content not found.`), {
      level: "error",
    });
    return 1;
  }

  const dispatch = inject.dispatch;
  if (!dispatch) {
    out("vf", c.red("vf review --cross: no dispatch inject provided"), {
      level: "error",
    });
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
      { level: "error" },
    );
    return 1;
  }
  if (!secondaryResult.ok) {
    out(
      "vf",
      c.red(
        `vf review --cross: ${secondary} dispatch failed: ${secondaryResult.reason ?? "unknown"}`,
      ),
      { level: "error" },
    );
    return 1;
  }

  const primaryParsed = parseReviewVerdict(primaryResult.raw);
  const secondaryParsed = parseReviewVerdict(secondaryResult.raw);
  // If either parse fails, treat as a forced disagreement (the engine
  // returned ok:true but produced unparseable output — that's a
  // signal worth surfacing to the human, not silently logging as
  // agreement). Both sides fall back to "block" so the disagreement
  // path fires; a parse-failure fallback is NOT a real signal.
  const primaryParseFailed = primaryParsed === null;
  const secondaryParseFailed = secondaryParsed === null;
  const primaryVerdict: ReviewVerdict = primaryParsed?.verdict ?? "block";
  const secondaryVerdict: ReviewVerdict = secondaryParsed?.verdict ?? "block";
  const primarySummary = extractSummary(primaryResult.raw);
  // A true agreement requires BOTH engines to produce a real verdict.
  const agreement =
    primaryVerdict === secondaryVerdict && !primaryParseFailed && !secondaryParseFailed;

  if (primaryParseFailed) {
    out(
      "vf",
      c.yellow(
        `vf review --cross: ${primary} returned ok:true but its output was unparseable. Surfacing as disagreement.`,
      ),
      { meta: { kind: "cross-parse-failed", engine: primary, side: "primary" } },
    );
  }
  if (secondaryParseFailed) {
    out(
      "vf",
      c.yellow(
        `vf review --cross: ${secondary} returned ok:true but its output was unparseable. Surfacing as disagreement.`,
      ),
      { meta: { kind: "cross-parse-failed", engine: secondary, side: "secondary" } },
    );
  }

  const encounter: PilotEncounter = {
    timestamp: new Date().toISOString(),
    target,
    targetId,
    engines,
    verdicts: [primaryVerdict, secondaryVerdict],
    agreement,
    primarySummary,
    parseFailed: primaryParseFailed || secondaryParseFailed,
  };
  appendPilotData(encounter);

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

  if (agreement) {
    out("vf", c.green(`both engines agree: ${primaryVerdict}. (logged, not surfaced)`));
    return 0;
  }

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
 *  fall back to the first non-empty line. */
function extractSummary(raw: string): string {
  const blocks = Array.from(raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g));
  if (blocks.length === 0) {
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
 *  "second opinion" reminder. */
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
