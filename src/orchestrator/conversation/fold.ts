import type { RoundDecision } from "../consensus.js";
import type {
  ConversationHealth,
  ConversationLifecycle,
  OpaqueSessionRef,
  PublicStoredTraceEvent,
} from "../trace/types.js";
import {
  applyState,
  exact,
  fail,
  object,
  stringArray,
  terminal,
  text,
  validateAssessment,
  validateCanonicalDecision,
  validateConfigured,
  validateCoordinatorCorrelation,
  validateEnvelope,
  validateParticipantBound,
  validateParticipantCorrelation,
  validateTerminalScore,
} from "./fold-validation.js";
import type { ConversationSnapshot, Round, RoundAssessment, RoundResponse } from "./types.js";
export { ConversationFoldError } from "./fold-validation.js";

type ResponseState = RoundResponse & { completionCount: number };

interface RoundState {
  round_id: string;
  responses: Map<string, ResponseState>;
  precommits: Set<string>;
  assessments: RoundAssessment[];
  stages: Set<RoundAssessment["stage"]>;
  decision: RoundDecision | null;
  complete: boolean;
}

function publicRound(round: RoundState): Round {
  return {
    round_id: round.round_id,
    participant_responses: [...round.responses.values()].map(
      ({ completionCount: _completionCount, ...response }) => ({
        ...response,
        evidence: [...response.evidence],
      }),
    ),
    evaluator_assessments: round.assessments.map((item) => structuredClone(item)),
    decision: round.decision ? structuredClone(round.decision) : null,
    complete: round.complete,
  };
}

const createRound = (roundId: string): RoundState => ({
  round_id: roundId,
  responses: new Map(),
  precommits: new Set(),
  assessments: [],
  stages: new Set(),
  decision: null,
  complete: false,
});
const respondersComplete = (round: RoundState, responders: ReadonlySet<string>) =>
  round.responses.size === responders.size &&
  [...responders].every((id) => round.responses.get(id)?.completionCount === 1);
const precommitsComplete = (round: RoundState, responders: ReadonlySet<string>) =>
  round.precommits.size === responders.size &&
  [...responders].every((id) => round.precommits.has(id));
