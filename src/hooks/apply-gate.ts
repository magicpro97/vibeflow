// Apply-time guardrail gate for detection-only engines (#547).
//
// Claude and Copilot veto risky actions mid-loop via native pre-action hooks
// (PreToolUse / preToolUse, fail-closed — see adapters.ts / #79). Codex has no
// such vetoing hook, so its produced diff never passes a pre-execution gate.
// This module closes that one real gap: classify a detection-only engine's diff
// PER-HUNK through the SAME scoreRisk machinery, and route HIGH+ risk to the
// existing web-UI approval modal — fail-closed (a classifier throw ⇒ critical ⇒
// confirm, never a silent pass).
import { randomUUID } from "node:crypto";
import { cwd } from "node:process";
import { getUnitDiffResult } from "../commands/dispatch-reviewer-llm.js";
import type { Engine, HookInput, HookResult, RiskLevel } from "../core.js";
import { registerPending } from "../server/pending-hooks.js";
import { engineEnforcement } from "./adapters.js";
import type { SemanticJudge } from "./risk-semantic.js";
import { NO_SIGNALS, RISK_ORDER, scoreRisk } from "./risk.js";

/** One parsed hunk: the file it touches and its added lines (no `+` prefix). */
interface Hunk {
  path: string;
  added: string[];
}

/**
 * Split a unified git diff into per-file/per-hunk segments. A file block is opened by its
 * `--- a/<old>` / `+++ b/<new>` header pair; every subsequent added line (`+`, but NOT the
 * `+++` header) is collected under that file, its leading `+` stripped. The touched PATH is
 * kept even for a deletion (`+++ /dev/null`, real name in `--- a/<path>`) so a PROTECTED_PATH
 * removal (e.g. deleting `.env`) is still scored by files[]. Malformed input yields no hunks.
 */
