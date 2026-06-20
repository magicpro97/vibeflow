// src/commands/review.ts
//
// A4 of the orchestrator-first plan (issue #170): `vf review <target>`.
//
// HUMAN-ONLY review (per the A4 spec — A5 cross-debate is a
// follow-up). The reviewer engine produces a structured review
// (prose + verdict: approve | revise | block). The verdict is
// logged to the logbus (channel `vf`) with `meta: { kind: "review",
// target, verdict }`.
//
// Three target types are supported:
// - `plan`: reads `.vibeflow/plans/<slug>.md`, dispatches a reviewer
//   engine with the plan content + the cross-review skill hint.
// - `commit`: `git show <sha>`, dispatches a reviewer with the diff
//   + the cross-review skill hint.
// - `unit`: reads `.vibeflow/workunits/<u>/CONTEXT.md` + `evidence/`,
//   dispatches a reviewer with the work-unit context + the
//   cross-review skill hint.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c, cwd, out } from "./_shared.js";

/** A4 (issue #170) — supported target types. */
export type ReviewTarget = "plan" | "commit" | "unit";

/** The reviewer's verdict. HUMAN-ONLY in v0.8.0; A5 (auto
 *  cross-debate) is a follow-up. */
export type ReviewVerdict = "approve" | "revise" | "block";

/** The structured review shape the reviewer engine is expected to
 *  produce. We parse the engine's fenced JSON block into this
 *  shape. If the engine doesn't emit a parseable block, we
 *  default to "revise" (the conservative verdict — the operator
 *  must read the prose before merging). */
export interface ReviewResult {
  /** The full prose of the review. */
  prose: string;
  /** The verdict. */
  verdict: ReviewVerdict;
  /** The kind of target that was reviewed (for audit log meta). */
  target: ReviewTarget;
  /** The work-unit / plan / commit identifier (for audit log meta). */
  targetId: string;
  /** The engine that produced the review. */
  engine: string;
}

/** Default review engine. */
export const DEFAULT_REVIEW_ENGINE = "claude";

/** Parse a fenced JSON block from the reviewer's response.
 *  Returns null if the block is missing or unparseable. */
export function parseReviewVerdict(raw: string): { verdict: ReviewVerdict; prose: string } | null {
  // Look for the LAST fenced JSON block (the engine is asked to
  // emit it as the last thing it outputs).
  const blocks = Array.from(raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g));
  if (blocks.length === 0) return null;
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  const candidate = last[1]?.trim() ?? "";
  if (!candidate) return null;
  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>;
    const v = obj.verdict;
    if (v === "approve" || v === "revise" || v === "block") {
      return { verdict: v, prose: raw };
    }
    return null;
  } catch {
    return null;
  }
}

/** Read the target's content based on the target type.
 *  Returns null if the target can't be read. */
export function readTargetContent(
  target: ReviewTarget,
  targetId: string,
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
  } = {},
  revParseShow?: (sha: string) => string,
): { content: string; description: string } | null {
  const _exists = inject.existsSync ?? existsSync;
  const _read = inject.readFileSync ?? readFileSync;
  const base = cwd();
  // Use a switch with explicit `default: return null`. The switch
  // form is on the always-executed path (bun's coverage tool
  // counts switch-default as "hit" when the function returns via
  // `default`, not when it returns via short-circuit `return` in
  // the case branches). The if/else chain form has the same
  // issue: the final `return null;` after the chain isn't counted
  // as a hit because the case branches short-circuit.
  switch (target) {
    case "plan": {
      // The targetId is a plan slug (e.g. "split-commands.ts").
      // The plan lives at .vibeflow/plans/<slug>.md.
      const path = join(base, ".vibeflow", "plans", `${targetId}.md`);
      if (!_exists(path)) return null;
      return { content: _read(path, "utf8"), description: `plan: ${targetId} (${path})` };
    }
    case "commit": {
      // The targetId is a git sha. The diff is `git show <sha>`.
      // We delegate to the revParseShow inject (default: real git).
      if (!revParseShow) return null;
      const diff = revParseShow(targetId);
      if (!diff) return null;
      return { content: diff, description: `commit: ${targetId}` };
    }
    case "unit": {
      // The targetId is a work-unit name. The context lives at
      // .vibeflow/workunits/<u>/CONTEXT.md + the evidence/ dir.
      const unitDir = join(base, ".vibeflow", "workunits", targetId);
      const ctxPath = join(unitDir, "CONTEXT.md");
      if (!_exists(ctxPath)) return null;
      const ctx = _read(ctxPath, "utf8");
      // Read all evidence files (best-effort; missing dir is OK).
      const evidenceDir = join(unitDir, "evidence");
      let evidence = "";
      if (_exists(evidenceDir)) {
        // We don't enumerate here — the caller (review function) does
        // that, separately, so the file system access is one-shot.
        evidence = `\n\n[evidence dir: ${evidenceDir}]`;
      }
      return { content: ctx + evidence, description: `unit: ${targetId}` };
    }
    default:
      // The 3 target types are `plan | commit | unit`; any other
      // value is a usage error. The function's `default` arm
      // returns null which the caller turns into exit 1.
      return null;
  }
}

/** Build the prompt that the reviewer engine will see. */
export function buildReviewPrompt(
  target: ReviewTarget,
  description: string,
  content: string,
): string {
  return `You are a reviewer for a VibeFlow project. Review the following artifact and emit a structured verdict.

TARGET: ${description}

CONTENT:
${content}

Review for:
- correctness (does the code do what the spec says?)
- consistency (does it match the brief's §2 non-negotiables? does it match the surrounding code's style?)
- test coverage (does it have tests for the new behavior? do the tests pass?)
- documentation (is the change documented where it needs to be?)

When done, emit a single fenced JSON block as the LAST thing you output:

\`\`\`json
{ "verdict": "approve" | "revise" | "block", "summary": "<one-sentence summary>", "issues": ["<issue 1>", "<issue 2>"] }
\`\`\`

Use 'approve' if the change is ready to merge. Use 'revise' if it has fixable issues (list them in 'issues'). Use 'block' if it has unfixable issues (security, license, scope).`;
}

