import { isAgentEngine } from "../../core/agent-contract.js";
import { type EvaluatorOutput, type RoundDecision, decideRound } from "../consensus.js";
import type {
  ConversationHealth,
  ConversationLifecycle,
  PublicStoredTraceEvent,
} from "../trace/types.js";
import {
  CONVERSATION_ARTIFACT_TYPE,
  CONVERSATION_CONTINUING_DECISION_OUTCOMES,
  CONVERSATION_CONVERGENCE_NOT_APPLICABLE,
  CONVERSATION_DECISION_OUTCOME,
  CONVERSATION_HEALTH_VALUES,
  CONVERSATION_INVALID_ASSESSMENT_REASON,
  CONVERSATION_LIFECYCLE,
  CONVERSATION_SANDBOXES,
  CONVERSATION_TERMINAL_LIFECYCLES,
  CONVERSATION_TOOL_INTENTS,
  CONVERSATION_TRACE_EVENT_KIND,
} from "./conversation-public-wire-contract.js";
import type { ConversationParticipantSnapshot } from "./types.js";

const TOOLS = new Set<string>(CONVERSATION_TOOL_INTENTS);
const SANDBOXES = new Set<string>(CONVERSATION_SANDBOXES);
const TERMINAL = new Set<ConversationLifecycle>(CONVERSATION_TERMINAL_LIFECYCLES);
const LEGAL = Object.freeze({
  [CONVERSATION_LIFECYCLE.INIT]: Object.freeze([
    CONVERSATION_LIFECYCLE.ACTIVE,
    CONVERSATION_LIFECYCLE.STOPPED,
  ]),
  [CONVERSATION_LIFECYCLE.ACTIVE]: Object.freeze([
    CONVERSATION_LIFECYCLE.PAUSED,
    CONVERSATION_LIFECYCLE.COMPLETED,
    CONVERSATION_LIFECYCLE.STOPPED,
    CONVERSATION_LIFECYCLE.FAILED,
    CONVERSATION_LIFECYCLE.ABORTED,
  ]),
  [CONVERSATION_LIFECYCLE.PAUSED]: Object.freeze([
    CONVERSATION_LIFECYCLE.ACTIVE,
    CONVERSATION_LIFECYCLE.STOPPED,
    CONVERSATION_LIFECYCLE.FAILED,
    CONVERSATION_LIFECYCLE.ABORTED,
  ]),
  [CONVERSATION_LIFECYCLE.COMPLETED]: Object.freeze([]),
  [CONVERSATION_LIFECYCLE.STOPPED]: Object.freeze([]),
  [CONVERSATION_LIFECYCLE.FAILED]: Object.freeze([]),
  [CONVERSATION_LIFECYCLE.ABORTED]: Object.freeze([]),
} satisfies Readonly<Record<ConversationLifecycle, readonly ConversationLifecycle[]>>);

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
    ((record.event.type === CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED &&
      record.event.payload.artifact_type === CONVERSATION_ARTIFACT_TYPE.COMPACTION) ||
      record.event.type === CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE);
  if (terminalRecorded && !reviewedAction) fail("terminal lifecycle is immutable");
  if (
    terminal(lifecycle) &&
    !terminalRecorded &&
    record.event.type !== CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL
  )
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
  if (record.event.type !== CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_CONFIGURED)
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
    const engine = item.engine;
    if (
      !text(id) ||
      seen.has(id) ||
      !text(item.role_ref) ||
      !isAgentEngine(engine) ||
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
    | Extract<
        PublicStoredTraceEvent,
        { event: { type: typeof CONVERSATION_TRACE_EVENT_KIND.PARTICIPANT_BOUND } }
      >
    | PublicStoredTraceEvent,
  participants: Map<string, ParticipantState>,
): ParticipantState {
  if (record.event.type !== CONVERSATION_TRACE_EVENT_KIND.PARTICIPANT_BOUND)
    return fail("invalid participant binding");
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
    !Object.hasOwn(LEGAL, payload.lifecycle) ||
    !CONVERSATION_HEALTH_VALUES.some((value) => value === payload.health) ||
    (payload.reason !== null && typeof payload.reason !== "string")
  )
    return fail("malformed state change");
  const next = payload.lifecycle as ConversationLifecycle;
  const nextHealth = payload.health as ConversationHealth;
  if (payload.terminal !== terminal(next)) return fail("malformed state change terminal flag");
  if (next === current) {
    if (
      (current !== CONVERSATION_LIFECYCLE.ACTIVE && current !== CONVERSATION_LIFECYCLE.PAUSED) ||
      nextHealth === health
    )
      return fail("invalid state change");
    return { lifecycle: current, health: nextHealth };
  }
  if (!LEGAL[current].some((candidate) => candidate === next))
    return fail(`illegal lifecycle transition ${current} -> ${next}`);
  if (nextHealth !== health) return fail("health must change independently of lifecycle");
  if (next === CONVERSATION_LIFECYCLE.COMPLETED && hasActiveRound)
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
        ? typeof gate.value !== "boolean" && gate.value !== CONVERSATION_CONVERGENCE_NOT_APPLICABLE
        : typeof gate.value !== "boolean")
    )
      return fail("malformed evaluator assessment");
  }
  return structuredClone(value) as unknown as EvaluatorOutput;
}

export function validateDecision(value: unknown): RoundDecision {
  if (!object(value) || typeof value.outcome !== "string") return fail("malformed decision");
  if (value.outcome === CONVERSATION_DECISION_OUTCOME.ABORT) {
    if (
      !exact(value, ["outcome", "score", "reason"]) ||
      value.score !== null ||
      value.reason !== CONVERSATION_INVALID_ASSESSMENT_REASON
    )
      return fail("malformed decision");
    return {
      outcome: CONVERSATION_DECISION_OUTCOME.ABORT,
      score: null,
      reason: CONVERSATION_INVALID_ASSESSMENT_REASON,
    };
  }
  if (
    !exact(value, ["outcome", "score"]) ||
    !CONVERSATION_CONTINUING_DECISION_OUTCOMES.some((outcome) => outcome === value.outcome) ||
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
    (observed.outcome !== CONVERSATION_DECISION_OUTCOME.ABORT ||
      (expected.outcome === CONVERSATION_DECISION_OUTCOME.ABORT &&
        observed.reason === expected.reason));
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
  const debateCompletion = lifecycle === CONVERSATION_LIFECYCLE.COMPLETED && policy === "debate";
  if (debateCompletion && consensusScore === null) {
    fail("terminal score requires a completed debate decision");
  }
  if (
    debateCompletion &&
    lastDecision?.outcome !== CONVERSATION_DECISION_OUTCOME.CONSENSUS &&
    lastDecision?.outcome !== CONVERSATION_DECISION_OUTCOME.EXHAUSTED
  ) {
    fail("terminal decision cannot complete while another debate round is required");
  }
  const expected = debateCompletion ? consensusScore : null;
  if (finalScore !== expected) fail("terminal score does not match lifecycle authority");
}
