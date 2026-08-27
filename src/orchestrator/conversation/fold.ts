import type {
  ConversationHealth,
  ConversationLifecycle,
  OpaqueSessionRef,
  PublicStoredTraceEvent,
} from "../trace/types.js";

import {
  CONVERSATION_ASSESSMENT_STAGE,
  CONVERSATION_DECISION_OUTCOME,
  CONVERSATION_HEALTH,
  CONVERSATION_LIFECYCLE,
  CONVERSATION_ROUND_PHASE,
  CONVERSATION_TRACE_EVENT_KIND,
} from "./conversation-public-wire-contract.js";
import {
  type ReviewedActionEventAuthorityV1,
  assertReviewedActionEventAuthorityV1,
} from "./conversation-reviewed-action.js";
import {
  type FoldRoundState,
  createRound,
  precommitsComplete,
  publicRound,
  respondersComplete,
} from "./fold-round.js";
import { validateConversationTerminalEvent } from "./fold-terminal.js";
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
  validateTerminalAppend,
} from "./fold-validation.js";
import type { ConversationSnapshot, RoundAssessment } from "./types.js";
export { ConversationFoldError } from "./fold-validation.js";
/** Deterministically reconstruct one public snapshot from its complete projected journal. */
export function foldConversation(
  records: readonly PublicStoredTraceEvent[],
  reviewedPostTerminalEvents?: ReviewedActionEventAuthorityV1,
): ConversationSnapshot {
  if (reviewedPostTerminalEvents) assertReviewedActionEventAuthorityV1(reviewedPostTerminalEvents);
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
  const rounds: FoldRoundState[] = [];
  const roundIds = new Set<string>();
  let activeRound: FoldRoundState | undefined;
  let lifecycle: ConversationLifecycle = CONVERSATION_LIFECYCLE.INIT;
  let health: ConversationHealth = CONVERSATION_HEALTH.HEALTHY;
  let terminalRecorded = false;
  let consensusScore: number | null = null;
  for (const record of records.slice(1)) {
    validateTerminalAppend(
      lifecycle,
      terminalRecorded,
      record,
      reviewedPostTerminalEvents?.has(record.event_id) === true,
    );
    if (record.event.type === CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_CONFIGURED) {
      return fail("duplicate conversation configuration");
    }
    if (record.public_session_ref !== null) {
      const participantId = record.participant_id as unknown as string | undefined;
      const participant = participantId ? participants.get(participantId) : undefined;
      if (!participant) return fail("public session lacks a configured participant");
      if (
        record.event.type === CONVERSATION_TRACE_EVENT_KIND.NATIVE_HISTORY_RECONCILED &&
        record.event.payload.public_session_ref !== record.public_session_ref
      ) {
        return fail("public session projection mismatch");
      }
      participant.public_session_ref = record.public_session_ref as OpaqueSessionRef;
    }
    switch (record.event.type) {
      case CONVERSATION_TRACE_EVENT_KIND.PARTICIPANT_BOUND: {
        validateParticipantBound(record, participants).bound = true;
        break;
      }
      case CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE: {
        ({ lifecycle, health } = applyState(
          lifecycle,
          health,
          record.event.payload,
          activeRound !== undefined,
        ));
        break;
      }
      case CONVERSATION_TRACE_EVENT_KIND.ROUND_BOUNDARY: {
        const { round_id: roundId, phase } = record.event.payload;
        validateCoordinatorCorrelation(record);
        if (
          direct ||
          !text(roundId) ||
          (phase !== CONVERSATION_ROUND_PHASE.START && phase !== CONVERSATION_ROUND_PHASE.END) ||
          lifecycle !== CONVERSATION_LIFECYCLE.ACTIVE
        ) {
          return fail("invalid round boundary");
        }
        if (phase === CONVERSATION_ROUND_PHASE.START) {
          if (activeRound || roundIds.has(roundId)) {
            return fail("round is already active or duplicated");
          }
          if (rounds.length >= configured.maxRounds) return fail("maximum rounds exceeded");
          const previous = rounds.at(-1)?.decision;
          if (previous && previous.outcome !== CONVERSATION_DECISION_OUTCOME.CONTINUE)
            return fail("prior round is terminal");
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
        if (
          !activeRound.stages.has(CONVERSATION_ASSESSMENT_STAGE.BLIND) ||
          !activeRound.stages.has(CONVERSATION_ASSESSMENT_STAGE.FULL)
        ) {
          return fail("ended round lacks blind/full assessment");
        }
        if (
          !activeRound.decision ||
          activeRound.decision.outcome === CONVERSATION_DECISION_OUTCOME.ABORT
        ) {
          return fail("ended round lacks non-abort consensus");
        }
        activeRound.complete = true;
        consensusScore = activeRound.decision.score;
        activeRound = undefined;
        break;
      }
      case CONVERSATION_TRACE_EVENT_KIND.PRECOMMIT: {
        const payload = record.event.payload as unknown;
        if (
          !object(payload) ||
          !exact(payload, ["round_id", "participant_id", "answer", "evidence"]) ||
          lifecycle !== CONVERSATION_LIFECYCLE.ACTIVE ||
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
      case CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA: {
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
          lifecycle !== CONVERSATION_LIFECYCLE.ACTIVE ||
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
            !activeRound.stages.has(CONVERSATION_ASSESSMENT_STAGE.BLIND) ||
            activeRound.stages.has(CONVERSATION_ASSESSMENT_STAGE.FULL) ||
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
      case CONVERSATION_TRACE_EVENT_KIND.EVALUATOR_ASSESSMENT: {
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
        if (
          lifecycle !== CONVERSATION_LIFECYCLE.ACTIVE ||
          !activeRound ||
          payload.round_id !== activeRound.round_id
        ) {
          return fail("assessment lacks active round");
        }
        if (
          stage !== CONVERSATION_ASSESSMENT_STAGE.BLIND &&
          stage !== CONVERSATION_ASSESSMENT_STAGE.FULL
        )
          return fail("malformed evaluator assessment");
        if (activeRound.stages.has(stage)) return fail("duplicate evaluator assessment");
        if (
          stage === CONVERSATION_ASSESSMENT_STAGE.FULL &&
          !activeRound.stages.has(CONVERSATION_ASSESSMENT_STAGE.BLIND)
        ) {
          return fail("blind assessment must occur before full assessment");
        }
        if (
          (stage === CONVERSATION_ASSESSMENT_STAGE.BLIND &&
            (!precommitsComplete(activeRound, responderIds) || activeRound.responses.size > 0)) ||
          (stage === CONVERSATION_ASSESSMENT_STAGE.FULL &&
            !respondersComplete(activeRound, responderIds))
        ) {
          const reason =
            stage === CONVERSATION_ASSESSMENT_STAGE.BLIND
              ? "blind assessment requires every precommit before responses"
              : "full assessment requires every completed participant response";
          return fail(reason);
        }
        if (activeRound.decision) return fail("assessment occurred after consensus");
        activeRound.stages.add(stage);
        activeRound.assessments.push({
          stage,
          assessment: validateAssessment(payload.assessment),
        });
        break;
      }
      case CONVERSATION_TRACE_EVENT_KIND.CONSENSUS_UPDATE: {
        const payload = record.event.payload;
        validateCoordinatorCorrelation(record);
        if (
          direct ||
          lifecycle !== CONVERSATION_LIFECYCLE.ACTIVE ||
          !activeRound ||
          payload.round_id !== activeRound.round_id
        ) {
          return fail("consensus lacks active round");
        }
        if (
          !activeRound.stages.has(CONVERSATION_ASSESSMENT_STAGE.BLIND) ||
          !activeRound.stages.has(CONVERSATION_ASSESSMENT_STAGE.FULL)
        ) {
          return fail("blind/full assessment required before consensus");
        }
        if (activeRound.decision) return fail("duplicate consensus update");
        const full = activeRound.assessments.find(
          (item) => item.stage === CONVERSATION_ASSESSMENT_STAGE.FULL,
        );
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
      case CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL: {
        validateConversationTerminalEvent(
          record,
          lifecycle,
          configured.policy,
          consensusScore,
          rounds.at(-1)?.decision ?? null,
        );
        terminalRecorded = true;
        break;
      }
      case CONVERSATION_TRACE_EVENT_KIND.COORDINATOR_DECISION:
      case CONVERSATION_TRACE_EVENT_KIND.SKILL_INJECTED:
      case CONVERSATION_TRACE_EVENT_KIND.TOOL_ACTION:
      case CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE:
      case CONVERSATION_TRACE_EVENT_KIND.BASELINE_RESULT:
      case CONVERSATION_TRACE_EVENT_KIND.SYNTHESIS_COMPLETED:
      case CONVERSATION_TRACE_EVENT_KIND.DRY_RUN_RESULT:
      case CONVERSATION_TRACE_EVENT_KIND.ERROR:
      case CONVERSATION_TRACE_EVENT_KIND.OPERATION_LIFECYCLE:
      case CONVERSATION_TRACE_EVENT_KIND.APPROVAL_REQUESTED:
      case CONVERSATION_TRACE_EVENT_KIND.APPROVAL_RESOLVED:
      case CONVERSATION_TRACE_EVENT_KIND.CALLER_CANCELLED:
      case CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED:
      case CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_UPDATED:
      case CONVERSATION_TRACE_EVENT_KIND.NATIVE_HISTORY_RECONCILED:
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
