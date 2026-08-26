import type { Engine } from "../core.js";
import {
  OWNED_PROCESS_TERMINAL_KIND,
  type OwnedProcessTerminalKind,
} from "./owned-process-contract.js";
import type { EngineSessionAdapterOptions } from "./session-types.js";

export interface EngineTerminalObservation {
  kind: Extract<
    OwnedProcessTerminalKind,
    | typeof OWNED_PROCESS_TERMINAL_KIND.CLAUDE_RESULT_SUCCESS
    | typeof OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED
  >;
  authenticated: true;
}

function parseJsonRecord(record: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(record) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function observeSessionTerminal(
  protocol: EngineSessionAdapterOptions["protocol"],
  engine: Engine,
  record: string,
): EngineTerminalObservation | undefined {
  if (protocol === "bridge") return undefined;
  const parsed = parseJsonRecord(record.trim());
  if (!parsed) return undefined;
  if (
    engine === "claude" &&
    parsed.type === "result" &&
    parsed.subtype === "success" &&
    typeof parsed.session_id === "string"
  ) {
    return { kind: OWNED_PROCESS_TERMINAL_KIND.CLAUDE_RESULT_SUCCESS, authenticated: true };
  }
  if (engine === "codex" && parsed.type === "turn.completed") {
    return { kind: OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED, authenticated: true };
  }
  return undefined;
}
