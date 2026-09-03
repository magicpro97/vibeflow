/**
 * AI-init workflow decomposition.
 *
 * Decomposes the AI-init surface into 2 tiers of work units that the
 * orchestrator (src/orchestrator/run.ts) can dispatch concurrently with
 * disjoint file scopes, run an independent reviewer over each, and gate
 * close on goalEval (confidence = 1.0 with recorded evidence per unit).
 *
 *   Tier 1 (always 5 adapter units): analyzer, instruction-writer,
 *     skill-curator, context-updater, workflow-state-writer.
 *     They cover the canonical baseline (instruction files, skills,
 *     project context, and workflow state).
 *
 *   Tier 2 (0..N phase units): one unit per `WorkflowPhase` in the
 *     intake, named `ai-init-phase-<slug>-<n>`. Each phase unit carries
 *     the phase's owner_hint, scope (declared outputs), acceptance
 *     signal (the phase's dod), and skill wiring.
 *
 * Types, constants, descriptions, and builders are split into sibling
 * modules under src/ai-init-workflow/ to keep every file under 400 LOC.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { ROLE_NAMES, type RoleName } from "./agents/role-templates.js";
import type { WorkUnit } from "./core.js";
import { PENDING_REQUIRED_WORK_UNIT_GATES, WORK_UNIT_STATUS } from "./core/workflow-contract.js";
import type { ProjectProfile } from "./scanner.js";

import { buildAdapterSpec, buildPhaseUnits } from "./ai-init-workflow/builders.js";
import {
  ADAPTER_ACCEPTANCE,
  adapterSkills,
  instructionAcceptance,
  selectedInstructionScope,
} from "./ai-init-workflow/descriptions.js";
import type { AiInitIntake, AiInitUnit } from "./ai-init-workflow/types.js";
import {
  ADAPTER_DEPENDS_ON,
  ADAPTER_OWNER,
  ADAPTER_SCOPE,
  AI_INIT_ADAPTER_NAMES,
  ENGINE_INSTRUCTION_SCOPE,
  INIT_DEFAULT_ENGINE,
} from "./ai-init-workflow/types.js";

// Re-export the full public surface — the 9 importers must see no change.
export type {
  AiInitIntake,
  WorkflowPhase,
  AiInitUnit,
  AiInitAdapterName,
  AiInitUnitName,
} from "./ai-init-workflow/types.js";
export {
  AI_INIT_ADAPTER_NAMES,
  AI_INIT_FINISHER_NAMES,
  AI_INIT_UNIT_NAMES,
  ENGINE_INSTRUCTION_SCOPE,
  ENGINE_SKILL_DIR,
} from "./ai-init-workflow/types.js";
export {
  buildPhaseSkillEnrichmentUnits,
  buildFinisherBatchUnit,
} from "./ai-init-workflow/builders.js";

/**
 * Decompose the AI-init phase into 2 tiers of work units.
 *
 * Pure: no I/O. The orchestrator can feed the result straight into
 * `planWorkUnits` + `scheduleWaves` (no conflicts; all units land in
 * wave 0).
 *
 * @param profile       scanner profile (always available — applyIntake
 *                      calls scanRepo before phase 2)
 * @param intake        trimmed intake answers (all fields optional)
 * @param detectedRoles roles detectRolesForRepo returned for this repo.
 *                      Used to (a) interpolate into adapter specs and
 *                      (b) resolve phase.ownerHint into owner_agent.
 */
export function planAiInitUnits(
  profile: ProjectProfile,
  intake: AiInitIntake,
  detectedRoles: RoleName[] = [...ROLE_NAMES],
): AiInitUnit[] {
  const adapterUnits: AiInitUnit[] = AI_INIT_ADAPTER_NAMES.map((name): AiInitUnit => {
    const spec = buildAdapterSpec(name, profile, intake, detectedRoles);
    const skills = adapterSkills(name);
    const scope =
      name === "ai-init-instruction-writer"
        ? selectedInstructionScope(intake)
        : ADAPTER_SCOPE[name];
    return {
      name,
      status: WORK_UNIT_STATUS.PENDING,
      confidence: 0,
      owner_agent: ADAPTER_OWNER[name],
      spec,
      scope,
      acceptance:
        name === "ai-init-instruction-writer"
          ? instructionAcceptance(scope)
          : ADAPTER_ACCEPTANCE[name],
      skills_injected: [...skills.injected],
      skills_required: [...skills.required],
      depends_on: [...(ADAPTER_DEPENDS_ON[name] ?? [])],
      gates: { ...PENDING_REQUIRED_WORK_UNIT_GATES },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      evidence: [],
    };
  });
  const phaseUnits = buildPhaseUnits(intake, detectedRoles, profile);
  return [...adapterUnits, ...phaseUnits];
}

