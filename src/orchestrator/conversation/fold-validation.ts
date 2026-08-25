import type { Engine } from "../../core/types.js";
import { type EvaluatorOutput, type RoundDecision, decideRound } from "../consensus.js";
import type {
  ConversationHealth,
  ConversationLifecycle,
  PublicStoredTraceEvent,
} from "../trace/types.js";
import type { ConversationParticipantSnapshot } from "./types.js";

const ENGINES = new Set<Engine>(["claude", "codex", "copilot", "opencode", "antigravity"]);
const TOOLS = new Set(["read", "write", "edit", "bash", "grep", "glob", "web"]);
const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const TERMINAL = new Set<ConversationLifecycle>(["COMPLETED", "STOPPED", "FAILED", "ABORTED"]);
const LEGAL: Readonly<Record<ConversationLifecycle, readonly ConversationLifecycle[]>> = {
  INIT: ["ACTIVE", "STOPPED"],
  ACTIVE: ["PAUSED", "COMPLETED", "STOPPED", "FAILED", "ABORTED"],
  PAUSED: ["ACTIVE", "STOPPED", "FAILED", "ABORTED"],
  COMPLETED: [],
  STOPPED: [],
  FAILED: [],
  ABORTED: [],
};

export class ConversationFoldError extends Error {}
export const fail = (message: string): never => {
  throw new ConversationFoldError(message);
};
export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
export const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
export const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

export function validateTerminalAppend(
  lifecycle: ConversationLifecycle,
  terminalRecorded: boolean,
  record: PublicStoredTraceEvent,
  reviewed: boolean,
): void {
  const reviewedAction =
    reviewed &&
    ((record.event.type === "artifact_created" &&
      record.event.payload.artifact_type === "compaction") ||
      record.event.type === "user_message");
  if (terminalRecorded && !reviewedAction) fail("terminal lifecycle is immutable");
  if (terminal(lifecycle) && !terminalRecorded && record.event.type !== "conversation_terminal")
    fail("terminal lifecycle is immutable until its terminal record");
}
export const terminal = (value: ConversationLifecycle) => TERMINAL.has(value);

export type ParticipantState = ConversationParticipantSnapshot & { bound: boolean };
export interface ConfiguredConversation {
  topic: string;
  policy: string;
  maxRounds: number;
  participants: ParticipantState[];
}

export function validateEnvelope(
  records: readonly PublicStoredTraceEvent[],
): PublicStoredTraceEvent {
  if (!records.length) return fail("conversation journal is empty");
  const first = records[0] as PublicStoredTraceEvent;
  const identity = ["workflow_id", "conversation_id", "revision_id", "run_id"] as const;
  if (identity.some((key) => !text(first[key]))) return fail("invalid conversation identity");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.seq !== index + 1 || !Number.isSafeInteger(record.seq))
      return fail("invalid sequence");
    if (identity.some((key) => record[key] !== first[key]))
      return fail("mixed conversation identity");
    if (
      !object(record.event) ||
      !exact(record.event, ["type", "payload"]) ||
      !text(record.event.type)
    )
      return fail("malformed trace event");
  }
  return first;
}

export function validateConfigured(record: PublicStoredTraceEvent): ConfiguredConversation {
  if (record.event.type !== "conversation_configured")
    return fail("conversation must be configured first");
  const payload = record.event.payload as unknown;
  if (
    !object(payload) ||
    !exact(payload, ["topic", "participants", "policy", "max_rounds"]) ||
    typeof payload.topic !== "string" ||
    !text(payload.policy) ||
    !Number.isSafeInteger(payload.max_rounds) ||
    (payload.max_rounds as number) < 1 ||
    !Array.isArray(payload.participants) ||
    !payload.participants.length
  )
    return fail("malformed conversation configuration");
  const seen = new Set<string>();
  const participants = payload.participants.map((item) => {
    if (!object(item) || !exact(item, ["participant_id", "role_ref", "engine", "model"]))
      return fail("malformed configured participant");
    const id = item.participant_id as string;
    const engine = item.engine as Engine;
    if (
      !text(id) ||
      seen.has(id) ||
      !text(item.role_ref) ||
      !ENGINES.has(engine) ||
      (item.model !== null && !text(item.model))
    )
      return fail("malformed configured participant");
    seen.add(id);
    return {
      participant_id: id,
      role_ref: item.role_ref,
      engine,
      model: item.model as string | null,
      public_session_ref: null,
      bound: false,
    } as ParticipantState;
  });
  return {
    topic: payload.topic,
    policy: payload.policy,
    maxRounds: payload.max_rounds as number,
    participants,
  };
}

export function validateParticipantBound(
  record:
    | Extract<PublicStoredTraceEvent, { event: { type: "participant_bound" } }>
    | PublicStoredTraceEvent,
  participants: Map<string, ParticipantState>,
): ParticipantState {
  if (record.event.type !== "participant_bound") return fail("invalid participant binding");
  const payload = record.event.payload as unknown;
  if (
    !object(payload) ||
    !exact(payload, ["participant_id", "engine", "model", "prompt_hash", "tools", "sandbox"]) ||
    !text(payload.participant_id) ||
    !text(payload.prompt_hash) ||
    !stringArray(payload.tools) ||
    !payload.tools.every((tool) => TOOLS.has(tool)) ||
    !SANDBOXES.has(payload.sandbox as string)
  )
    return fail("invalid participant binding");
  const participant = participants.get(payload.participant_id);
  if (
    !participant ||
    participant.bound ||
    record.participant_id !== payload.participant_id ||
    record.role_ref !== participant.role_ref ||
    record.engine !== participant.engine ||
    payload.engine !== participant.engine ||
    payload.model !== participant.model
  )
    return fail("invalid participant binding");
  return participant;
}

