// src/commands/dispatch-runtime.ts
//
// Dispatch/orchestration runtime: per-unit dispatcher, researcher,
// reviewer, and worktree isolation seam. Extracted from
// src/commands/protection.ts (issue #131).

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { appendFileSafe, writeFileSafe } from "../core.js";
import { mapGateResult } from "../orchestrator/gate-map.js";
import {
  CTX_DIR,
  DEFAULT_MAX_ROUNDS,
  buildEnginePrompt,
  c,
  defaultWorktreePath,
  detectQuota,
  discoverSkills,
  investigateUnit,
  makeAsyncSpawner,
  matchSkillsForTask,
  out,
  persistDispatch,
  recoveryHint,
  runDispatchAsync,
  thresholdFor,
} from "./_shared.js";
import type {
  AsyncResearcher,
  AsyncSpawner,
  DispatchResult,
  Engine,
  ProjectContext,
  QuotaSignal,
  Reviewer,
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

// ── Diff reader (inject seam) ──────────────────────────────────────────────────

/** Reads the git diff for a unit's scoped files. Inject seam for testing. */
export type DiffReader = (scope: readonly string[], cwd: string) => string;

/** Default: git diff HEAD for the scoped files. Returns empty string on error or empty scope. */
export function defaultDiffReader(scope: readonly string[], cwd: string): string {
  if (scope.length === 0) return "";
  try {
    // ponytail: use spawnSync with array args to avoid shell injection
    const r = spawnSync("git", ["diff", "HEAD", "--", ...scope], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
    return r.stdout ?? "";
  } catch {
    return "";
  }
}

interface DiffAnalysis {
  fail: boolean;
  reason: string;
}

const UNSAFE_PATTERNS = [
  /eval\s*\(/,
  /rm\s+-rf/,
  /process\.env\.\w+\s*=/, // writing to env (not reading)
  /\bpassword\b|\bsecret\b|\btoken\b/i,
];

export function analyzeDiff(diff: string, scope: readonly string[]): DiffAnalysis {
  if (!diff) return { fail: false, reason: "" };

  // ponytail: extract changed files from diff headers
  const changedFiles = [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)]
    .map((m) => m[1])
    .filter((f): f is string => !!f);

  // Scope creep: files outside unit scope changed
  // ponytail: file is in-scope if it IS the scope entry or is under that directory
  const outOfScope = changedFiles.filter(
    (f) => !scope.some((s) => f === s || f.startsWith(`${s}/`) || s.startsWith(`${f}/`)),
  );
  if (outOfScope.length > 0) {
    return { fail: true, reason: `scope creep: ${outOfScope.join(", ")} outside unit scope` };
  }

  // Unsafe edits: check added lines for dangerous patterns
  const addedLines = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  for (const line of addedLines) {
    for (const pat of UNSAFE_PATTERNS) {
      if (pat.test(line)) {
        return { fail: true, reason: `unsafe edit detected: ${pat.source} in added line` };
      }
    }
  }

  return { fail: false, reason: "" };
}

export interface WorktreeOps {
  /** Create a worktree for `branch` off `base` (git ref), return absolute path. */
  create: (branch: string, base: string) => string;
  /** Remove the worktree at `path` (best-effort; never throws). */
  remove: (path: string) => void;
}

/** Build a WorktreeOps backed by `spawn` (defaults to the real spawnSync).
 *  The injectable `spawn` seam lets tests exercise create/remove without
 *  touching real git — pass a fake that returns the desired status/throw. */
export function makeWorktreeOps(spawn: typeof spawnSync = spawnSync): WorktreeOps {
  return {
    create(branch, base) {
      const parentDir = resolve(process.cwd(), "..");
      const wtPath = defaultWorktreePath(branch, parentDir);
      const scriptPath = join(process.cwd(), "scripts", "create-worktree.sh");
      const r = spawn(scriptPath, [branch, wtPath, "--base", base], {
        encoding: "utf8",
        timeout: 60_000,
      });
      if (r.status !== 0) {
        const msg = r.stderr?.toString().trim() || `exit ${r.status}`;
        throw new Error(`worktree create failed for ${branch}: ${msg}`);
      }
      return wtPath;
    },
    remove(path) {
      try {
        spawn("git", ["worktree", "remove", "--force", path], {
          encoding: "utf8",
          timeout: 30_000,
        });
      } catch (e) {
        // biome-ignore format: keep single-line for line-count cap
        out("engine-stderr", `[dispatch] worktree cleanup best-effort failed: ${(e as Error).message}`, { level: "debug" });
      }
    },
  };
}

/** Default WorktreeOps — shells out to scripts/create-worktree.sh for create
 *  and git worktree remove --force for cleanup. Errors are swallowed in remove. */
export const defaultWorktreeOps: WorktreeOps = makeWorktreeOps();

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

/** Persist an investigation outcome as auditable evidence inside the unit's evidence/ folder. */
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
  isolate?: { base: string; wt?: WorktreeOps },
  gate?: ScopedGateFn,
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
              } catch (e) {
                // biome-ignore format: keep single-line for line-count cap
                out("engine-stderr", `[dispatch] stream.log append best-effort failed: ${(e as Error).message}`, { level: "debug", unit: u.name });
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
            ...(wtPath ? { cwd: wtPath } : {}),
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
            } catch (e) {
              // biome-ignore format: keep single-line for line-count cap
              out("engine-stderr", `[dispatch] logbus fanout best-effort failed: ${(e as Error).message}`, { level: "debug", unit: u.name });
            }
            return r;
          };
    // ponytail: try/finally ensures worktree removal even on throw.
    try {
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
      const measured =
        gate && mode === "cli" && u.scope?.length
          ? gate({ scope: u.scope, cwd: wtPath ?? base })
          : undefined;
      const gates = mapGateResult(measured);
      return {
        status,
        confidence,
        evidence,
        gates,
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
export function makeReviewer(
  mode: "cli" | "bridge" | "dry",
  threshold: number,
  inject?: { diffReader?: DiffReader; cwd?: string },
): Reviewer {
  const readDiff = inject?.diffReader ?? defaultDiffReader;
  const cwd = inject?.cwd ?? process.cwd();

  return (unit, outcome) => {
    if (mode === "dry") {
      return { pass: true, reason: "dry preview — not evaluated (re-run with --yes)" };
    }
    const failedGate = outcome.gates
      ? (["build", "lint", "test"] as const).find((k) => outcome.gates?.[k] === "fail")
      : undefined;
    if (failedGate) {
      return { pass: false, reason: `measured gate failed: ${failedGate}` };
    }
    if (outcome.confidence < threshold) {
      return {
        pass: false,
        reason: `confidence ${outcome.confidence} < ${threshold} — investigated, still blocked`,
      };
    }
    if (!outcome.evidence?.length) return { pass: false, reason: "no recorded evidence" };

    // Read and analyze the unit's actual diff
    const diff = readDiff(unit.scope ?? [], process.cwd());
    const analysis = analyzeDiff(diff, unit.scope ?? []);
    if (analysis.fail) return { pass: false, reason: analysis.reason };

    return {
      pass: true,
      reason: `confidence ${outcome.confidence} ≥ ${threshold} with evidence, diff clean`,
    };
  };
}