/**
 * Reviewer used by the orchestrator: a unit passes when its recorded
 * evidence cites at least one path matching its acceptance pattern. This
 * is intentionally simple — a richer review (e.g. diff-based) is out of
 * scope and would require a second engine pass. The point is to gate
 * `status = done` on real on-disk evidence, not on the engine's word.
 */
export function aiInitReviewer(
  unit: WorkUnit,
  outcome: { status: WorkUnit["status"]; confidence: number; evidence: string[] },
  // MINOR-4: pass the project base so the reviewer can resolve cited
  // paths against it. Defaults to process.cwd() for back-compat with
  // existing tests (which chdir into a tmpdir before each case).
  base: string = process.cwd(),
): { pass: boolean; reason: string } {
  if (outcome.status === WORK_UNIT_STATUS.BLOCKED) {
    // Production dispatchers return "verifying" (per src/orchestrator/run.ts:96-99);
    // the reviewer is the gate, not the dispatcher. Only "blocked" is fatal.
    return { pass: false, reason: "dispatcher reported status=blocked" };
  }
  // ai-init reviewer runs BEFORE gates execute — `outcome` carries no gate
  // results, so computeConfidence (gate-derived) can't apply here. Self-report
  // is the only signal at this stage; the full computed-confidence gate runs
  // later in the orchestrate path (run.ts / dispatch-runtime.ts).
  if (outcome.confidence < 1) {
    return { pass: false, reason: `confidence=${outcome.confidence} < 1.0` };
  }
  if (!outcome.evidence?.length) {
    return { pass: false, reason: "no evidence recorded" };
  }
  const name = unit.name as string;
  // Helper: for an evidence line, extract a path-like token that contains p.
  // - "edited CLAUDE.md" → "CLAUDE.md" (idx 7, word start at 0, end at 16)
  // - "updated .vibeflow/SETTINGS.json tools.codegraph" → ".vibeflow/SETTINGS.json"
  // - "CLAUDE.md content" → "CLAUDE.md" (idx 0, wordStart -1)
  const citeExists = (e: string, required: string[]): string | null => {
    for (const p of required) {
      const idx = e.indexOf(p);
      if (idx === -1) continue;
      const after = e.slice(idx);
      const wordEndRel = after.search(/\s/);
      const end = wordEndRel === -1 ? e.length : idx + wordEndRel;
      const before = e.slice(0, idx);
      const wordStart = before.search(/\S+$/);
      const start = wordStart === -1 || e.slice(wordStart, idx).trim() === "" ? wordStart : idx;
      const candidate = start === -1 ? e.slice(idx, end) : e.slice(start, end);
      if (candidate.length > 0) return candidate;
    }
    return null;
  };
  const pathIsFile = (p: string): boolean => {
    // Returns true only for existing regular files. Rejects directories,
    // symlinks-to-dirs, and missing paths. Catches the bug where a unit
    // could claim "I wrote `.vibeflow/skills/`" (a dir) and pass review
    // (MINOR-2 fix). Cited paths may be relative; resolve them against
    // the project base (MINOR-4 fix).
    try {
      return statSync(resolve(base, p)).isFile();
    } catch {
      return false;
    }
  };
  const pathIsDir = (p: string): boolean => {
    try {
      return statSync(resolve(base, p)).isDirectory();
    } catch {
      return false;
    }
  };
  const checkFileExists = (
    e: string,
    required: string[],
  ): { ok: true } | { ok: false; reason: string } => {
    // File-scope entries (don't end with "/"): cited path must exist on disk.
    // Dir-scope entries (end with "/"): the path that starts at the dir prefix
    // and continues to the next whitespace must exist on disk.
    // Both are checked independently. The substring pre-filter upstream
    // guarantees at least one match in REQUIRED; if it was a file path, it
    // must exist; if a dir-scope path, the cited file inside the dir must exist.
    const dirEntries = required.filter((p) => p.endsWith("/"));
    const fileEntries = required.filter((p) => !p.endsWith("/"));
    if (fileEntries.length > 0) {
      const cited = citeExists(e, fileEntries);
      if (cited && !pathIsFile(cited)) {
        return {
          ok: false,
          reason: `path is not a regular file (missing or a directory): ${cited} (claimed by evidence "${e}")`,
        };
      }
    }
    if (dirEntries.length > 0) {
      for (const p of dirEntries) {
        const idx = e.indexOf(p);
        if (idx === -1) continue;
        const before = e.slice(0, idx);
        const wordStart = before.search(/\S+$/);
        const start = wordStart === -1 || e.slice(wordStart, idx).trim() === "" ? wordStart : idx;
        const after = e.slice(idx);
        const wordEndRel = after.search(/\s/);
        const end = wordEndRel === -1 ? e.length : idx + wordEndRel;
        const candidate = start === -1 ? e.slice(idx, end) : e.slice(start, end);
        if (pathIsFile(candidate) || pathIsDir(candidate)) return { ok: true };
        return {
          ok: false,
          reason: `path is not a regular file (missing or a directory): ${candidate} (claimed by evidence "${e}")`,
        };
      }
    }
    return { ok: true };
  };
  if (name === "ai-init-instruction-writer") {
    // Fallback uses the INIT_DEFAULT_ENGINE (copilot) scope, NOT the
    // all-3-engines union, so a unit missing its scope can't be passed
    // by evidence citing an unselected engine's instruction file.
    const REQUIRED = unit.scope?.length
      ? unit.scope
      : ENGINE_INSTRUCTION_SCOPE[INIT_DEFAULT_ENGINE];
    const hit = outcome.evidence.some((e) => REQUIRED.some((p) => e.includes(p)));
    if (!hit) {
      return {
        pass: false,
        reason: `no evidence cites one of: ${REQUIRED.join(", ")}`,
      };
    }
    // T3: file-exists check on the cited path.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, REQUIRED);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  if (name === "ai-init-skill-curator") {
    const REQUIRED = unit.scope?.length
      ? unit.scope
      : (ADAPTER_SCOPE["ai-init-skill-curator"] ?? []);
    const hit = outcome.evidence.some((e) => REQUIRED.some((p) => e.includes(p)));
    if (!hit) {
      return {
        pass: false,
        reason: `no evidence cites one of: ${REQUIRED.join(", ")}`,
      };
    }
    // T3: file-exists check.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, REQUIRED);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  if (name === "ai-init-workflow-state-writer") {
    const hit = outcome.evidence.some(
      (e) => e.includes("WORKFLOW_STATE") || e.includes("workflow-state"),
    );
    if (!hit) {
      return {
        pass: false,
        reason: "no evidence cites WORKFLOW_STATE.json — the workflow-state-writer must update it",
      };
    }
    // T3: file-exists check.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, ADAPTER_SCOPE["ai-init-workflow-state-writer"] ?? []);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  // P1-7: batched finisher unit. The engine must cite every scope
  // path in evidence AND every cited file must exist on disk —
  // partial batches are fails (same all-or-nothing contract as
  // the phase-skill enrichment batch).
  if (name === "ai-init-finishers-batch") {
    const REQUIRED = unit.scope ?? [];
    if (REQUIRED.length === 0) {
      return { pass: false, reason: "finisher-batch unit has no scope paths" };
    }
    const missing = REQUIRED.filter(
      (p) => !outcome.evidence.some((e) => e.includes(p) || p.endsWith(e) || e.endsWith(p)),
    );
    if (missing.length > 0) {
      return {
        pass: false,
        reason: `finisher-batch evidence missing ${missing.length}/${REQUIRED.length} file(s): ${missing.join(", ")}`,
      };
    }
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, REQUIRED);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  if (name === "ai-init-analyzer") {
    // T3: file-exists check on the single scope file.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, ADAPTER_SCOPE["ai-init-analyzer"] ?? []);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }

  if (name.startsWith("ai-init-phase-")) {
    const REQUIRED = unit.scope ?? [];
    const hit = outcome.evidence.some((e) =>
      REQUIRED.some((p) => e.includes(p) || p.endsWith(e) || e.endsWith(p)),
    );
    if (!hit) {
      return {
        pass: false,
        reason: `no phase evidence cites one of the declared outputs: ${REQUIRED.join(", ")}`,
      };
    }
    // MINOR-3: phase units now also pass through the file-exists check
    // (consistency with adapter units). Previously a phase could claim
    // to write `.vibeflow/phase-outputs/foo.md` and pass review even
    // when the file wasn't on disk.
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, REQUIRED);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  // Phase-skill enrichment units: every skill file in scope must be
  // cited in evidence AND exist on disk. The pre-batch shape had 1
  // path per unit; the batched shape (`ai-init-skill-enrich-batch`)
  // carries N paths and requires all of them to be written — a partial
  // batch is still a fail (the user can re-run to retry, but we don't
  // claim success on a half-finished enrichment).
  if (name.startsWith("ai-init-skill-enrich-")) {
    const REQUIRED = unit.scope ?? [];
    if (REQUIRED.length === 0) {
      return { pass: false, reason: "enrichment unit has no scope paths" };
    }
    const missing = REQUIRED.filter(
      (p) => !outcome.evidence.some((e) => e.includes(p) || p.endsWith(e) || e.endsWith(p)),
    );
    if (missing.length > 0) {
      return {
        pass: false,
        reason: `enrichment evidence missing ${missing.length}/${REQUIRED.length} skill file(s): ${missing.join(", ")}`,
      };
    }
    for (const e of outcome.evidence) {
      const r = checkFileExists(e, REQUIRED);
      if (!r.ok) return { pass: false, reason: r.reason };
    }
  }
  return { pass: true, reason: "evidence + confidence 1.0" };
}
