import type { HookInput, HookResult } from "../core.js";
import {
  HOOK_DECISION,
  HOOK_EVENT,
  type HookDecision,
  RISK_LEVEL,
  type RiskLevel,
  isHookEvent,
} from "../core/hook-contract.js";
import type { SemanticJudge } from "./risk-semantic.js";
import { scoreRisk } from "./risk.js";
import type { ResolvedHookPolicy } from "./templates.js";

/** Map a risk level to a guardrail decision (HOOKS_AND_GUARDRAILS.md vocabulary). */
function decisionFor(risk: RiskLevel): HookDecision {
  switch (risk) {
    case RISK_LEVEL.CRITICAL:
      return HOOK_DECISION.BLOCK;
    case RISK_LEVEL.HIGH:
      return HOOK_DECISION.REQUIRE_APPROVAL;
    case RISK_LEVEL.MEDIUM:
      return HOOK_DECISION.WARN;
    default:
      return HOOK_DECISION.ALLOW;
  }
}

/** Env getter seam so the kill-switch is testable without mutating process.env. */
export type EnvGetter = () => NodeJS.ProcessEnv;

/** Values of VIBEFLOW_HOOKS that explicitly disable the hook-decision layer. */
const HOOKS_OFF_VALUES = Object.freeze(["off", "0"] as const);

/**
 * Kill-switch check (item 4). FAIL SAFE: hooks are disabled ONLY when VIBEFLOW_HOOKS is the
 * explicit string `off` or `0`. Unset — or ANY unknown/garbage value — keeps hooks ON, so a
 * typo or injected junk can never silently fail open. This gates the hook-DECISION layer only;
 * the git pre-commit hook stays fail-closed independently (adapters.gitPreCommit), so disabling
 * here never bypasses that path.
 */
export function hooksDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.VIBEFLOW_HOOKS;
  return (
    typeof raw === "string" &&
    HOOKS_OFF_VALUES.some((candidate) => candidate === raw.trim().toLowerCase())
  );
}

/** A neutral allow result used when the kill-switch turns the hook-decision layer off. */
function disabledResult(): HookResult {
  return {
    decision: HOOK_DECISION.ALLOW,
    risk: RISK_LEVEL.NONE,
    reasons: ["hooks disabled via VIBEFLOW_HOOKS"],
  };
}

/**
 * Evaluate a hook event into a decision. Pure: same input → same result, so it is
 * safe to run from any engine adapter or the git pre-commit hook. The kill-switch (item 4)
 * is consulted first via an injectable env getter (defaults to process.env).
 *
 * An optional resolved `policy` gates which guardrail clusters run and adds custom
 * rules. Omitting it scores with the all-on default — every existing caller keeps its
 * exact behavior; only the live `vf hook` gate loads the repo's stored policy.
 *
 * `specStale` is an ADVISORY seam (Task 4): it returns spec-drift reasons for the
 * event. Advisory means warn-not-block — a stale signal never blocks and never
 * raises an existing block/approval to a weaker state; it only surfaces a `warn`
 * when the base decision was `allow`. Defaults to a no-op so every existing caller
 * is byte-for-byte unchanged; only the live gate wires the real freshness check.
 *
 * `judge` is an OPTIONAL semantic (LLM) tier threaded into scoreRisk. It can only RAISE
 * risk and is off unless a caller injects one (default undefined → byte-for-byte unchanged).
 */
export function evaluateHook(
  input: HookInput,
  getEnv: EnvGetter = () => process.env,
  policy?: ResolvedHookPolicy,
  specStale: (input: HookInput) => string[] = () => [],
  judge?: SemanticJudge,
): HookResult {
  if (hooksDisabled(getEnv())) return disabledResult();
  const { risk, reasons } = scoreRisk(input, policy, judge);
  const decision = decisionFor(risk);
  const stale = specStale(input);
  if (stale.length === 0) return { decision, risk, reasons };
  // Advisory: only escalate a benign `allow` to `warn`; never weaken a stronger decision.
  const advised = decision === HOOK_DECISION.ALLOW ? HOOK_DECISION.WARN : decision;
  return { decision: advised, risk, reasons: [...reasons, ...stale] };
}