function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let pendingOld: string | undefined; // path from the most recent `--- a/<path>` line
  for (const line of diff.split("\n")) {
    // `--- a/<path>` (or `--- /dev/null` for an addition) — remember the old path so a
    // deletion whose `+++` is `/dev/null` still resolves to the real file name.
    if (line.startsWith("--- ") && !line.startsWith("--- +")) {
      pendingOld = line === "--- /dev/null" ? undefined : line.slice(4).replace(/^a\//, "").trim();
      continue;
    }
    // A real new-file header is `+++ b/<path>` or `+++ /dev/null` (deletion). Requiring the
    // marker stops an ADDED content line rendered `+++ …` from being misread as a header (WARN-3).
    const isHeader = line.startsWith("+++ b/") || line === "+++ /dev/null";
    if (isHeader) {
      const newPath =
        line === "+++ /dev/null" ? undefined : line.slice(4).replace(/^b\//, "").trim();
      const path = newPath ?? pendingOld ?? "";
      current = { path, added: [] };
      hunks.push(current);
      pendingOld = undefined;
    } else if (line.startsWith("+") && current) {
      // Everything else beginning with `+` is added content (including a `+++ …` that is NOT a
      // real header, e.g. an added line whose own text starts with `++ `).
      current.added.push(line.slice(1));
    }
  }
  // Keep a hunk when it has added content OR a resolved path — a pure deletion has no added
  // lines but its path must still reach scoreRisk's files[] (PROTECTED_PATH check).
  return hunks.filter((h) => h.added.length > 0 || h.path !== "");
}

/**
 * Classify a produced diff PER-HUNK (#547). Each hunk's added lines are scored as a
 * synthetic pre-command HookInput through `scoreRisk` (DANGEROUS_COMMAND / PROTECTED_PATH
 * + the optional semantic tier), and the MAX risk across hunks wins. Each hunk that
 * contributes a non-`none` risk pushes its reasons prefixed with its path, so the modal
 * shows WHICH change tripped the gate. Never throws — malformed/empty ⇒ `{none, []}`.
 */
export function classifyDiff(
  diff: string,
  judge?: SemanticJudge,
): { risk: RiskLevel; reasons: string[] } {
  const hunks = parseHunks(diff);
  let risk: RiskLevel = "none";
  const reasons: string[] = [];
  for (const h of hunks) {
    const joined = h.added.join("\n");
    const input: HookInput = {
      event: "pre-command",
      command: joined,
      files: [h.path],
      content: joined,
    };
    // scoreRisk calls the optional judge unguarded; a throwing judge must not break the
    // "never throws" contract — a hunk we can't score fails CLOSED to `critical` (NIT-1).
    let scored: { risk: RiskLevel; reasons: string[] };
    try {
      scored = scoreRisk(input, undefined, judge);
    } catch {
      scored = { risk: "critical", reasons: [`${h.path}: risk scorer threw — fail-closed`] };
    }
    if (RISK_ORDER.indexOf(scored.risk) > RISK_ORDER.indexOf(risk)) risk = scored.risk;
    // A hunk names itself only for REAL signals. scoreRisk floors every non-empty command to
    // `low` with the NO_SIGNALS placeholder — filtering it keeps a benign hunk silent, so the
    // modal lists ONLY the change that tripped the gate.
    for (const r of scored.reasons) {
      if (r !== NO_SIGNALS) reasons.push(`${h.path}: ${r}`);
    }
  }
  return { risk, reasons };
}

/** Injection seam + config for {@link enforceApplyGate}. All optional (production wires the real confirm). */
export interface ApplyGateDeps {
  classify?: (diff: string) => { risk: RiskLevel; reasons: string[] };
  /** Resolve a HIGH-risk diff to allow/block. Default: the web-UI approval modal. */
  confirm?: (input: HookInput, result: HookResult) => Promise<"allow" | "block">;
  /** Optional semantic (LLM) risk tier, threaded into the default classifier. */
  judge?: SemanticJudge;
  /** Risk at/above which the gate asks for confirmation. Default `high`. */
  threshold?: RiskLevel;
  /**
   * Whether an unclassifiable case confirms. Only the catch path is unclassifiable and it
   * already fails closed to `critical` (≥ any threshold ⇒ confirm), so this is documentary:
   * a `none` verdict on a valid diff is genuinely benign and is NOT forced to confirm.
   * ponytail: kept as a documented no-op knob to mirror ConfirmRisky's shape — wire a real
   *   effect only if a future policy wants to confirm every non-empty unknown diff.
   */
  confirmUnknown?: boolean;
}

/**
 * Register a pending approval with the web-UI modal and await the user's decision. Mirrors
 * the server's own `POST /api/hook/pending` → `registerPending` path. FAIL-CLOSED: if the
 * registration throws (server down / import failure), resolve `block` — never allow on error.
 * `register` is injectable so a test can prove the fail-closed path.
 * ponytail: thin wrapper over registerPending; the CLI/server entrypoint injects the real
 *   loopback confirm. skipped: live server loopback wiring — add when the gate runs headless.
 */
export async function defaultConfirm(
  input: HookInput,
  result: HookResult,
  register: typeof registerPending = registerPending,
): Promise<"allow" | "block"> {
  try {
    // AWAIT so a REJECTED promise (not just a sync throw) is caught and fails closed.
    return await register(randomUUID(), input, result);
  } catch {
    return "block";
  }
}

/**
 * Apply-time gate (#547). Gates ONLY detection-only engines (codex) — native engines
 * (claude/copilot) already vetoed mid-loop, so they pass through with no double gate.
 * Risk is computed FAIL-CLOSED: a classifier throw ⇒ `critical`. At/above `threshold`
 * (default `high`) the diff is routed to `confirm` (default: the web-UI modal); below it,
 * the diff is allowed.
 */
export async function enforceApplyGate(
  engine: Engine,
  diff: string,
  deps: ApplyGateDeps = {},
): Promise<{ allowed: boolean; risk: RiskLevel; reasons: string[] }> {
  if (engineEnforcement(engine).preActionBlocking !== "post-hoc-only") {
    return { allowed: true, risk: "none", reasons: [`${engine} blocks natively — no apply-gate`] };
  }

  let risk: RiskLevel;
  let reasons: string[];
  try {
    ({ risk, reasons } = (deps.classify ?? ((d) => classifyDiff(d, deps.judge)))(diff));
  } catch {
    risk = "critical";
    reasons = ["apply-gate classifier threw — fail-closed to critical"];
  }

  const threshold = deps.threshold ?? "high";
  if (RISK_ORDER.indexOf(risk) >= RISK_ORDER.indexOf(threshold)) {
    const input: HookInput = { event: "pre-command", command: diff.slice(0, 500) };
    const result: HookResult = { decision: "require_approval", risk, reasons };
    // A confirm that THROWS/rejects (modal unreachable, server down) must fail CLOSED to
    // block — never crash the wave (run.ts awaits this outside the dispatcher try/catch).
    let decision: "allow" | "block";
    try {
      decision = await (deps.confirm ?? defaultConfirm)(input, result);
    } catch {
      return { allowed: false, risk, reasons: [...reasons, "confirm unreachable — fail-closed"] };
    }
    return { allowed: decision === "allow", risk, reasons };
  }
  return { allowed: true, risk, reasons };
}

/** Minimal shape the apply-gate needs to re-block a unit — a WorkUnit-ish subset. */
interface GateableUnit {
  status: string;
  gates: Record<string, unknown>;
  scope?: string[];
}

/**
 * Orchestrator glue (#547): for a reviewed+passed unit, run the apply-gate and, when the diff
 * is `!allowed`, MUTATE the unit to blocked + security:fail and return the reason (else null).
 * No-op when the gate is off, the review already failed, or the diff is allowed. Owns the whole
 * block so the per-unit loop in run.ts stays one line (and run.ts under the 400-line cap).
 */
export async function applyGateBlock(
  opts: {
    applyGate?: OrchestratorApplyGate;
    applyGateEngine?: Engine;
    cwd?: string;
    applyGateDiff?: (cwd: string, scope: string[]) => { diff: string; ok: boolean };
  },
  unit: GateableUnit,
  reviewPassed: boolean,
): Promise<{ reason: string } | null> {
  if (!reviewPassed || !opts.applyGate || !opts.applyGateEngine) return null;
  // Fail CLOSED on a diff-retrieval error: if git can't produce the diff we must NOT let the
  // unit through unclassified (WARN-1). A genuine empty diff (ok:true, "") has nothing to gate.
  const { diff, ok } = (opts.applyGateDiff ?? getUnitDiffResult)(
    opts.cwd ?? cwd(),
    unit.scope ?? [],
  );
  if (!ok) {
    unit.status = "blocked";
    unit.gates = { ...unit.gates, security: "fail" };
    return { reason: "apply-gate blocked: could not read unit diff — fail-closed" };
  }
  const g = await opts.applyGate(opts.applyGateEngine, diff);
  if (g.allowed) return null;
  unit.status = "blocked";
  unit.gates = { ...unit.gates, security: "fail" };
  return { reason: `apply-gate blocked: ${g.reasons.join("; ") || "risky diff"}` };
}

/** The apply-gate the orchestrator injects (default `enforceApplyGate` bound with deps). */
export type OrchestratorApplyGate = (
  engine: Engine,
  diff: string,
) => Promise<{ allowed: boolean; risk: RiskLevel; reasons: string[] }>;
