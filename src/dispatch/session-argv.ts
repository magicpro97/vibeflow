import type { Engine } from "../core.js";
import { AGENT_ENGINE } from "../core/agent-contract.js";
import { ROLE_SANDBOX } from "../core/role-contract.js";
import { engineCommand, isUnavailable, materializePrompt } from "../dispatch.js";
import { CONVERSATION_RECONCILIATION_STATUS } from "../orchestrator/conversation/conversation-public-wire-contract.js";
import { loadNativeHistory, reconcileNativeHistory } from "./prompt.js";
import { captureSafeNativeSessionId, requireSafeNativeSessionId } from "./public-redaction.js";
import { ENGINE_SESSION_MODE, supportsExactNativeSessionResume } from "./session-contract.js";
import {
  type HistoryReconcileRequest,
  type HistoryReconcileResult,
  type SpawnOptionsProjection,
  isCanonicalSpawnOptionsProjection,
} from "./session-types.js";

const MUTATING_TOOLS = new Set(["write", "edit", "bash", "shell"]);
const CLAUDE_READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "webfetch", "websearch"]);

function assertReadOnlyTools(spawn: SpawnOptionsProjection): void {
  if (spawn.sandbox !== ROLE_SANDBOX.READ_ONLY) return;
  const unsafe = spawn.rendered_tools.filter((tool) => {
    const base = /^[A-Za-z][A-Za-z0-9]*/.exec(tool)?.[0]?.toLowerCase() ?? "";
    return (
      MUTATING_TOOLS.has(base) ||
      (spawn.engine === AGENT_ENGINE.CLAUDE && !CLAUDE_READ_ONLY_TOOLS.has(base))
    );
  });
  if (unsafe.length) {
    throw new Error(`read-only sandbox denies mutating tools: ${unsafe.join(",")}`);
  }
}

/** Pure validation seam for the immutable engine/environment authority invariant. */
export function assertSelectedConversationEngine(
  spawn: Pick<SpawnOptionsProjection, "engine" | "env_policy">,
): void {
  if (spawn.env_policy.selectedEngine !== spawn.engine) {
    throw new Error("spawn.env_policy must select the launched conversation engine");
  }
}

export function assertSpawnProjection(
  spawn: SpawnOptionsProjection,
  nativeSessionId?: string,
): void {
  if (!isCanonicalSpawnOptionsProjection(spawn)) {
    throw new Error("spawn projection lacks canonical spawn authority");
  }
  if (!spawn.rendered_prompt) throw new Error("spawn.rendered_prompt is required");
  if (!spawn.provenance.roleSource || !spawn.provenance.roleHash) {
    throw new Error("spawn provenance is incomplete");
  }
  if (spawn.provenance.roleHash !== spawn.trace_metadata.role_resolved_hash) {
    throw new Error("role provenance and trace metadata disagree");
  }
  if (
    JSON.stringify(spawn.provenance.skillHashes) !==
    JSON.stringify(spawn.trace_metadata.skill_resolved_hashes)
  ) {
    throw new Error("skill provenance and trace metadata disagree");
  }
  assertSelectedConversationEngine(spawn);
  if (spawn.sessionMode === ENGINE_SESSION_MODE.EXACT) {
    if (!nativeSessionId) throw new Error("exact session mode requires a native session id");
    if (!supportsExactNativeSessionResume(spawn.engine)) {
      throw new Error(`${spawn.engine} exact resume is unavailable for safe admission`);
    }
    requireSafeNativeSessionId(spawn.engine, nativeSessionId);
  }
  if (spawn.engine === AGENT_ENGINE.CODEX && spawn.rendered_tools.length > 0) {
    throw new Error("codex cannot enforce rendered tools with the current CLI; launch denied");
  }
  if (
    (spawn.engine === AGENT_ENGINE.OPENCODE || spawn.engine === AGENT_ENGINE.ANTIGRAVITY) &&
    (spawn.rendered_tools.length > 0 || spawn.sandbox !== null)
  ) {
    throw new Error(`${spawn.engine} cannot enforce rendered tools or sandbox; launch denied`);
  }
  assertReadOnlyTools(spawn);
}