/** Deterministically reconstruct one public snapshot from its complete projected journal. */
export function foldConversation(records: readonly PublicStoredTraceEvent[]): ConversationSnapshot {
  const first = validateEnvelope(records);
  const configured = validateConfigured(first);
  const participants = new Map(
    configured.participants.map((participant) => [participant.participant_id, participant]),
  );
  const evaluatorIds = new Set(
    configured.participants
      .filter((participant) => participant.role_ref === "brainstorm-evaluator")
      .map((participant) => participant.participant_id),
  );
  const responderIds = new Set(
    configured.participants
      .filter((participant) => !evaluatorIds.has(participant.participant_id))
      .map((participant) => participant.participant_id),
  );
  const direct = configured.policy === "direct";
  const rounds: RoundState[] = [];
  const roundIds = new Set<string>();
  let activeRound: RoundState | undefined;
  let lifecycle: ConversationLifecycle = "INIT";
  let health: ConversationHealth = "healthy";
  let terminalRecorded = false;
  let consensusScore: number | null = null;
  for (const record of records.slice(1)) {
    if (terminalRecorded) return fail("terminal lifecycle is immutable");
    if (terminal(lifecycle) && record.event.type !== "conversation_terminal") {
      return fail("terminal lifecycle is immutable until its terminal record");
    }
    if (record.event.type === "conversation_configured") {
      return fail("duplicate conversation configuration");
    }
    if (record.public_session_ref !== null) {
      const participantId = record.participant_id as unknown as string | undefined;
      const participant = participantId ? participants.get(participantId) : undefined;
      if (!participant) return fail("public session lacks a configured participant");
      if (
        record.event.type === "native_history_reconciled" &&
        record.event.payload.public_session_ref !== record.public_session_ref
      ) {
        return fail("public session projection mismatch");
      }
      participant.public_session_ref = record.public_session_ref as OpaqueSessionRef;
    }
    switch (record.event.type) {
      case "participant_bound": {
        validateParticipantBound(record, participants).bound = true;
        break;
      }
      case "state_change": {
        ({ lifecycle, health } = applyState(
          lifecycle,
          health,
          record.event.payload,
          activeRound !== undefined,
        ));
        break;
      }
      case "round_boundary": {
        const { round_id: roundId, phase } = record.event.payload;
        validateCoordinatorCorrelation(record);
        if (
          direct ||
          !text(roundId) ||
          (phase !== "start" && phase !== "end") ||
          lifecycle !== "ACTIVE"
        ) {
          return fail("invalid round boundary");
        }
        if (phase === "start") {
          if (activeRound || roundIds.has(roundId)) {
            return fail("round is already active or duplicated");
          }
          if (rounds.length >= configured.maxRounds) return fail("maximum rounds exceeded");
          const previous = rounds.at(-1)?.decision;
          if (previous && previous.outcome !== "continue") return fail("prior round is terminal");
          activeRound = createRound(roundId);
          rounds.push(activeRound);
          roundIds.add(roundId);
          break;
        }
        if (!activeRound || activeRound.round_id !== roundId) {
          return fail("round end lacks active round");
        }
        if (!respondersComplete(activeRound, responderIds))
          return fail("ended round lacks every participant response");
        if (!precommitsComplete(activeRound, responderIds))
          return fail("ended round lacks every participant precommit");
        if (!activeRound.stages.has("blind") || !activeRound.stages.has("full")) {
          return fail("ended round lacks blind/full assessment");
        }
        if (!activeRound.decision || activeRound.decision.outcome === "abort") {
          return fail("ended round lacks non-abort consensus");
        }
        activeRound.complete = true;
        consensusScore = activeRound.decision.score;
        activeRound = undefined;
        break;
      }
      case "precommit": {
        const payload = record.event.payload as unknown;
        if (
          !object(payload) ||
          !exact(payload, ["round_id", "participant_id", "answer", "evidence"]) ||
          lifecycle !== "ACTIVE" ||
          !activeRound ||
          payload.round_id !== activeRound.round_id ||
          !text(payload.participant_id) ||
          !responderIds.has(payload.participant_id) ||
          record.participant_id !== payload.participant_id ||
          typeof payload.answer !== "string" ||
          !stringArray(payload.evidence) ||
          activeRound.precommits.has(payload.participant_id) ||
          activeRound.responses.size > 0 ||
          activeRound.stages.size > 0 ||
          activeRound.decision !== null
        ) {
          return fail("invalid or late participant precommit");
        }
        const participant = participants.get(payload.participant_id);
        if (!participant) return fail("precommit lacks configured participant correlation");
        validateParticipantCorrelation(record, participant);
        activeRound.precommits.add(payload.participant_id);
        break;
      }
      case "agent_response_delta": {
        const payload = record.event.payload as unknown;
        if (
          !object(payload) ||
          !exact(payload, [
            "round_id",
            "participant_id",
            "content_delta",
            "final_claim",
            "final_evidence",
            "completes_response",
          ]) ||
          lifecycle !== "ACTIVE" ||
          !text(payload.round_id) ||
          !text(payload.participant_id) ||
          record.participant_id !== payload.participant_id ||
          !responderIds.has(payload.participant_id) ||
          typeof payload.content_delta !== "string" ||
          (payload.final_claim !== null && typeof payload.final_claim !== "string") ||
          !stringArray(payload.final_evidence) ||
          typeof payload.completes_response !== "boolean"
        ) {
          return fail("malformed response delta or invalid responder");
        }
        const participant = participants.get(payload.participant_id);
        if (!participant) return fail("response lacks configured participant correlation");
        validateParticipantCorrelation(record, participant);
        if (!activeRound && direct && rounds.length === 0) {
          activeRound = createRound(payload.round_id);
          rounds.push(activeRound);
          roundIds.add(payload.round_id);
        }
        if (!activeRound || payload.round_id !== activeRound.round_id)
          return fail("response delta lacks active round");
        if (
          !direct &&
          (!precommitsComplete(activeRound, responderIds) ||
            !activeRound.stages.has("blind") ||
            activeRound.stages.has("full") ||
            activeRound.decision !== null)
        ) {
          return fail("response delta requires blind assessment after every precommit");
        }
        if (
          !payload.completes_response &&
          (payload.final_claim !== null || payload.final_evidence.length)
        ) {
          return fail("completion data on noncompletion delta");
        }
        let response = activeRound.responses.get(payload.participant_id);
        if (!response) {
          response = {
            participant_id: payload.participant_id,
            content: "",
            claim: null,
            evidence: [],
            complete: false,
            completionCount: 0,
          };
          activeRound.responses.set(payload.participant_id, response);
        }
        if (response.complete) return fail("delta after completion");
        response.content += payload.content_delta;
        if (payload.completes_response) {
          response.complete = true;
          response.completionCount += 1;
          response.claim = payload.final_claim;
          response.evidence = [...new Set(payload.final_evidence)];
          if (direct && respondersComplete(activeRound, responderIds)) {
            activeRound.complete = true;
            activeRound = undefined;
          }
        }
        break;
      }
      case "evaluator_assessment": {
        const payload = record.event.payload as unknown;
        if (
          !object(payload) ||
          !exact(payload, ["round_id", "stage", "assessment"]) ||
          !text(payload.round_id)
        ) {
          return fail("malformed evaluator assessment");
        }
        const evaluator = participants.get(record.participant_id as string);
        const stage = payload.stage as RoundAssessment["stage"];
        if (
          direct ||
          evaluatorIds.size !== 1 ||
          !evaluator ||
          !evaluatorIds.has(evaluator.participant_id) ||
          record.role_ref !== evaluator.role_ref ||
          record.engine !== evaluator.engine
        ) {
          return fail("invalid evaluator correlation");
        }
        if (lifecycle !== "ACTIVE" || !activeRound || payload.round_id !== activeRound.round_id) {
          return fail("assessment lacks active round");
        }
        if (stage !== "blind" && stage !== "full") return fail("malformed evaluator assessment");
        if (activeRound.stages.has(stage)) return fail("duplicate evaluator assessment");
        if (stage === "full" && !activeRound.stages.has("blind")) {
          return fail("blind assessment must occur before full assessment");
        }
        if (
          (stage === "blind" &&
            (!precommitsComplete(activeRound, responderIds) || activeRound.responses.size > 0)) ||
          (stage === "full" && !respondersComplete(activeRound, responderIds))
        ) {
          return fail(
            stage === "blind"
              ? "blind assessment requires every precommit before responses"
              : "full assessment requires every completed participant response",
          );
        }
        if (activeRound.decision) return fail("assessment occurred after consensus");
        activeRound.stages.add(stage);
        activeRound.assessments.push({
          stage,
          assessment: validateAssessment(payload.assessment),
        });
        break;
      }
      case "consensus_update": {
        const payload = record.event.payload;
        validateCoordinatorCorrelation(record);
        if (
          direct ||
          lifecycle !== "ACTIVE" ||
          !activeRound ||
          payload.round_id !== activeRound.round_id
        ) {
          return fail("consensus lacks active round");
        }
        if (!activeRound.stages.has("blind") || !activeRound.stages.has("full")) {
          return fail("blind/full assessment required before consensus");
        }
        if (activeRound.decision) return fail("duplicate consensus update");
        const full = activeRound.assessments.find((item) => item.stage === "full");
        if (!full) return fail("full assessment required before canonical decision");
        const next = validateCanonicalDecision(
          payload.decision,
          full.assessment,
          rounds.length,
          configured.maxRounds,
        );
        activeRound.decision = next;
        break;
      }
      case "conversation_terminal": {
        const payload = record.event.payload as unknown;
        if (
          !object(payload) ||
          !exact(payload, ["lifecycle", "terminal", "final_score"]) ||
          !terminal(lifecycle) ||
          payload.lifecycle !== lifecycle ||
          payload.terminal !== true
        ) {
          return fail("terminal record must match terminal lifecycle");
        }
        validateTerminalScore(
          lifecycle,
          configured.policy,
          payload.final_score,
          consensusScore,
          rounds.at(-1)?.decision ?? null,
        );
        terminalRecorded = true;
        break;
      }
      case "coordinator_decision":
      case "skill_injected":
      case "tool_action":
      case "user_message":
      case "baseline_result":
      case "synthesis_completed":
      case "dry_run_result":
      case "error":
      case "operation_lifecycle":
      case "approval_requested":
      case "approval_resolved":
      case "caller_cancelled":
      case "artifact_created":
      case "artifact_updated":
      case "native_history_reconciled":
        break;
      default:
        return fail("unsupported trace event");
    }
  }
  if (terminal(lifecycle) && !terminalRecorded) {
    return fail("terminal lifecycle requires a matching terminal record");
  }
  return {
    conversation_id: first.conversation_id as string,
    lifecycle,
    health,
    policy: configured.policy,
    topic: configured.topic,
    participants: configured.participants.map(({ bound: _bound, ...participant }) => participant),
    rounds: rounds.map(publicRound),
    consensus_score: consensusScore,
    last_seq: records.at(-1)?.seq ?? 0,
  };
}