export function validateParticipantCorrelation(
  record: PublicStoredTraceEvent,
  participant: ParticipantState,
): void {
  if (
    record.participant_id !== participant.participant_id ||
    record.role_ref !== participant.role_ref ||
    record.engine !== participant.engine
  ) {
    fail("participant correlation does not match configured authority");
  }
}

export function validateCoordinatorCorrelation(record: PublicStoredTraceEvent): void {
  if (
    record.participant_id !== undefined ||
    record.role_ref !== undefined ||
    record.engine !== undefined
  ) {
    fail("coordinator event has participant correlation");
  }
}

export function applyState(
  current: ConversationLifecycle,
  health: ConversationHealth,
  payload: unknown,
  hasActiveRound: boolean,
): { lifecycle: ConversationLifecycle; health: ConversationHealth } {
  if (
    !object(payload) ||
    !exact(payload, ["lifecycle", "health", "terminal", "reason"]) ||
    typeof payload.lifecycle !== "string" ||
    !(payload.lifecycle in LEGAL) ||
    !["healthy", "degraded"].includes(payload.health as string) ||
    (payload.reason !== null && typeof payload.reason !== "string")
  )
    return fail("malformed state change");
  const next = payload.lifecycle as ConversationLifecycle;
  const nextHealth = payload.health as ConversationHealth;
  if (payload.terminal !== terminal(next)) return fail("malformed state change terminal flag");
  if (next === current) {
    if ((current !== "ACTIVE" && current !== "PAUSED") || nextHealth === health)
      return fail("invalid state change");
    return { lifecycle: current, health: nextHealth };
  }
  if (!LEGAL[current].includes(next))
    return fail(`illegal lifecycle transition ${current} -> ${next}`);
  if (nextHealth !== health) return fail("health must change independently of lifecycle");
  if (next === "COMPLETED" && hasActiveRound)
    return fail("cannot complete with an active response");
  return { lifecycle: next, health };
}

export function validateAssessment(value: unknown): EvaluatorOutput {
  if (!object(value)) return fail("malformed evaluator assessment");
  const names = ["agreement", "conflict_resolution", "evidence_quality", "convergence"];
  if (!exact(value, names)) return fail("malformed evaluator assessment");
  for (const name of names) {
    const gate = value[name];
    if (
      !object(gate) ||
      !exact(gate, ["value", "evidence"]) ||
      typeof gate.evidence !== "string" ||
      (name === "convergence"
        ? typeof gate.value !== "boolean" && gate.value !== "not_applicable"
        : typeof gate.value !== "boolean")
    )
      return fail("malformed evaluator assessment");
  }
  return structuredClone(value) as unknown as EvaluatorOutput;
}

export function validateDecision(value: unknown): RoundDecision {
  if (!object(value) || typeof value.outcome !== "string") return fail("malformed decision");
  if (value.outcome === "abort") {
    if (
      !exact(value, ["outcome", "score", "reason"]) ||
      value.score !== null ||
      value.reason !== "invalid_assessment"
    )
      return fail("malformed decision");
    return { outcome: "abort", score: null, reason: "invalid_assessment" };
  }
  if (
    !exact(value, ["outcome", "score"]) ||
    !["consensus", "continue", "exhausted"].includes(value.outcome) ||
    typeof value.score !== "number" ||
    !Number.isFinite(value.score) ||
    value.score < 0 ||
    value.score > 1
  )
    return fail("malformed decision");
  return { ...value } as RoundDecision;
}

export function validateCanonicalDecision(
  value: unknown,
  assessment: EvaluatorOutput,
  round: number,
  maxRounds: number,
): RoundDecision {
  const observed = validateDecision(value);
  const expected = decideRound(assessment, round, maxRounds);
  const same =
    observed.outcome === expected.outcome &&
    observed.score === expected.score &&
    (observed.outcome !== "abort" ||
      (expected.outcome === "abort" && observed.reason === expected.reason));
  if (!same) return fail("consensus decision does not match canonical decideRound result");
  return observed;
}

export function validateTerminalScore(
  lifecycle: ConversationLifecycle,
  policy: string,
  finalScore: unknown,
  consensusScore: number | null,
  lastDecision: RoundDecision | null,
): void {
  const debateCompletion = lifecycle === "COMPLETED" && policy === "debate";
  if (debateCompletion && consensusScore === null) {
    fail("terminal score requires a completed debate decision");
  }
  if (
    debateCompletion &&
    lastDecision?.outcome !== "consensus" &&
    lastDecision?.outcome !== "exhausted"
  ) {
    fail("terminal decision cannot complete while another debate round is required");
  }
  const expected = debateCompletion ? consensusScore : null;
  if (finalScore !== expected) fail("terminal score does not match lifecycle authority");
}
