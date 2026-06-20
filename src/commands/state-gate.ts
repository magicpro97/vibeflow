// src/commands/state-gate.ts
//
// Extracted from state.ts to keep that file under the 400-line cap
// (issue #80 plan, the per-file 400-line cap is enforced by the
// file-size gate at scripts/check-file-size.cjs).
//
// This module holds `assertCoordBriefReady` — the A1 FU #199 shared
// gate that checks shape + freshness. Both `coord()` and `init()`
// use it for consistency.
//
// Pure logic, no I/O of its own (the inject seam provides existsSync
// + readFileSync + statSync).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIEF_FRESH_MS, BRIEF_PATH, c, isBriefFresh, out, validateBriefShape } from "./_shared.js";
import type { BriefInject, OutFn } from "./_shared.js";

/** A1 FU #199: combined gate (shape + freshness) used by both
 *  `coord()` and `init()` so the two paths stay consistent. Returns:
 *  - 0: brief is ready (shape OK + fresh)
 *  - 1: brief is missing or stale or shape-invalid
 *
 *  The `out` channel reports the specific reason (shape vs freshness)
 *  so the operator knows which step to fix. Per the A1 cross-review:
 *  "The order itself (exist → shape → fresh → spawn → deny-list) is
 *   correct — shape before freshness because a malformed brief is a
 *   hard error regardless of timestamp; freshness is perishable so
 *   it's a soft gate. Shape must be a hard refusal (exit 1), not a
 *   warning."
 */
export function assertCoordBriefReady(
  base: string,
  nowMs: number,
  inject: BriefInject = {},
  outFn: OutFn = out,
): number {
  const _exists = inject.existsSync ?? existsSync;
  const _read = inject.readFileSync ?? readFileSync;
  const path = join(base, BRIEF_PATH);
  if (!_exists(path)) {
    outFn("vf", c.red(`no brief at ${BRIEF_PATH}. Run \`vf state brief write\` to create one.`), {
      level: "error",
    });
    return 1;
  }
  const raw = _read(path, "utf8");
  const shape = validateBriefShape(raw);
  if (!shape.ok) {
    outFn(
      "vf",
      c.red(
        `brief is missing ${shape.missing.length} canonical section(s): ${shape.missing.join(", ")}. Run \`vf state brief write\` to repair, then \`vf state brief --consult\`.`,
      ),
      { level: "error" },
    );
    return 1;
  }
  if (!isBriefFresh(base, nowMs, inject)) {
    outFn(
      "vf",
      c.red(
        `brief is stale (or missing) at ${BRIEF_PATH}. Run \`vf state brief --consult\` first. (freshness window: ${Math.round(BRIEF_FRESH_MS / 1000)}s)`,
      ),
      { level: "error" },
    );
    return 1;
  }
  outFn("vf", c.dim("brief is ready; --coord gate passed"));
  return 0;
}
