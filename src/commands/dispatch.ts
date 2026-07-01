// src/commands/dispatch.ts
//
// Dispatch + work-unit mutation helpers. Issue #80, phase 5/14.
//
// Contents:
// - applyDispatch: builds and persists the dispatch prompt for an
//   engine using the saved workflow goal. Returns null when no
//   workflow state exists (PR28 audit Task 6 M2 fix — the old code
//   fell back to a literal-placeholder goal, which silently
//   produced a meaningless dispatch).
// - VALID_STATUS: the canonical ordered list of work-unit statuses.
// - normalizeUnit: shape a `Partial<WorkUnit>` into a complete
//   WorkUnit with safe defaults. Centralised here so the on-disk
//   schema stays consistent across add / update / engine-writer
//   paths.
// - mutateUnits: add / update / delete a work unit in the
//   workflow ledger at `base`, with round-trip through
//   normalizeUnit + recomputeTotals + writeState.
//
// The facade (src/commands.ts) re-exports applyDispatch + mutateUnits
// so existing callers (`import { applyDispatch } from
// "../commands.js"`) keep working.

import type { Engine, ProjectContext, WorkUnit, WorkflowState } from "./_shared.js";
import {
  CTX_DIR,
  ENGINES,
  cwd,
  defaultContext,
  dispatchPrompt,
  join,
  readState,
  recomputeTotals,
  writeFileSafe,
  writeState,
} from "./_shared.js";

/** Generate (and persist) the dispatch prompt for an engine using the saved goal. */
export function applyDispatch(
  engineName: string,
  base: string = cwd(),
): { file: string; prompt: string } | null {
  if (!(ENGINES as string[]).includes(engineName)) return null;
  const engine = engineName as Engine;
  const state = readState(base);
  // PR28 audit Task 6 (M2): when no workflow state exists (user skipped `vf init`)
  // the old code fell back to `defaultContext().goal` — a LITERAL PLACEHOLDER
  // string ("Describe the task in .vibeflow/TASK_CONTEXT.md before dispatching an
  // engine."). The engine would then receive a prompt that is just a TODO note,
  // and the user gets a meaningless dispatch with no error. The audit calls this
  // "the run/applyDispatch placeholder goal trap."
  //
  // Fix: refuse to dispatch when no state exists. The caller (server.ts:525)
  // surfaces a 400 with a clear "run vf init" message. This is the same contract
  // as `verify()` (Task 2): state is mandatory for any meaningful run.
  if (!state) return null;
  // Also refuse when the goal is missing/empty — the placeholder string was a
  // symptom of init not having collected a real goal.
  const goal = state.goal?.trim();
  if (!goal) return null;
  // Runtime guard (issue #92): assert the base has been initialized. The early
  // returns above already proved `state` exists, so this is a belt-and-braces
  // safety net for any future refactor that drops the explicit state check.
  const baseCtx = defaultContext({ base });
  const ctx: ProjectContext = {
    ...baseCtx,
    goal,
    // Carry through the state task_id as the context name when present, so
    // the engine's prompt header references a stable identifier.
    name: baseCtx.name,
  };
  const units = state.work_units.map((u) => u.name);
  const prompt = dispatchPrompt(engine, ctx, units);
  const rel = `${CTX_DIR}/dispatch/${engine}.md`;
  writeFileSafe(join(base, rel), prompt);
  return { file: rel, prompt };
}

const VALID_STATUS: WorkUnit["status"][] = ["pending", "running", "verifying", "done", "blocked"];

/**
 * Sanitize a work-unit name to a safe slug. The name flows from the planner
 * (an LLM) / WORKFLOW_STATE.json — untrusted input — into git branch refs
 * (`vibeflow/<name>`) and worktree paths (`vf-unit-<name>`). Without this, a
 * crafted name like `../../../../tmp/pwned` would resolve a worktree OUTSIDE
 * the repo (PoC confirmed), and a name with shell/ref metacharacters would
 * break `git worktree add -b`. Allow only `[A-Za-z0-9._-]`; collapse every
 * other run to `-`; strip leading/trailing separators + leading dots (so the
 * result can never start a path-traversal segment or a hidden file). Falls
 * back to `unit` when nothing survives.
 */
