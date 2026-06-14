import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type WorkflowState, strArray } from "./core.js";

export interface GateReport {
  ok: boolean;
  failures: string[];
  passed: string[];
  /**
   * Non-fatal advisories. The skill gate emits here; warnings NEVER affect `ok`.
   * The regex classifier and engine self-reported `skills_used` are too weak to FAIL on.
   */
  warnings: string[];
}

/** Normalize a scope glob/prefix to a comparable path prefix. */
function normPrefix(s: string): string {
  return s.replace(/\*+$/, "").replace(/\/+$/, "");
}

/** Two scope prefixes overlap when one is a path-prefix of the other. */
function prefixesOverlap(a: string, b: string): boolean {
  if (a === "" || b === "") return true; // an empty scope means "whole repo"
  return (
    a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || a.startsWith(b) || b.startsWith(a)
  );
}

/** Detect overlapping scopes among proposed units (for the planner, before dispatch). */
export function findScopeConflicts(
  units: Array<{ name: string; scope?: string[] }>,
): Array<[string, string]> {
  const conflicts: Array<[string, string]> = [];
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i];
      const b = units[j];
      const sa = (a?.scope ?? []).map(normPrefix);
      const sb = (b?.scope ?? []).map(normPrefix);
      if (!sa.length || !sb.length) continue;
      if (sa.some((pa) => sb.some((pb) => prefixesOverlap(pa, pb)))) {
        conflicts.push([a?.name ?? "?", b?.name ?? "?"]);
      }
    }
  }
  return conflicts;
}

/**
 * The three policy gates that compose with build/lint/test (WORK_UNIT_ORCHESTRATION.md):
 *  - confidence: no work unit may sit below 1.0 (orchestrator is still guessing).
 *  - evidence:   a unit marked `done` must carry recorded evidence.
 *  - scope:      no two units may declare overlapping file scopes (parallel safety).
 * Pure over a WorkflowState so it is unit-testable and reusable by hooks + `vf verify`.
 */
export function policyGates(state: WorkflowState | null): GateReport {
  const failures: string[] = [];
  const passed: string[] = [];
  const warnings: string[] = [];
  if (!state) {
    return {
      ok: true,
      failures: [],
      passed: ["no workflow state — nothing to gate"],
      warnings: [],
    };
  }
  const units = state.work_units ?? [];

  // Confidence gate.
  const lowConf = units.filter((u) => (u.confidence ?? 0) < 1);
  if (lowConf.length) {
    for (const u of lowConf) {
      failures.push(
        `confidence<1: "${u.name}" at ${u.confidence} — investigate/debate before close`,
      );
    }
  } else {
    passed.push("confidence: all units at 1.0");
  }

  // Evidence gate.
  const noEvidence = units.filter((u) => u.status === "done" && !u.evidence?.length);
  if (noEvidence.length) {
    for (const u of noEvidence) {
      failures.push(`no-evidence: "${u.name}" is done but has no recorded evidence`);
    }
  } else {
    passed.push("evidence: every done unit has recorded evidence");
  }

  // Scope-overlap gate.
  let overlapFound = false;
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i];
      const b = units[j];
      const sa = (a?.scope ?? []).map(normPrefix);
      const sb = (b?.scope ?? []).map(normPrefix);
      if (!sa.length || !sb.length) continue;
      const clash = sa.some((pa) => sb.some((pb) => prefixesOverlap(pa, pb)));
      if (clash) {
        overlapFound = true;
        failures.push(`scope-overlap: "${a?.name}" and "${b?.name}" declare overlapping scopes`);
      }
    }
  }
  if (!overlapFound) passed.push("scope: no overlapping work-unit scopes");

  // Skill gate — WARN/report only, NEVER fail (see GateReport.warnings).
  // Acts only on units that CLAIM completion AND were classified knowledge-heavy at dispatch.
  // `=== true` is deliberate: legacy/undefined units (pre-feature) are skipped, not gated.
  const khDone = units.filter((u) => u.knowledge_heavy === true && u.status === "done");
  let waived = 0;
  for (const u of khDone) {
    if (u.skill_waiver?.reason) {
      waived++;
      passed.push(`skills: "${u.name}" closed under waiver (${u.skill_waiver.reason})`);
      continue;
    }
    if (u.knowledge_heavy_source === "regex") {
      warnings.push(
        `skills(warn): "${u.name}" flagged knowledge-heavy by heuristic; verify manually`,
      );
      continue;
    }
    const required = strArray(u.skills_required);
    if (!required.length) {
      warnings.push(
        `skills(warn): "${u.name}" knowledge-heavy but no verified skill matched — author one or record a waiver (vf units waiver "${u.name}" --reason ...)`,
      );
      continue;
    }
    const used = new Set(strArray(u.skills_used));
    if (required.some((r) => used.has(r))) {
      passed.push(`skills: "${u.name}" applied a required skill`);
    } else {
      // FUTURE: a persisted reviewer gap-flag turns this into a real failure.
      // Until that signal exists, never FAIL on skill grounds — self-report is untrusted.
      warnings.push(
        `skills(warn): "${u.name}" did not report using a required skill (required: ${required.join(", ")}; used: ${[...used].join(", ") || "none"}) — reviewer should confirm from the diff`,
      );
    }
  }
  if (!khDone.length) passed.push("skills: no knowledge-heavy completed units to check");
  if (waived) warnings.push(`skills: ${waived} unit(s) closed under skill waiver`);

  return { ok: failures.length === 0, failures, passed, warnings };
}