/**
 * Map Claude Code's native `hook_event_name` to our internal HookEvent vocabulary.
 * Unknown-but-real Claude events fall through to "pre-tool-use" so a live tool gate
 * still gets evaluated (and yields allow for a benign action) rather than being rejected.
 */
function mapClaudeEvent(name: string): HookInput["event"] {
  switch (name) {
    case "PreToolUse":
      return HOOK_EVENT.PRE_TOOL_USE;
    case "PostToolUse":
      return HOOK_EVENT.POST_TOOL_USE;
    case "Stop":
    case "SubagentStop":
      return HOOK_EVENT.STOP;
    default:
      // A real Claude event we don't model explicitly: treat as a recognized no-op gate.
      return HOOK_EVENT.PRE_TOOL_USE;
  }
}

/**
 * Map GitHub Copilot CLI's native camelCase event name to our internal HookEvent
 * vocabulary. Per docs.github.com/en/copilot/reference/hooks-reference, Copilot
 * events arrive as `hookEventName` (camelCase). The Claude adapter is a separate
 * function (mapClaudeEvent) because Claude sends PascalCase via `hook_event_name`.
 */
function mapCopilotEvent(name: string): HookInput["event"] | null {
  switch (name) {
    case "preToolUse":
      return HOOK_EVENT.PRE_TOOL_USE;
    case "postToolUse":
      return HOOK_EVENT.POST_TOOL_USE;
    case "sessionStart":
    case "userPromptSubmitted":
      return HOOK_EVENT.PRE_TOOL_USE; // treat agent/session start as a recognized no-op gate
    case "sessionEnd":
      return HOOK_EVENT.STOP;
    case "errorOccurred":
    case "preCompact":
    case "agentStop":
    case "subagentStart":
    case "subagentStop":
    case "permissionRequest":
    case "notification":
      return null; // not yet modeled — drop the event so caller fail-opens distinctly
    default:
      return null;
  }
}

/**
 * Parse Claude Code's native PreToolUse/PostToolUse/Stop stdin payload, which has NO
 * `event` field. Shape: {hook_event_name, tool_name, tool_input:{command|file_path|files}}.
 * Returns null if this isn't a Claude-native payload (so the caller can fail open distinctly).
 */
function parseClaudeNative(obj: Record<string, unknown>): HookInput | null {
  const eventName = obj.hook_event_name;
  if (typeof eventName !== "string") return null;
  const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const toolInput = (obj.tool_input ?? {}) as Record<string, unknown>;
  const filePath = typeof toolInput.file_path === "string" ? [toolInput.file_path] : undefined;
  const fileList = Array.isArray(toolInput.files) ? toolInput.files.map(String) : undefined;
  const files = filePath || fileList ? [...(filePath ?? []), ...(fileList ?? [])] : undefined;
  const edits = Array.isArray(toolInput.edits)
    ? toolInput.edits
        .map((e) => (e as Record<string, unknown>)?.new_string)
        .filter((s): s is string => typeof s === "string")
        .join("\n")
    : undefined;
  const content = asStr(toolInput.content) ?? asStr(toolInput.new_string) ?? edits;
  return {
    event: mapClaudeEvent(eventName),
    tool: asStr(obj.tool_name),
    workspace: asStr(obj.workspace ?? obj.cwd),
    command: asStr(toolInput.command),
    files,
    content,
    stopHookActive: obj.stop_hook_active === true,
  };
}

/**
 * Parse GitHub Copilot CLI's native preToolUse/postToolUse stdin payload.
 * Shape: {hookEventName: "preToolUse", toolName: "bash", toolArgs: {command: "..."}}
 *  - hookEventName is camelCase (NOT snake_case like Claude)
 *  - toolArgs holds the per-tool input; `command` is the field for the bash tool
 * Returns null if this isn't a Copilot-native payload or the event isn't modeled.
 */
