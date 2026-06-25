import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { detectRolesForRepo } from "../agents/detect-roles.js";
import {
  AI_INIT_FINISHER_NAMES,
  aiInitReviewer,
  buildFinisherBatchUnit,
  buildPhaseSkillEnrichmentUnits,
  planAiInitUnits,
} from "../ai-init-workflow.js";
import type { AiInitAdapterName, AiInitIntake, AiInitUnit } from "../ai-init-workflow/types.js";
import {
  CTX_DIR,
  ENGINES,
  type Engine,
  type WorkUnit,
  type WorkflowState,
  writeState,
} from "../core.js";
import { DEFAULT_CONCURRENCY, orchestrateUnits } from "../orchestrator/run.js";
import { preflightAll } from "../preflight.js";
import type { ProjectProfile } from "../scanner.js";
import { scanRepo } from "../scanner.js";
import { curateSkillsFromEvidence } from "../skills/curator.js";
import { defaultAiInitDispatcher } from "./dispatch.js";
import { selectBestEngine } from "./prompt.js";
import type { AiInitWorkflowOpts, AiInitWorkflowResult } from "./types.js";

// DI: injected by the facade after module load (writeContextFiles is path-sensitive,
// must stay in depth-1 file). Called exactly once before any exported function.
type WriteContextFilesFn = (
  base: string,
  profile: ProjectProfile,
  engines?: string[],
  ctx7Auth?: boolean,
) => string[];

let _writeContextFiles: WriteContextFilesFn | undefined;

export function __setWorkflowDeps(writeContextFiles: WriteContextFilesFn): void {
  _writeContextFiles = writeContextFiles;
}

/** Resolve the injected writer, asserting it was wired by the facade at module
 *  load (ai-init.ts calls __setWorkflowDeps). Throws a clear error instead of a
 *  silent `undefined is not a function` if that wiring ever regresses. */
function writeContextFilesDep(): WriteContextFilesFn {
  if (!_writeContextFiles) {
    throw new Error("ai-init: writeContextFiles dependency not wired (call __setWorkflowDeps)");
  }
  return _writeContextFiles;
}

