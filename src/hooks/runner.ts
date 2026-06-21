import type { HookDecision, HookInput, HookResult, RiskLevel } from "../core.js";
import { scoreRisk } from "./risk.js";
import type { ResolvedHookPolicy } from "./templates.js";

/** Map a risk level to a guardrail decision (HOOKS_AND_GUARDRAILS.md vocabulary). */
function decisionFor(risk: RiskLevel): HookDecision {
  switch (risk) {
    case "critical":
      return "block";
    case "high":
      return "require_approval";
    case "medium":
      return "warn";
    default:
      return "allow";
  }
}

/** Env getter seam so the kill-switch is testable without mutating process.env. */
export type EnvGetter = () => NodeJS.ProcessEnv;

/** Values of VIBEFLOW_HOOKS that explicitly disable the hook-decision layer. */
const HOOKS_OFF_VALUES = new Set(["off", "0"]);

/**
 * Kill-switch check (item 4). FAIL SAFE: hooks are disabled ONLY when VIBEFLOW_HOOKS is the
 * explicit string `off` or `0`. Unset — or ANY unknown/garbage value — keeps hooks ON, so a
 * typo or injected junk can never silently fail open. This gates the hook-DECISION layer only;
 * the git pre-commit hook stays fail-closed independently (adapters.gitPreCommit), so disabling
 * here never bypasses that path.
 */
export function hooksDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.VIBEFLOW_HOOKS;
  return typeof raw === "string" && HOOKS_OFF_VALUES.has(raw.trim().toLowerCase());
}

/** A neutral allow result used when the kill-switch turns the hook-decision layer off. */
function disabledResult(): HookResult {
  return { decision: "allow", risk: "none", reasons: ["hooks disabled via VIBEFLOW_HOOKS"] };
}

/**
 * Evaluate a hook event into a decision. Pure: same input → same result, so it is
 * safe to run from any engine adapter or the git pre-commit hook. The kill-switch (item 4)
 * is consulted first via an injectable env getter (defaults to process.env).
 *
 * An optional resolved `policy` gates which guardrail clusters run and adds custom
 * rules. Omitting it scores with the all-on default — every existing caller keeps its
 * exact behavior; only the live `vf hook` gate loads the repo's stored policy.
 */
export function evaluateHook(
  input: HookInput,
  getEnv: EnvGetter = () => process.env,
  policy?: ResolvedHookPolicy,
): HookResult {
  if (hooksDisabled(getEnv())) return disabledResult();
  const { risk, reasons } = policy ? scoreRisk(input, policy) : scoreRisk(input);
  return { decision: decisionFor(risk), risk, reasons };
}

const HOOK_EVENTS = [
  "pre-tool-use",
  "post-tool-use",
  "pre-write",
  "post-write",
  "pre-command",
  "post-command",
  "stop",
  "skill-compliance",
  "verify-result",
] as const;

/**
 * Map Claude Code's native `hook_event_name` to our internal HookEvent vocabulary.
 * Unknown-but-real Claude events fall through to "pre-tool-use" so a live tool gate
 * still gets evaluated (and yields allow for a benign action) rather than being rejected.
 */
function mapClaudeEvent(name: string): HookInput["event"] {
  switch (name) {
    case "PreToolUse":
      return "pre-tool-use";
    case "PostToolUse":
      return "post-tool-use";
    case "Stop":
    case "SubagentStop":
      return "stop";
    default:
      // A real Claude event we don't model explicitly: treat as a recognized no-op gate.
      return "pre-tool-use";
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
      return "pre-tool-use";
    case "postToolUse":
      return "post-tool-use";
    case "sessionStart":
    case "userPromptSubmitted":
      return "pre-tool-use"; // treat agent/session start as a recognized no-op gate
    case "sessionEnd":
      return "stop";
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
  return {
    event: mapClaudeEvent(eventName),
    tool: asStr(obj.tool_name),
    workspace: asStr(obj.workspace ?? obj.cwd),
    command: asStr(toolInput.command),
    files,
  };
}

/**
 * Parse GitHub Copilot CLI's native preToolUse/postToolUse stdin payload.
 * Shape: {hookEventName: "preToolUse", toolName: "bash", toolArgs: {command: "..."}}
 *  - hookEventName is camelCase (NOT snake_case like Claude)
 *  - toolArgs holds the per-tool input; `command` is the field for the bash tool
 * Returns null if this isn't a Copilot-native payload or the event isn't modeled.
 */
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
  if (typeof event === "string" && HOOK_EVENTS.includes(event as HookInput["event"])) {
    const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    const asStrArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.map(String) : undefined;
    return {
      event: event as HookInput["event"],
      tool: asStr(obj.tool),
      workspace: asStr(obj.workspace),
      command: asStr(obj.command),
      files: asStrArr(obj.files),
      agent: asStr(obj.agent),
      taskId: asStr(obj.taskId),
      scope: asStrArr(obj.scope),
      intent: asStr(obj.intent),
    };
  }
  // No usable legacy `event` field — try Claude Code's native payload shape.
  const claude = parseClaudeNative(obj);
  if (claude !== null) return claude;
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
export function presentDecision(
  result: HookResult,
  input: HookInput,
): { json: string; exitCode: number } {
  // --- PreToolUse: permissionDecision envelope ---
  if (input.event === "pre-tool-use") {
    const permissionDecision =
      result.decision === "block"
        ? ("deny" as const)
        : result.decision === "require_approval"
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
  if (input.event === "stop") {
    const hasRisks = result.reasons.length > 0 && result.reasons[0] !== "no risk signals detected";
    if (result.decision === "block") {
      return {
        json: JSON.stringify({ decision: "block", reason: result.reasons.join("; ") }),
        exitCode: 0,
      };
    }
    if (hasRisks) {
      return {
        json: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: result.reasons.join("; "),
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
  if (input.event === "post-tool-use") {
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
