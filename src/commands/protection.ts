// src/commands/protection.ts
//
// Source-protection / rollout helpers used by `orchestrate` and
// (still, in the facade) `run`. Issue #80, phase 6/14.
//
// Extracted from src/commands.ts alongside orchestrate.ts so the
// ESM cycle rule is satisfied: the body of src/commands.ts (the
// facade) re-exports these symbols, and orchestrate.ts imports
// them through the barrel (_shared.ts) — neither subcommand
// imports the other directly.
//
// Contents (see also the JSDoc on each function in their original
// home in src/commands.ts prior to extraction):
// - MS_PER_SECOND: 1000 (timeout seconds → ms).
// - ProtectionRuntime: per-dispatch runtime threaded into the cli-mode
//   dispatcher.
// - QuotaState / ProtectionPlan: internal interfaces.
// - repoGit: argv-only git seam scoped to a repo.
// - resolveProtection: settings + per-run flags merged.
// - planProtection: pre-dispatch gate (refuse dirty/non-git per
//   settings/flags).
// - persistCheckpoint / persistQuota / persistInvestigation: unit
//   evidence writers.
// - recordQuota: detect + latch a rate-limit signal.
// - rollbackCheckpoint: roll the tree back once.
// - handleUnitFailure: print recovery hint + (optionally) rollback.
// - skippedByQuota: blocked outcome for skipped-due-to-quota units.
// - computeKnowledgeHeavySource: 4-branch ternary on riskClass +
//   spec text.
// - makeDispatcher: per-unit dispatcher factory (CONTEXT.md writer +
//   streamSpawner + result persistence + investigate loop).
// - makeReviewer: independent reviewer factory.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { appendFileSafe, writeFileSafe } from "../core.js";
import {
  CTX_DIR,
  DEFAULT_MAX_ROUNDS,
  buildEnginePrompt,
  c,
  createCheckpoint,
  detectQuota,
  discoverSkills,
  gitState,
  investigateUnit,
  makeAsyncSpawner,
  matchSkillsForTask,
  out,
  persistDispatch,
  recoveryHint,
  restoreIgnored,
  runDispatchAsync,
  thresholdFor,
} from "./_shared.js";
import type {
  AsyncResearcher,
  AsyncSpawner,
  Checkpoint,
  DispatchResult,
  Engine,
  EngineReadiness,
  FailureProtection,
  GitRunner,
  ProjectContext,
  QuotaSignal,
  Reviewer,
  RiskClass,
  UnitDispatcher,
  UnitInvestigationOutcome,
  UnitOutcome,
  WorkUnit,
} from "./_shared.js";

export const MS_PER_SECOND = 1000;

/** Shared quota latch: the first HIGH-confidence limit signal stops not-yet-started units. */
interface QuotaState {
  limited: boolean;
  signal?: QuotaSignal;
}

/** Per-dispatch source-protection runtime threaded into the (cli-mode) dispatcher. */
export interface ProtectionRuntime {
  checkpoint: Checkpoint | null;
  fp: FailureProtection;
  git: GitRunner;
  quota: QuotaState;
  rolledBack: boolean;
}

/** Decision from the pre-dispatch source-protection gate. */
interface ProtectionPlan {
  refused: boolean;
  reason?: string;
  checkpoint: Checkpoint | null;
}