function parseAntigravityNative(obj: Record<string, unknown>): HookInput | null {
  const toolCall = obj.toolCall as Record<string, unknown> | undefined;
  if (!toolCall || typeof toolCall.name !== "string") return null;
  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const workspacePaths = Array.isArray(obj.workspacePaths) ? obj.workspacePaths : [];
  const workspace = workspacePaths.find((path): path is string => typeof path === "string");
  // PostToolUse payloads carry toolCall and must route through post-tool-use
  // branch so post-action audit/verification runs. Any unrecognized or absent
  // event defaults to pre-tool-use (conservative: treat as before-tool gate).
  const event: HookInput["event"] =
    obj.event === "PostToolUse" ? HOOK_EVENT.POST_TOOL_USE : HOOK_EVENT.PRE_TOOL_USE;
  return {
    event,
    tool: toolCall.name,
    workspace,
    command: typeof args.CommandLine === "string" ? args.CommandLine : undefined,
    files: typeof args.TargetFile === "string" ? [args.TargetFile] : undefined,
    content: typeof args.Content === "string" ? args.Content : undefined,
  };
}

function parseCopilotNative(obj: Record<string, unknown>): HookInput | null {
  const eventName = obj.hookEventName;
  if (typeof eventName !== "string") return null;
  const event = mapCopilotEvent(eventName);
  if (event === null) return null;
  const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const toolArgs = (obj.toolArgs ?? {}) as Record<string, unknown>;
  const pathStr = asStr(toolArgs.path);
  return {
    event,
    tool: asStr(obj.toolName),
    workspace: asStr(obj.cwd),
    command: asStr(toolArgs.command),
    files: pathStr ? [pathStr] : undefined,
    content: asStr(toolArgs.content),
  };
}

/**
 * Parse a raw hook payload (from stdin) into a validated HookInput, or null.
 * Tries the legacy `{event,...}` shape first (back-compat: git pre-commit + tests),
 * then falls back to Claude Code's native `{hook_event_name, tool_name, tool_input}` shape,
 * then to GitHub Copilot's native `{hookEventName, toolName, toolArgs}` shape.
 */
export function parseHookInput(raw: string): HookInput | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const event = obj.event;
  if (isHookEvent(event)) {
    const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    const asStrArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.map(String) : undefined;
    return {
      event,
      tool: asStr(obj.tool),
      workspace: asStr(obj.workspace),
      command: asStr(obj.command),
      files: asStrArr(obj.files),
      agent: asStr(obj.agent),
      taskId: asStr(obj.taskId),
      scope: asStrArr(obj.scope),
      intent: asStr(obj.intent),
      content: asStr(obj.content),
    };
  }
  // No usable legacy `event` field — try Claude Code's native payload shape.
  const claude = parseClaudeNative(obj);
  if (claude !== null) return claude;
  const antigravity = parseAntigravityNative(obj);
  if (antigravity !== null) return antigravity;
  // Then try GitHub Copilot's native payload shape (camelCase hookEventName).
  return parseCopilotNative(obj);
}

/**
 * Exit code convention for the hook CLI.
 *
 * Claude Code 2026 spec: JSON is ONLY processed on exit 0. Exit 2 with JSON = JSON ignored,
 * which causes "JSON validation failed". So ALL decisions use exit 0 — the JSON payload
 * carries the decision (block/warn/allow/require_approval), not the exit code.
 *
 * PreToolUse uses the `permissionDecision` envelope; Stop uses `decision:block` top-level;
 * both exit 0 so Claude actually reads the JSON.
 */
export function exitCodeFor(_decision: HookDecision): number {
  return 0;
}

/**
 * Present a decision for the active event.
 *
 * Claude Code 2026 spec: JSON is ONLY processed on exit 0. Exit 2 with JSON = JSON ignored,
 * causing "JSON validation failed". Therefore ALL decisions use exit 0 — the JSON payload
 * carries the decision, not the exit code.
 *
 * PreToolUse: `hookSpecificOutput.permissionDecision` = allow | ask | deny
 * Stop:       `{decision:"block",reason:"..."}` to block, `{suppressOutput:true}` for silent
 * PostToolUse: `hookSpecificOutput.additionalContext` for feedback, `{suppressOutput:true}` silent
 */