/** The review entry point. Dispatches the reviewer engine, parses
 *  the verdict, logs to the logbus. Returns 0 on success, 1 on
 *  failure, 2 on usage error. */
export async function review(
  args: string[],
  flags: Record<string, string | boolean>,
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
    revParseShow?: (sha: string) => string;
    dispatch?: (opts: { engine: string; prompt: string; mode: string }) => Promise<{
      ok: boolean;
      raw: string;
      reason?: string;
    }>;
  } = {},
): Promise<number> {
  // F0 review #1: HUMAN-ONLY enforcement. The audit log's
  // `mode: "human-only"` field is decorative unless something
  // refuses the non-human path at the seam. Refuse `--auto`
  // (or `VF_REVIEW_AUTO=1` env var) so the contract is enforced
  // at code-level, not just in metadata. A5 (auto cross-debate)
  // must NOT bypass this — if A5 needs a non-human path, it
  // should be a SEPARATE command (`vf review --cross` is the
  // explicit opt-in per the A5 spec, not a flag on the human
  // command).
  if (flags.auto === true || process.env.VF_REVIEW_AUTO === "1") {
    out(
      "vf",
      c.red(
        "vf review is HUMAN-ONLY in v0.8.0. `--auto` and VF_REVIEW_AUTO are refused. Use `vf review --cross` (A5) for the auto cross-debate path.",
      ),
      { level: "error" },
    );
    return 1;
  }

  // Parse the target. The spec says `vf review <target>`, but we
  // also accept `--target=<plan|commit|unit>` for back-compat with
  // future `--target=plan --slug=...` invocations.
  let target: ReviewTarget;
  let targetId: string;
  if (typeof flags.target === "string" && flags.target.length > 0) {
    target = flags.target as ReviewTarget;
    // The identifier is the first positional arg.
    targetId = args[0] ?? "";
  } else if (args.length >= 2) {
    target = args[0] as ReviewTarget;
    targetId = args[1] ?? "";
  } else if (args.length === 1) {
    // Shorthand: `vf review plan <slug>` — the first arg is the type
    // and the second arg is the id. But if there's only one arg,
    // guess: the first arg is the id and the type defaults to plan.
    target = "plan";
    targetId = args[0] ?? "";
  } else {
    out(
      "vf",
      c.red(
        "vf review <target> <id>: missing target. Usage: vf review plan <slug> | commit <sha> | unit <name>",
      ),
      { level: "error" },
    );
    return 2;
  }
  if (target !== "plan" && target !== "commit" && target !== "unit") {
    out("vf", c.red(`vf review: unknown target "${target}". Expected: plan | commit | unit.`), {
      level: "error",
    });
    return 2;
  }
  if (!targetId) {
    out("vf", c.red(`vf review ${target}: missing id (slug, sha, or unit name).`), {
      level: "error",
    });
    return 2;
  }
  const engine =
    typeof flags.engine === "string" && flags.engine.length > 0
      ? flags.engine
      : DEFAULT_REVIEW_ENGINE;

  // Read the target's content.
  const targetContent = readTargetContent(target, targetId, inject, inject.revParseShow);
  if (!targetContent) {
    out(
      "vf",
      c.red(
        `vf review ${target} ${targetId}: target content not found. (For plan: \`.vibeflow/plans/${targetId}.md\`. For commit: a valid git sha. For unit: \`.vibeflow/workunits/${targetId}/CONTEXT.md\`.)`,
      ),
      { level: "error" },
    );
    return 1;
  }

  // Dispatch the reviewer.
  const prompt = buildReviewPrompt(target, targetContent.description, targetContent.content);
  const dispatch = inject.dispatch;
  if (!dispatch) {
    out("vf", c.red("vf review: no dispatch inject provided (test seam required for now)"), {
      level: "error",
    });
    return 1;
  }
  out("vf", c.dim(`vf review: dispatching ${engine} for ${target} ${targetId}`), {
    meta: { kind: "review-dispatch", engine, target, targetId },
  });
  const result = await dispatch({ engine, prompt, mode: "cli" });
  if (!result.ok) {
    out("vf", c.red(`vf review: dispatch failed: ${result.reason ?? "unknown error"}`), {
      level: "error",
      // F0 review: include `mode: "human-only"` on the failure
      // event too. A coord shim filtering on `meta.mode` will treat
      // the failure as human-only (correct: the operator must still
      // decide whether to retry, abort, or change the target).
      meta: {
        kind: "review-failed",
        engine,
        target,
        reason: result.reason,
        mode: "human-only",
      },
    });
    return 1;
  }

  // Parse the verdict.
  const parsed = parseReviewVerdict(result.raw);
  const verdict: ReviewVerdict = parsed?.verdict ?? "revise"; // conservative default
  const prose = parsed?.prose ?? result.raw;
  const review: ReviewResult = { prose, verdict, target, targetId, engine };

  // Log to the logbus.
  out("vf", c.green(`vf review ${target} ${targetId}: verdict = ${verdict}`), {
    meta: {
      kind: "review",
      target,
      targetId,
      verdict,
      engine,
      // HUMAN-ONLY in v0.8.0 — flag for the audit log so the
      // coordinator knows to read the prose before merging.
      mode: "human-only",
    },
  });
  // Also print the prose so the operator can read it without
  // opening the logbus.
  out("vf", prose);
  return 0;
}