/** Default git seam (argv only, never shell) scoped to a repo, mirroring checkpoint.ts. */
export function repoGit(base: string): GitRunner {
  return (args) => {
    const r = spawnSync("git", args, { cwd: base, encoding: "utf8" });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** Settings + per-run flags merged: a flag can only turn a protection ON, never off. */
export function resolveProtection(
  flags: Record<string, string | boolean>,
  fp: FailureProtection,
): FailureProtection {
  return {
    timeoutSeconds: fp.timeoutSeconds,
    autoWip: fp.autoWip || Boolean(flags["auto-wip"]),
    requireGit: fp.requireGit || Boolean(flags["require-git"]),
    rollbackOnFail: fp.rollbackOnFail || Boolean(flags["rollback-on-fail"]),
  };
}

/**
 * Gate a REAL (cli) dispatch on repo state. Refuses (no checkpoint) when git is required but
 * absent, or the tree is dirty without `autoWip`; otherwise warns/checkpoints and proceeds.
 */
export function planProtection(
  base: string,
  runId: string,
  fp: FailureProtection,
  git: GitRunner,
): ProtectionPlan {
  const state = gitState(base, git);
  if (!state.isRepo) {
    if (fp.requireGit) {
      return {
        refused: true,
        reason: "refusing: not a git repository (requireGit). Run `git init` then re-run.",
        checkpoint: null,
      };
    }
    out(
      "vf",
      c.yellow("! no git — engine edits are irreversible; proceeding without a checkpoint"),
    );
    return { refused: false, checkpoint: createCheckpoint(base, runId, { autoWip: false, git }) };
  }
  if (state.dirty && !fp.autoWip) {
    return {
      refused: true,
      reason:
        "refusing: uncommitted changes in the working tree. Commit/stash them, or pass --auto-wip.",
      checkpoint: null,
    };
  }
  const cp = createCheckpoint(base, runId, { autoWip: state.dirty, git });
  if (cp.wipSha) {
    out("vf", c.dim(`checkpoint: WIP snapshot ${cp.wipSha.slice(0, 8)} taken before dispatch`));
  }
  return { refused: false, checkpoint: cp };
}

/** Persist the pre-dispatch checkpoint (+ recovery hint) as auditable unit evidence. */
function persistCheckpoint(unitDir: string, cp: Checkpoint): string {
  const rel = "evidence/checkpoint.json";
  writeFileSafe(join(unitDir, rel), JSON.stringify({ ...cp, recovery: recoveryHint(cp) }, null, 2));
  return rel;
}

/** Persist a detected quota signal as unit evidence. */
function persistQuota(unitDir: string, sig: QuotaSignal): string {
  const rel = "evidence/quota.json";
  writeFileSafe(join(unitDir, rel), JSON.stringify(sig, null, 2));
  return rel;
}

/**
 * Inspect a dispatch result for a quota/rate-limit signal. Records it as evidence and, on a
 * HIGH-confidence limit, latches the shared stop flag so not-yet-started units are skipped
 * rather than deepening the hole. LOW-confidence prose stays advisory (never auto-stops).
 */
function recordQuota(
  prot: ProtectionRuntime,
  unitRel: string,
  unitDir: string,
  result: DispatchResult,
  evidence: string[],
): void {
  const sig = detectQuota({ status: result.ok ? 0 : 1, stdout: result.raw, reason: result.reason });
  if (!sig.limited) return;
  evidence.push(`${unitRel}/${persistQuota(unitDir, sig)}`);
  if (sig.confidence === "high") {
    prot.quota.limited = true;
    prot.quota.signal = sig;
    out("vf", c.yellow(`! quota signal (${sig.kind}) — stopping remaining units: ${sig.evidence}`));
  }
}

/** Roll the tree back to the pre-dispatch state (once) and restore backed-up ignored files. */
function rollbackCheckpoint(base: string, prot: ProtectionRuntime): void {
  const cp = prot.checkpoint;
  if (!cp || prot.rolledBack) return;
  prot.rolledBack = true;
  const target = cp.baseRef ?? cp.wipSha;
  if (target) prot.git(["reset", "--hard", target]);
  const restored = restoreIgnored(cp, base);
  const ref = (target ?? "HEAD").slice(0, 8);
  const extra = restored.length ? ` (+${restored.length} ignored file(s) restored)` : "";
  out("vf", c.yellow(`rolled back to ${ref}${extra}`));
}

/** On a blocked unit in cli mode: print the recovery hint, then roll back when configured. */
// Exported (not just internal) so the `run` subcommand
// (src/commands/run.ts, phase 6.5/14) can call it via the barrel
// (_shared.js). Without the export, the run path would
// re-implement the same hook.
export function handleUnitFailure(prot: ProtectionRuntime, base: string): void {
  if (prot.checkpoint) out("vf", c.yellow(recoveryHint(prot.checkpoint)));
  if (prot.fp.rollbackOnFail) rollbackCheckpoint(base, prot);
}

/** Blocked outcome for a unit skipped because an upstream rate limit was already hit. */
function skippedByQuota(): UnitOutcome {
  return {
    status: "blocked",
    confidence: 0,
    evidence: [],
    gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
  };
}

/**
 * A read-only research step backed by the real dispatcher: each round dispatches a research
 * prompt (never writes) and reports the engine's self-assessed confidence. Used by
 * {@link investigateUnit} to raise confidence on a unit below the bar before we block it.
 */
// Test seam: exported so unit tests can exercise the summary-uncertainty
// and raw-envelope fallback branches without dispatching a real engine.
export function makeResearcher(
  engine: Engine,
  ctx: ProjectContext,
  mode: "cli" | "bridge" | "dry",
  dispatchSpawner?: AsyncSpawner,
): AsyncResearcher {
  // Research rounds are read-only and should be fast — use a per-round timeout (180s)
  // so investigation never cascades into a multi-hour hang when a round's engine stalls.
  const researchSpawner = dispatchSpawner ?? makeAsyncSpawner({ timeoutMs: 180_000 });
  return async (round, question) => {
    const prompt = buildEnginePrompt(engine, { ...ctx, goal: question }, [
      `research round ${round}`,
    ]);
    const result = await runDispatchAsync({ engine, prompt, mode, spawner: researchSpawner });
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
      } catch {
        /* raw isn't JSON — fall through */
      }
    }
    if (findings.length === 0) {
      findings.push(result.ok ? `round ${round}: research dispatched` : "research failed");
    }
    return { findings, confidence, blocked: !result.ok };
  };
}