export async function runAiInitWorkflow(opts: AiInitWorkflowOpts): Promise<AiInitWorkflowResult> {
  const { base, intake, forceEngine, preflight, concurrency, ctx7Auth } = opts;

  const profile = scanRepo(base);
  const detectedRoles = detectRolesForRepo(base, profile);

  writeContextFilesDep()(base, profile, intake.engines, ctx7Auth);
  mkdirSync(join(base, CTX_DIR, "skills"), { recursive: true });

  const probe = preflight ?? ((engines, pg) => preflightAll(engines, pg));
  let engine: Engine | null = null;
  if (forceEngine) {
    const readiness = probe([forceEngine], { probe: true });
    const match = readiness.find((r) => r.engine === forceEngine && r.level === "ready");
    engine = match ? forceEngine : null;
  } else {
    const readiness = probe(ENGINES, { probe: true });
    engine = selectBestEngine(readiness);
  }
  if (!engine) {
    return {
      ok: false,
      blockKind: "no-engine",
      reason: forceEngine
        ? `forced engine ${forceEngine} is not ready — run \`vf doctor --probe\` to diagnose`
        : "no ready engine found — run `vf doctor --probe` to check engine status",
      units: [],
      reviews: [],
      goalMet: false,
    };
  }

  const plannerIntake: AiInitIntake = {
    ...intake,
    engines: intake.engines?.length ? intake.engines : [engine],
    ctx7Authenticated: intake.ctx7Authenticated ?? ctx7Auth,
  };
  const adapterUnits = planAiInitUnits(profile, plannerIntake, detectedRoles).filter(
    (e) => !e.name.startsWith("ai-init-phase"),
  );

  const batchFinishers = opts.batchFinishers !== false;
  let adapterUnitsFinal: AiInitUnit[] = adapterUnits;
  if (batchFinishers) {
    const finisherNames = new Set<string>(AI_INIT_FINISHER_NAMES as ReadonlySet<string>);
    const kept = adapterUnits.filter((u) => !finisherNames.has(u.name));
    const batchUnit = buildFinisherBatchUnit(profile, plannerIntake, detectedRoles);
    adapterUnitsFinal = [...kept, batchUnit];
  }

  const enrichmentTarget: (e: Engine, slug: string) => string = (_e, slug) =>
    `${CTX_DIR}/skills/${slug}/SKILL.md`;
  const enrichmentUnits = buildPhaseSkillEnrichmentUnits(plannerIntake, [engine], enrichmentTarget);
  for (const u of enrichmentUnits) {
    u.depends_on = ["ai-init-analyzer"];
  }

  const skipFinisherBelow = opts.quotaSkipFinisherBelowPct ?? 20;
  const skippedFinisherNames: string[] = [];
  let dispatchable = [...adapterUnitsFinal, ...enrichmentUnits];
  if (opts.quotaStatus && skipFinisherBelow > 0) {
    const remaining = opts.quotaStatus.percentRemaining;
    if (remaining !== undefined && remaining < skipFinisherBelow) {
      const kept: AiInitUnit[] = [];
      for (const u of dispatchable) {
        if (
          u.name === "ai-init-finishers-batch" ||
          AI_INIT_FINISHER_NAMES.has(u.name as AiInitAdapterName)
        ) {
          skippedFinisherNames.push(u.name);
          continue;
        }
        kept.push(u);
      }
      if (skippedFinisherNames.length > 0) {
        process.stderr.write(
          `[ai-init] quota at ${remaining?.toFixed(1)}% — skipping ${skippedFinisherNames.length} ` +
            `optional finisher unit(s) to preserve core workflow: ${skippedFinisherNames.join(", ")}\n`,
        );
      }
      dispatchable = kept;
    }
  }
  const units = dispatchable;

  const dispatcher =
    opts.dispatcher ??
    defaultAiInitDispatcher(engine, {
      engineCommandFn: opts.engineCommandFn,
      spawner: opts.spawner,
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.dispatcherMaxRetries,
      backoffBaseMs: opts.dispatcherBackoffBaseMs,
      backoffCapMs: opts.dispatcherBackoffCapMs,
    });

  const waves = scheduleAiInitWaves(units);

  const allUnits: AiInitUnit[] = [];
  const allReviews: Array<{ unit: string; pass: boolean; reason: string }> = [];
  for (const wave of waves) {
    if (wave.includes("ai-init-skill-curator") && base && engine) {
      const curate = opts.curate ?? curateSkillsFromEvidence;
      const result = curate(base, engine, {
        ctx7Authenticated: opts.ctx7Auth,
      });
      if (result.installed.length > 0) {
        process.stderr.write(
          `[curator] whitelist installed ${result.installed.length} skill(s): ${result.installed.join(", ")}\n`,
        );
      }
      if (result.unmatched.length > 0) {
        process.stderr.write(
          `[curator] ${result.unmatched.length} tech(s) unmatched — AI skill-curator should handle: ${result.unmatched.join(", ")}\n`,
        );
      }
    }
    const waveUnits = units.filter((u) => wave.includes(u.name));
    const isWave0 = waves.indexOf(wave) === 0;
    const waveConcurrency =
      isWave0 && opts.sequentialWave0 !== false ? 1 : (concurrency ?? DEFAULT_CONCURRENCY);
    const waveResult = await orchestrateUnits<AiInitUnit>({
      units: waveUnits,
      dispatcher,
      reviewer: (u, o) => aiInitReviewer(u, o, base),
      concurrency: waveConcurrency,
      interUnitDelayMs: opts.interUnitDelayMs,
      agent: engine,
    });
    allUnits.push(...waveResult.units);
    allReviews.push(...waveResult.reviews);
    const blocked = waveResult.reviews.find((r) => !r.pass);
    if (blocked) {
      const passedNames = allReviews.filter((r) => r.pass).map((r) => r.unit);
      if (base && allUnits.length > 0) {
        try {
          const partial: WorkflowState = {
            task_id: "vf-init",
            goal: intake.goal?.trim() || "VibeFlow init",
            success_criteria: [
              `${allUnits.length} unit(s) initialized`,
              `${passedNames.length} passed, ${allUnits.length - passedNames.length} blocked at ${blocked.unit}`,
            ],
            work_units: allUnits as WorkUnit[],
            totals: {
              units: allUnits.length,
              done: passedNames.length,
              tokens: 0,
              cost_usd: 0,
              wall_seconds: 0,
            },
          };
          writeState(base, partial);
          process.stderr.write(
            `[ai-init] persisted partial state for ${passedNames.length}/${allUnits.length} unit(s) ` +
              `to ${CTX_DIR}/WORKFLOW_STATE.json\n`,
          );
        } catch (err) {
          process.stderr.write(
            `[ai-init] warning: could not persist partial state: ${(err as Error).message}\n`,
          );
        }
      }
      return {
        ok: false,
        blockKind: "wave-blocked",
        engine,
        units: allUnits,
        reviews: allReviews,
        goalMet: false,
        passedUnits: passedNames,
        skippedUnits: skippedFinisherNames.length > 0 ? skippedFinisherNames : undefined,
        reason: `wave blocked at ${blocked.unit}: ${blocked.reason}`,
      };
    }
  }

  const result = { units: allUnits, reviews: allReviews };
  const goalMet =
    result.reviews.every((r) => r.pass) && result.units.every((u) => u.status === "done");
  return {
    ok: goalMet,
    engine,
    units: result.units,
    reviews: result.reviews,
    goalMet,
    reason: goalMet ? undefined : result.reviews.find((r) => !r.pass)?.reason,
    skippedUnits: skippedFinisherNames.length > 0 ? skippedFinisherNames : undefined,
  };
}

export function scheduleAiInitWaves(units: AiInitUnit[]): string[][] {
  const byName = new Map(units.map((u) => [u.name, u]));
  const remaining = new Map(units.map((u) => [u.name, new Set(u.depends_on ?? [])]));
  const waves: string[][] = [];
  const done = new Set<string>();
  while (remaining.size) {
    const ready: string[] = [];
    for (const [name, deps] of remaining) {
      const allMet = [...deps].every((d) => done.has(d) || !byName.has(d));
      if (allMet) ready.push(name);
    }
    if (ready.length === 0) {
      waves.push([...remaining.keys()]);
      break;
    }
    waves.push(ready);
    for (const name of ready) {
      remaining.delete(name);
      done.add(name);
    }
  }
  return waves;
}