export function sessionInvocation(
  spawn: SpawnOptionsProjection,
  nativeSessionId?: string,
  prompt = spawn.rendered_prompt,
) {
  const exactId = spawn.sessionMode === ENGINE_SESSION_MODE.EXACT ? nativeSessionId : undefined;
  const base = engineCommand(
    spawn.engine,
    { has: () => true, version: () => "session-adapter" },
    false,
    exactId,
  );
  if (isUnavailable(base)) throw new Error(base.unavailable);
  const args = [...base.args];
  if (spawn.engine === AGENT_ENGINE.COPILOT) {
    const permissive = args.indexOf("--allow-all");
    if (permissive >= 0) args.splice(permissive, 1);
  }
  if (spawn.engine === AGENT_ENGINE.OPENCODE) {
    const auto = args.indexOf("--auto");
    if (auto >= 0) args.splice(auto, 1);
  }
  if (spawn.model) {
    if (spawn.engine === AGENT_ENGINE.CLAUDE) args.push("--model", spawn.model);
    else if (spawn.engine === AGENT_ENGINE.CODEX) args.unshift("--model", spawn.model);
    else args.push("--model", spawn.model);
  }
  if (spawn.engine === AGENT_ENGINE.CLAUDE) {
    args.unshift("--safe-mode");
    args.push("--tools", spawn.rendered_tools.join(","));
    if (spawn.rendered_tools.length) {
      args.push("--allowedTools", spawn.rendered_tools.join(","));
    }
  }
  if (spawn.engine === AGENT_ENGINE.COPILOT) {
    args.push(`--available-tools=${spawn.rendered_tools.join(",")}`);
  }
  if (spawn.sandbox === ROLE_SANDBOX.READ_ONLY) {
    if (spawn.engine === AGENT_ENGINE.CLAUDE) {
      args.push("--permission-mode", "plan", "--disallowedTools", "Write,Edit,Bash");
    } else if (spawn.engine === AGENT_ENGINE.CODEX)
      args.unshift("--sandbox", ROLE_SANDBOX.READ_ONLY);
    else if (spawn.engine === AGENT_ENGINE.COPILOT) args.push("--excluded-tools=Write,Edit,Bash");
  } else if (spawn.sandbox === ROLE_SANDBOX.WORKSPACE_WRITE) {
    if (spawn.engine === AGENT_ENGINE.CLAUDE) args.push("--permission-mode", "acceptEdits");
    else if (spawn.engine === AGENT_ENGINE.CODEX)
      args.unshift("--sandbox", ROLE_SANDBOX.WORKSPACE_WRITE);
    else if (spawn.engine === AGENT_ENGINE.COPILOT) args.push("--allow-all-tools");
  } else if (spawn.sandbox === ROLE_SANDBOX.DANGER_FULL_ACCESS) {
    if (spawn.engine === AGENT_ENGINE.CLAUDE) args.push("--dangerously-skip-permissions");
    else if (spawn.engine === AGENT_ENGINE.CODEX)
      args.unshift("--sandbox", ROLE_SANDBOX.DANGER_FULL_ACCESS);
    else if (spawn.engine === AGENT_ENGINE.COPILOT) args.push("--allow-all");
  }
  return materializePrompt({ ...base, args }, prompt);
}

function hasJsonLine(
  stdout: string,
  predicate: (value: Record<string, unknown>) => boolean,
): boolean {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (predicate(value)) return true;
    } catch {
      // A protocol acknowledgement must be a complete valid record.
    }
  }
  return false;
}

export function stdoutAcknowledges(
  engine: Engine,
  stdout: string,
  expectedNativeSessionId?: string,
): boolean {
  const observedNativeSessionId = captureSafeNativeSessionId(engine, stdout);
  if (expectedNativeSessionId !== undefined) {
    return observedNativeSessionId === expectedNativeSessionId;
  }
  if (engine === AGENT_ENGINE.CLAUDE) return observedNativeSessionId !== undefined;
  if (engine === AGENT_ENGINE.CODEX) {
    return (
      observedNativeSessionId !== undefined ||
      hasJsonLine(stdout, (value) => value.type === "turn.started")
    );
  }
  if (engine === AGENT_ENGINE.OPENCODE) return observedNativeSessionId !== undefined;
  return stdout.trim().length > 0;
}

export async function reconcileSessionHistory(
  request: HistoryReconcileRequest,
  historyRoots?: Partial<Record<Engine, readonly string[]>>,
): Promise<HistoryReconcileResult> {
  if (request.engine === AGENT_ENGINE.CLAUDE || request.engine === AGENT_ENGINE.CODEX) {
    requireSafeNativeSessionId(request.engine, request.nativeSessionId);
  }
  if (
    request.history ||
    (request.engine !== AGENT_ENGINE.CLAUDE && request.engine !== AGENT_ENGINE.CODEX)
  ) {
    return reconcileNativeHistory(request);
  }
  const loaded = loadNativeHistory(request, historyRoots?.[request.engine]);
  if (!loaded) return reconcileNativeHistory(request);
  const result = reconcileNativeHistory({ ...request, history: loaded.records });
  if (result.status !== CONVERSATION_RECONCILIATION_STATUS.RECONCILED) return result;
  return {
    ...result,
    status: loaded.complete
      ? CONVERSATION_RECONCILIATION_STATUS.RECONCILED
      : CONVERSATION_RECONCILIATION_STATUS.PARTIAL,
    completeness_reason: loaded.complete
      ? "supported native history loaded"
      : "native history contained malformed records",
  };
}