/** Persist an investigation outcome as auditable evidence inside the unit's evidence/ folder. */
function persistInvestigation(unitDir: string, outcome: UnitInvestigationOutcome): string {
  const rel = "evidence/investigation.json";
  writeFileSafe(
    join(unitDir, rel),
    JSON.stringify(
      {
        proceed: outcome.proceed,
        finalConfidence: outcome.finalConfidence,
        threshold: outcome.threshold,
        stoppedBy: outcome.stoppedBy,
        recommendation: outcome.recommendation,
        rounds: outcome.rounds,
      },
      null,
      2,
    ),
  );
  return rel;
}

/**
 * Compute the work unit's `knowledge_heavy_source` field from its risk class + spec text.
 * Test seam: exported so the 4-branch ternary can be unit-tested
 * without invoking the full makeDispatcher flow.
 */
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
  spawner?: AsyncSpawner,
  prot?: ProtectionRuntime,
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
    const skillMatches = matchSkillsForTask(discoverSkills(base), unitText);
    const skillNames = skillMatches.map((m) => m.skill.name);
    const looksUiUx = /\b(ui|ux|screen|layout|design|component|theme|accessib)/i.test(unitText);
    const knowledgeHeavy = riskClass === "feature" || riskClass === "architecture" || looksUiUx;
    const skillGap = knowledgeHeavy && skillNames.length === 0;
    // The full mixed-trust list actually injected into the prompt vs the VERIFIED-only subset
    // that a downstream skills-first gate is allowed to count as satisfying the requirement.
    const skillsInjected = skillNames;
    const skillsRequired = skillMatches
      .filter((m) => m.skill.status === "verified")
      .map((m) => m.skill.name);
    // Why the unit is knowledge-heavy: risk class first, else the UX/UI regex, else undefined.
    const knowledgeHeavySource = computeKnowledgeHeavySource(riskClass, unitText);
    const prompt = buildEnginePrompt(engine, ctx, [
      { name: u.name, spec: u.spec, scope: u.scope, skills: skillNames, skillGap },
    ]);
    writeFileSafe(join(unitDir, "CONTEXT.md"), prompt);
    const evidence: string[] = [];
    if (prot?.checkpoint) {
      evidence.push(`${unitRel}/${persistCheckpoint(unitDir, prot.checkpoint)}`);
    }
    // Stream output to a unit-level log file so the web UI SSE relay can show
    // live engine stdout. Truncate then append; format each chunk as SSE line.
    // DEPRECATED: this file is being superseded by the logbus + M3 SSE endpoint
    // (see out("engine-stdout"|"engine-stderr", ...) below). Kept for one more
    // minor version so the existing web UI continues to render.
    const streamPath = join(unitDir, "stream.log");
    try {
      writeFileSafe(streamPath, "");
    } catch {
      /* best effort */
    }
    // PR28 audit Task 5 (M1): the old code used `spawner ?? makeAsyncSpawner({ onChunk, ... })`,
    // which meant when a custom spawner was injected (e.g. for testing or for a different
    // chunk strategy) the per-unit `onChunk` and `onStderrChunk` callbacks were NEVER
    // fired — the file stream was never appended, and the logbus never saw engine
    // progress, breaking the SSE relay for that unit. Fix: if a custom `spawner` is
    // provided, WRAP it so the per-unit callbacks fire around the result. The chunks
    // arrive post-hoc (after the spawner resolves) rather than during streaming, but
    // the SSE log and logbus fanout are now CORRECT. The default path (no spawner) is
    // unchanged — `makeAsyncSpawner({ onChunk, onStderrChunk })` still streams live.
    const streamSpawner: AsyncSpawner =
      spawner == null
        ? makeAsyncSpawner({
            onChunk: (text) => {
              try {
                const line = `data: ${JSON.stringify({ unit: u.name, text, ts: Date.now() })}\n\n`;
                appendFileSafe(streamPath, line);
              } catch {
                /* streaming is best-effort */
              }
              // M2: mirror to the logbus so the SSE endpoint (M3) and the file bus
              // both see engine progress without a second read of the spawner.
              out("engine-stdout", text, {
                unit: u.name,
                meta: { engine, unit: u.name },
              });
            },
            onStderrChunk: (text) => {
              // M2: route engine warnings/errors/progress noise to the bus as
              // warn-level events. Stderr no longer leaks to the parent TTY
              // (stdio is now piped — see dispatch.ts); the bus owns visibility.
              out("engine-stderr", text, {
                level: "warn",
                unit: u.name,
                meta: { engine, unit: u.name },
              });
            },
          })
        : async (cmd, args, input) => {
            // Composed path: invoke the injected spawner, then fan the accumulated
            // stdout/stderr out via the per-unit callbacks. The callbacks are
            // best-effort: a logging failure must not break the dispatch.
            const r = await spawner(cmd, args, input);
            try {
              if (r.stdout) {
                const line = `data: ${JSON.stringify({ unit: u.name, text: r.stdout, ts: Date.now() })}\n\n`;
                appendFileSafe(streamPath, line);
              }
              if (r.stdout) {
                out("engine-stdout", r.stdout, { unit: u.name, meta: { engine, unit: u.name } });
              }
              // Stderr: AsyncSpawner's return type only has { status, stdout, timedOut? };
              // the base spawner may not surface stderr. The composed callback stays
              // for shape compatibility; production engines route stderr via the
              // orchestrator-level onStderrChunk (see orchestrate()).
            } catch {
              /* per-unit stream fanout is best-effort */
            }
            return r;
          };
    const result = await runDispatchAsync({ engine, prompt, mode, spawner: streamSpawner });
    // A dry run is a READ-ONLY preview: the CONTEXT.md prompt above is its ONE intended
    // side-effect. It must never write result JSON nor append to the persisted evidence
    // ledger, so the dispatch outcome is reported in-memory only.
    if (mode !== "dry") {
      evidence.push(`${unitRel}/${persistDispatch(unitDir, result)}`);
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
      const research = makeResearcher(engine, ctx, mode, spawner);
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

    return {
      status,
      confidence,
      evidence,
      gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
      knowledge_heavy: knowledgeHeavy,
      knowledge_heavy_source: knowledgeHeavySource,
      skills_injected: skillsInjected,
      skills_required: skillsRequired,
      skills_used: result.summary?.skills_used ?? [],
    };
  };
}

