import { join } from "node:path";
import { appendFileSafe, writeFileSafe } from "../core.js";
import { applyGuidance } from "../dispatch/guidance.js";
import { readDispatchResumeBinding } from "../dispatch/public-redaction.js";
import type { EngineProcessSpawner } from "../dispatch/session-types.js";
import { resolveMemoryProvider } from "../memory/provider.js";
import { renderMemoryBlock } from "../memory/render.js";
import { mapGateResult } from "../orchestrator/gate-map.js";
import { updateMarker } from "../orchestrator/marker.js";
import { resolveResumeId } from "../orchestrator/resume-policy.js";
import { readSettings } from "../settings.js";
import { materializeDiscoveredDispatchSkills } from "../skills/dispatch-resolution.js";
import {
  CTX_DIR,
  DEFAULT_MAX_ROUNDS,
  buildEnginePrompt,
  c,
  detectQuota,
  investigateUnit,
  out,
  persistDispatch,
  recoveryHint,
  thresholdFor,
} from "./_shared.js";
import type {
  AsyncResearcher,
  DispatchResult,
  Engine,
  ProjectContext,
  QuotaSignal,
  RiskClass,
  ScopedGateFn,
  UnitDispatcher,
  UnitInvestigationOutcome,
  UnitOutcome,
  WorkUnit,
} from "./_shared.js";
import type { Checkpoint } from "./_shared.js";
import {
  handleUnitFailure,
  persistCheckpoint,
  persistInvestigation,
  persistQuota,
  recordQuota,
  skippedByQuota,
} from "./_shared.js";
import type { ProtectionRuntime } from "./_shared.js";
import {
  type DiffReader,
  type WorktreeOps,
  analyzeDiff,
  defaultDiffReader,
  defaultWorktreeOps,
  makeWorktreeOps,
} from "./dispatch-diff.js";
import { parseResources } from "./dispatch-resources.js";
import {
  type DispatchSessionRuntimeOptions,
  runDispatchWithSessionRuntime,
} from "./dispatch-session-runtime.js";
export { analyzeDiff, defaultDiffReader, defaultWorktreeOps, makeWorktreeOps };
export type { DiffReader, WorktreeOps };
export { makeReviewer } from "./dispatch-reviewer.js";
/** Test seam: investigation rounds use the same dispatcher/session authority as live units. */
export function makeResearcher(
  engine: Engine,
  ctx: ProjectContext,
  mode: "cli" | "bridge" | "dry",
  processSpawner?: EngineProcessSpawner,
  base?: string,
  sessionRuntime?: Pick<
    DispatchSessionRuntimeOptions,
    "adapterOptions" | "materializeBinding" | "processSpawner" | "sessionAdapter"
  >,
): AsyncResearcher {
  const repoRoot = base ?? process.cwd();
  return async (round, question) => {
    const prompt = buildEnginePrompt(engine, { ...ctx, goal: question }, [
      `research round ${round}`,
    ]);
    const unit = `research-round-${round}`;
    const result = await runDispatchWithSessionRuntime({
      engine,
      prompt,
      mode,
      unit,
      base: repoRoot,
      skillNames: [],
      adapterOptions: { timeoutMs: 180_000 },
      ...(processSpawner ? { processSpawner } : {}),
      ...sessionRuntime,
    });
    const confidence = result.summary?.confidence ?? 0;
    // Build findings: prefer the summary's uncertainty field, then plain raw evidence.
    const findings: string[] = [];
    if (result.summary?.uncertainty) {
      findings.push(result.summary.uncertainty);
    }
    // When the engine ran turns but produced no text summary, extract metadata from
    // the raw Claude envelope so investigation rounds carry useful evidence.
    if (findings.length === 0 && result.raw) {
      try {
        const envelope = JSON.parse(result.raw);
        if (envelope.type === "result" && envelope.num_turns > 0) {
          findings.push(
            `round ${round}: ${envelope.num_turns} turns, ` +
              `$${typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd.toFixed(2) : "?"}, ` +
              `stop=${envelope.stop_reason ?? "?"}`,
          );
        }
      } catch (e) {
        // biome-ignore format: keep single-line for line-count cap
        out("engine-stderr", `[dispatch] research findings parse best-effort failed: ${(e as Error).message}`, { level: "debug" });
      }
    }
    if (findings.length === 0) {
      findings.push(result.ok ? `round ${round}: research dispatched` : "research failed");
    }
    // Verifiable artifacts: command output and file evidence from the engine.
    // Only these allow confidence to rise — prose findings alone are self-report (issue #354).
    const artifacts: string[] = [];
    if (result.summary?.commands_run?.length) artifacts.push(...result.summary.commands_run);
    if (result.summary?.files_changed?.length) artifacts.push(...result.summary.files_changed);
    if (result.summary?.tests_run?.length) artifacts.push(...result.summary.tests_run);
    return { findings, confidence, blocked: !result.ok, artifacts };
  };
}