export function sanitizeUnitName(raw: string): string {
  const slug = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.\.+/g, "-") // never leave a `..` traversal segment
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug.length > 0 ? slug : "unit";
}

// `normalizeUnit` is exported (not just internal) so the `run` orchestrator
// in src/commands.ts (still in the facade) can call it to shape the
// "one unit for the whole task" fallback when state.work_units is empty.
// The facade re-exports it under the same name so the call site at
// run() does not need to know about src/commands/dispatch.ts.
export function normalizeUnit(input: Partial<WorkUnit> & { name: string }): WorkUnit {
  const g: Partial<WorkUnit["gates"]> = input.gates ?? {};
  const r: Partial<WorkUnit["resources"]> = input.resources ?? {};
  return {
    name: sanitizeUnitName(String(input.name)),
    status: VALID_STATUS.includes(input.status as WorkUnit["status"])
      ? (input.status as WorkUnit["status"])
      : "pending",
    confidence:
      typeof input.confidence === "number" ? Math.min(1, Math.max(0, input.confidence)) : 0,
    // issue #90: round-trip the per-unit risk class so goalEval applies the correct threshold
    riskClass: input.riskClass,
    owner_agent: input.owner_agent,
    skills_used: input.skills_used,
    knowledge_heavy: typeof input.knowledge_heavy === "boolean" ? input.knowledge_heavy : undefined,
    knowledge_heavy_source:
      input.knowledge_heavy_source === "risk" || input.knowledge_heavy_source === "regex"
        ? input.knowledge_heavy_source
        : undefined,
    skills_injected: Array.isArray(input.skills_injected) ? input.skills_injected : undefined,
    skills_required: Array.isArray(input.skills_required) ? input.skills_required : undefined,
    skill_waiver:
      input.skill_waiver &&
      typeof input.skill_waiver === "object" &&
      typeof input.skill_waiver.reason === "string"
        ? input.skill_waiver
        : undefined,
    scope: input.scope,
    spec: input.spec,
    gates: {
      build: g.build ?? "pending",
      lint: g.lint ?? "pending",
      test: g.test ?? "pending",
      review: g.review ?? "pending",
    },
    resources: {
      agents: Math.max(0, Math.round(Number(r.agents) || 0)),
      tokens: Math.max(0, Math.round(Number(r.tokens) || 0)),
      cost_usd: Math.max(0, Number(r.cost_usd) || 0),
      wall_seconds: Math.max(0, Math.round(Number(r.wall_seconds) || 0)),
    },
    evidence: Array.isArray(input.evidence)
      ? input.evidence.filter((e): e is string => typeof e === "string" && e.trim().length > 0)
      : input.evidence,
  };
}

/** Add, update, or delete a work unit in the workflow ledger at `base`. */
export function mutateUnits(
  base: string,
  action: "add" | "update" | "delete",
  unit: Partial<WorkUnit> & { name?: string },
): WorkflowState | null {
  const state = readState(base);
  if (!state) return null;
  // HOTFIX pr48-regression: defend against state files missing `work_units`
  // (e.g. an ai-init-workflow-state-writer that ran on a no-phases intake
  // and persisted a state without the key). All downstream access assumes
  // an array; treat missing/undefined as empty.
  if (!Array.isArray(state.work_units)) state.work_units = [];
  const name = unit.name?.trim();
  if (!name) return null;
  // Sanitize BEFORE duplicate check — different raw names can map to same slug
  const sanitizedName = sanitizeUnitName(name);
  if (!sanitizedName || sanitizedName === "") return null;
  const idx = state.work_units.findIndex((u) => u.name === sanitizedName);
  if (action === "delete") {
    if (idx === -1) return null;
    state.work_units.splice(idx, 1);
  } else if (action === "add") {
    if (idx !== -1) return null; // name must be unique
    state.work_units.push(normalizeUnit({ ...unit, name: sanitizedName }));
  } else {
    if (idx === -1) return null;
    state.work_units[idx] = normalizeUnit({
      ...state.work_units[idx],
      ...unit,
      name: sanitizedName,
    });
  }
  recomputeTotals(state);
  writeState(base, state);
  return state;
}