// ─── E2E advisory gates (non-blocking warnings) ───────────────────────────

const E2E_GLOB = /^e2e\/.*\.(spec|e2e)\.ts$/;
const TEXT_SELECTOR_RE =
  /"(text=[^"]*[-￿][^"]*)"|hasText:\s*"([^"]*[-￿][^"]*)"|hasText:\s*\/([^/]*[-￿][^/]*)\//g;

function findE2eFiles(base: string): string[] {
  const out: string[] = [];
  const e2eDir = join(base, "e2e");
  if (!existsSync(e2eDir)) return out;
  try {
    for (const entry of readdirSync(e2eDir)) {
      const rel = `e2e/${entry}`;
      if (E2E_GLOB.test(rel)) out.push(rel);
    }
  } catch {
    /* no e2e directory */
  }
  return out;
}

/** Scan e2e specs for Unicode text selectors — fragile to normalization mismatches. */
export function e2eUnicodeSelectorWarning(base: string): string[] {
  const warnings: string[] = [];
  for (const rel of findE2eFiles(base)) {
    const abs = join(base, rel);
    let src: string;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      TEXT_SELECTOR_RE.lastIndex = 0;
      for (let m = TEXT_SELECTOR_RE.exec(line); m !== null; m = TEXT_SELECTOR_RE.exec(line)) {
        const text = m[1] || m[2] || m[3] || "";
        warnings.push(`e2e:${rel}:${i + 1} Unicode text selector "${text}" — prefer data-testid`);
      }
    }
  }
  return warnings;
}

/** Scan e2e specs for dynamic import() inside page.evaluate() — fails in bundled builds. */
export function e2eEvaluateDynamicImportWarning(base: string): string[] {
  const warnings: string[] = [];
  for (const rel of findE2eFiles(base)) {
    const abs = join(base, rel);
    let src = "";
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      /* file unreadable — treat as empty */
    }
    const lines = src.split("\n");
    let inEvaluate = false;
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!inEvaluate) {
        const idx = line.indexOf(".evaluate(");
        if (idx === -1) continue;
        const rest = line.slice(idx + ".evaluate(".length).trim();
        if (/\bimport\s*\(/.test(rest)) {
          warnings.push(
            `e2e:${rel}:${i + 1} dynamic import() inside page.evaluate() — fails in bundled builds`,
          );
          continue;
        }
        if (rest.startsWith("(") || rest.startsWith("{") || rest === "") {
          // Multi-line .evaluate() call: the inline import() check
          // above already ran on this line. We don't re-check on
          // subsequent lines (the original multi-line tracker never
          // re-checked either; it only counted parens to find the
          // end of the call). Mark this evaluate call as consumed.
          inEvaluate = true;
          depth = 0;
          for (const ch of rest) {
            if (ch === "(" || ch === "{") depth++;
            else if (ch === ")" || ch === "}") depth--;
          }
        }
      }
    }
  }
  return warnings;
}