export function computeKnowledgeHeavySource(
  riskClass: RiskClass,
  unitText: string,
): WorkUnit["knowledge_heavy_source"] {
  const looksUiUx = /\b(ui|ux|screen|layout|design|component|theme|accessib)/i.test(unitText);
  const knowledgeHeavy = riskClass === "feature" || riskClass === "architecture" || looksUiUx;
  if (!knowledgeHeavy) return undefined;
  if (riskClass === "feature" || riskClass === "architecture") return "risk";
  if (looksUiUx) return "regex";
  return undefined;
}

// Test seam: exported so unit tests can exercise the streamSpawner
// factory callbacks (onChunk, onStderrChunk) without invoking the
// full orchestrate → runUnits → makeDispatcher path.
export function makeDispatcher(
  engine: Engine,
  ctx: ProjectContext,
  base: string,
  mode: "cli" | "bridge" | "dry",
  riskClass: RiskClass,
  processSpawner?: EngineProcessSpawner,
  prot?: ProtectionRuntime,
  isolate?: { base: string; wt?: WorktreeOps },
  gate?: ScopedGateFn,
  /** #618 PR2b-1: when true, a crashed unit's persisted engine session is resumed. */
  resume = false,
  sessionRuntime?: Pick<
    DispatchSessionRuntimeOptions,
    "adapterOptions" | "materializeBinding" | "processSpawner" | "sessionAdapter"
  >,
): UnitDispatcher {
  return async (u) => {
    const unitRel = `${CTX_DIR}/workunits/${u.name}`;
    const unitDir = join(base, unitRel);
    // Quota latch: once an upstream HIGH-confidence limit is seen, skip not-yet-started units
    // rather than burning more of a shared account (the run.ts loop has no abort seam in scope).
    if (prot?.quota.limited) {
      const outcome = skippedByQuota();
      outcome.evidence = [`skipped: upstream rate limit (${prot.quota.signal?.kind ?? "quota"})`];
      return outcome;
    }
    // Skills-first: discover repo skills, match them to this unit's spec+name, and inject the
    // matches by name. When a knowledge-heavy unit (feature/architecture, or UX/UI by spec) has
    // NO match, flag the gap so the engine won't silently freelance (esp. UX/UI).
    const unitText = `${u.name} ${u.spec ?? ""}`;
    const { skillNames, alwaysNames, matchedNames, skillsRequired } =
      materializeDiscoveredDispatchSkills(unitText, { repoRoot: base });
    const looksUiUx = /\b(ui|ux|screen|layout|design|component|theme|accessib)/i.test(unitText);
    const knowledgeHeavy = riskClass === "feature" || riskClass === "architecture" || looksUiUx;
    const skillGap = knowledgeHeavy && matchedNames.length === 0;
    // The full mixed-trust list actually injected into the prompt vs the VERIFIED-only subset
    // that a downstream skills-first gate is allowed to count as satisfying the requirement.
    const skillsInjected = skillNames;
    // Why the unit is knowledge-heavy: risk class first, else the UX/UI regex, else undefined.
    const knowledgeHeavySource = computeKnowledgeHeavySource(riskClass, unitText);
    const memProvider = resolveMemoryProvider(readSettings(base).memory, join(base, CTX_DIR));
    const memBlock = memProvider
      ? renderMemoryBlock(memProvider.recall(unitText, { limit: 3 }))
      : "";
    const prompt = applyGuidance(
      u.name,
      buildEnginePrompt(
        engine,
        ctx,
        [
          {
            name: u.name,
            spec: u.spec,
            scope: u.scope,
            skills: skillNames,
            skillGap,
            repoSkills: alwaysNames,
            upstreamHandoffs: u.upstreamHandoffs,
          },
        ],
        memBlock,
      ),
      // A dry run is a READ-ONLY preview (see :309): it must still READ + PREPEND the
      // queued guidance so CONTEXT.md shows it, but MUST NOT consume (delete) the file —
      // else the next REAL run loses its steering. No-op clearGuidance in dry mode.
      { base, ...(mode === "dry" ? { clearGuidance: () => {} } : {}) },
    );
    writeFileSafe(join(unitDir, "CONTEXT.md"), prompt);
    const evidence: string[] = [];
    if (prot?.checkpoint) {
      evidence.push(`${unitRel}/${persistCheckpoint(unitDir, prot.checkpoint)}`);
    }
    // DEPRECATED: per-unit stream.log for web UI SSE — superseded by logbus+M3. Remove after next minor.
    const streamPath = join(unitDir, "stream.log");
    try {
      writeFileSafe(streamPath, "");
    } catch (e) {
      // biome-ignore format: keep single-line for line-count cap
      out("engine-stderr", `[dispatch] stream.log init best-effort failed: ${(e as Error).message}`, { level: "debug", unit: u.name });
    }

    // W1: per-unit worktree isolation. When isolate is set (and mode is cli),
    // create a dedicated git worktree for this unit so parallel units never
    // contaminate one shared working tree. The worktree is removed in the
    // finally block below, even if dispatch or investigation throws.
    let wtPath: string | undefined;
    if (isolate && mode === "cli") {
      const wt = isolate.wt ?? defaultWorktreeOps;
      const unitBranch = `vf-unit-${u.name}`;
      wtPath = wt.create(unitBranch, isolate.base);
    }
    // The session adapter owns projection before either sink sees a byte. In particular,
    // injected process output must not be mirrored here before canonical redaction.
    const emitStdout = (text: string) => {
      try {
        const line = `data: ${JSON.stringify({ unit: u.name, text, ts: Date.now() })}\n\n`;
        appendFileSafe(streamPath, line);
      } catch (e) {
        // biome-ignore format: keep single-line for line-count cap
        out("engine-stderr", `[dispatch] stream.log append best-effort failed: ${(e as Error).message}`, { level: "debug", unit: u.name });
      }
      out("engine-stdout", text, {
        level: "info",
        unit: u.name,
        meta: { engine, unit: u.name },
      });
    };
    const emitStderr = (text: string) => {
      out("engine-stderr", text, {
        level: "warn",
        unit: u.name,
        meta: { engine, unit: u.name },
      });
    };
    const resumeSessionId = resolveResumeId(u.name, resume, engine);
    try {
      const result = await runDispatchWithSessionRuntime({
        engine,
        prompt,
        mode,
        unit: u.name,
        base,
        wtPath,
        skillNames,
        ...(processSpawner ? { processSpawner } : {}),
        onStdoutChunk: emitStdout,
        onStderrChunk: emitStderr,
        ...sessionRuntime,
        ...(resumeSessionId ? { resumeSessionId } : {}),
      });
      // A dry run is a READ-ONLY preview: the CONTEXT.md prompt above is its ONE intended
      // side-effect. It must never write result JSON nor append to the persisted evidence
      // ledger, so the dispatch outcome is reported in-memory only.
      if (mode !== "dry") {
        evidence.push(`${unitRel}/${persistDispatch(unitDir, result)}`);
        const resumeBinding = readDispatchResumeBinding(result);
        if (resumeBinding) {
          updateMarker(u.name, {
            engineSessionId: resumeBinding.nativeSessionId,
            engineSessionEngine: resumeBinding.engine,
          });
        }
        if (prot) recordQuota(prot, unitRel, unitDir, result, evidence);
      }
      let confidence = result.summary?.confidence ?? 0;
      const status: WorkUnit["status"] =
        mode === "dry" ? "verifying" : result.ok ? "verifying" : "blocked";

      const threshold = thresholdFor(riskClass);

      // confidence<threshold on a real run → investigate before blocking (never silently close).
      if (mode !== "dry" && confidence < threshold) {
        out(
          "vf",
          c.dim(
            `  ${u.name}: confidence ${confidence} < 1 → investigating up to ${DEFAULT_MAX_ROUNDS} rounds…`,
          ),
        );
        const research = makeResearcher(engine, ctx, mode, processSpawner, base, sessionRuntime);
        const outcome = await investigateUnit(
          { name: u.name, confidence, owner_agent: u.owner_agent },
          { riskClass, research },
        );
        evidence.push(`${unitRel}/${persistInvestigation(unitDir, outcome)}`);
        confidence = Math.max(confidence, outcome.finalConfidence);
        out(
          "vf",
          outcome.met
            ? c.green(`  ${u.name}: investigation ✓ → confidence ${confidence.toFixed(2)}`)
            : c.yellow(
                `  ${u.name}: investigation → confidence ${confidence.toFixed(2)} (threshold ${outcome.threshold})`,
              ),
        );
      }
      // A failed real dispatch: surface the recovery hint and (optionally) roll back.
      if (mode === "cli" && status === "blocked" && prot) handleUnitFailure(prot, base);
      const measured =
        gate && mode === "cli" && u.scope?.length
          ? gate({ scope: u.scope, cwd: wtPath ?? base })
          : undefined;
      const gates = mapGateResult(measured);
      // #523: surface engine cost/tokens so the progress footer shows real numbers
      // (not a dead $0.00). Parse the Claude result envelope best-effort.
      const resources = parseResources(result.raw);
      return {
        status,
        confidence,
        evidence,
        gates,
        ...(resources ? { resources } : {}),
        knowledge_heavy: knowledgeHeavy,
        knowledge_heavy_source: knowledgeHeavySource,
        skills_injected: skillsInjected,
        skills_required: skillsRequired,
        skills_used: result.summary?.skills_used ?? [],
      };
    } finally {
      if (wtPath) {
        const cleanup = isolate?.wt ?? defaultWorktreeOps;
        cleanup.remove(wtPath);
      }
    }
  };
}