export function presentAntigravityDecision(result: HookResult): { json: string; exitCode: number } {
  const decision =
    result.decision === HOOK_DECISION.BLOCK
      ? "deny"
      : result.decision === HOOK_DECISION.REQUIRE_APPROVAL
        ? "ask"
        : "allow";
  return { json: JSON.stringify({ decision, reason: result.reasons.join("; ") }), exitCode: 0 };
}

export function presentDecision(
  result: HookResult,
  input: HookInput,
  verifyGate: (input: HookInput) => string | null = () => null,
): { json: string; exitCode: number } {
  // --- PreToolUse: permissionDecision envelope ---
  if (input.event === HOOK_EVENT.PRE_TOOL_USE) {
    const permissionDecision =
      result.decision === HOOK_DECISION.BLOCK
        ? ("deny" as const)
        : result.decision === HOOK_DECISION.REQUIRE_APPROVAL
          ? ("ask" as const)
          : ("allow" as const);
    return {
      json: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision,
          permissionDecisionReason: result.reasons.join("; "),
        },
      }),
      exitCode: 0,
    };
  }
  // --- Stop events ---
  // Block: top-level `decision:block` (exit 0 — Claude reads JSON, blocks the stop)
  // Risks but no block: `hookSpecificOutput.additionalContext` to inject feedback
  // No risks: `{suppressOutput:true}` for silent approval (no JSON noise)
  if (input.event === HOOK_EVENT.STOP) {
    const hasRisks = result.reasons.length > 0 && result.reasons[0] !== "no risk signals detected";
    // Risk-scan block always wins (destructive cmd / secret in the final state).
    if (result.decision === HOOK_DECISION.BLOCK) {
      return {
        json: JSON.stringify({ decision: HOOK_DECISION.BLOCK, reason: result.reasons.join("; ") }),
        exitCode: 0,
      };
    }
    // #624 Task 3: verify-gate. If code changed but no passing `vf verify` is
    // recorded for the current commit, force the agent to run it before ending.
    // stopHookActive downgrades the hard block to advice so we never loop forever
    // (respects CLAUDE_CODE_STOP_HOOK_BLOCK_CAP).
    const verifyReason = verifyGate(input);
    if (verifyReason && !input.stopHookActive) {
      return {
        json: JSON.stringify({ decision: HOOK_DECISION.BLOCK, reason: verifyReason }),
        exitCode: 0,
      };
    }
    const advisories = [
      ...(hasRisks ? result.reasons : []),
      ...(verifyReason && input.stopHookActive ? [verifyReason] : []),
    ];
    if (advisories.length > 0) {
      return {
        json: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: advisories.join("; "),
          },
        }),
        exitCode: 0,
      };
    }
    // No risks, no block — emit empty object (suppressOutput invalid for Stop per 2026 spec)
    return { json: "{}", exitCode: 0 };
  }
  // --- PostToolUse events ---
  // Feedback: `hookSpecificOutput.additionalContext`
  // Silent: `{suppressOutput:true}`
  if (input.event === HOOK_EVENT.POST_TOOL_USE) {
    const hasFeedback =
      result.reasons.length > 0 && result.reasons[0] !== "no risk signals detected";
    if (!hasFeedback) {
      // PostToolUse: {} = no action, allow to proceed. suppressOutput is NOT a no-op
      // substitute — it hides stdout but Claude still parses it as a meaningful payload,
      // and some versions reject it as invalid for PostToolUse.
      return { json: "{}", exitCode: 0 };
    }
    return {
      json: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: result.reasons.join("; "),
        },
      }),
      exitCode: 0,
    };
  }
  // Other events: use top-level decision/reason fields, exit 0 (per 2026 spec).
  return { json: JSON.stringify(result), exitCode: 0 };
}