/**
 * Independent reviewer. Signature: `(unit, outcome) → { pass, reason }` — the first arg is the
 * dispatched unit (ignored), the second is its outcome (the reviewer inspects confidence +
 * evidence). A dry run is a PREVIEW, not a verdict — it passes review neutrally so the goal
 * lands `partial` (exit 0), not `blocked`. A real run only passes at confidence ≥ threshold
 * with evidence; anything less blocks (no completion on a guess). The `confidence < threshold`
 * branch returns a SPECIFIC reason ("investigated, still blocked") so the e2e suite can assert
 * the investigation loop ran end-to-end (i.e. the unit was investigated + blocked, not silently
 * closed).
 */
export function makeReviewer(mode: "cli" | "bridge" | "dry", threshold: number): Reviewer {
  return (_u, outcome) => {
    if (mode === "dry") {
      return { pass: true, reason: "dry preview — not evaluated (re-run with --yes)" };
    }
    if (outcome.confidence < threshold) {
      return {
        pass: false,
        reason: `confidence ${outcome.confidence} < ${threshold} — investigated, still blocked`,
      };
    }
    if (!outcome.evidence?.length) return { pass: false, reason: "no recorded evidence" };
    return { pass: true, reason: `confidence ${outcome.confidence} ≥ ${threshold} with evidence` };
  };
}
