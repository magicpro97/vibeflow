import {
  CONVERSATION_ASSESSMENT_STAGE,
  CONVERSATION_CONVERGENCE_NOT_APPLICABLE,
  CONVERSATION_TRACE_EVENT_KIND,
} from "../../orchestrator/conversation/conversation-public-wire-contract.js";
import { homeConversationLifecycleLabel } from "./conversation-lifecycle-presentation.js";
import { collectTraceSessions } from "./conversation-session-projection.js";
import type { ConversationSnapshot, ConversationTraceRecord } from "./conversation-types.js";

type MessageKind =
  | "boundary"
  | "user"
  | "participant"
  | "assessment"
  | "decision"
  | "status"
  | "error"
  | "precommit";

const scoreGate = (
  gates: Array<{ value: boolean | typeof CONVERSATION_CONVERGENCE_NOT_APPLICABLE }>,
) => {
  let passed = 0;
  let applicable = 0;
  for (const gate of gates) {
    if (gate.value === CONVERSATION_CONVERGENCE_NOT_APPLICABLE) continue;
    applicable += 1;
    if (gate.value) passed += 1;
  }
  return applicable === 0 ? "0/0" : `${passed}/${applicable}`;
};

const participantLookup = (snapshot: ConversationSnapshot | null) =>
  new Map(
    (snapshot?.participants ?? []).map((participant) => [participant.participant_id, participant]),
  );

const collectMessageMeta =
  (
    participants: ReturnType<typeof participantLookup>,
    sessions: ReturnType<typeof collectTraceSessions>,
  ) =>
  (participantId: string | null, fallback: string | null = null) => {
    const participant = participantId ? (participants.get(participantId) ?? null) : null;
    const session = participant?.public_session_ref
      ? (sessions.get(participant.public_session_ref) ?? null)
      : null;
    return {
      role_ref: participant?.role_ref ?? fallback,
      engine: participant?.engine ?? null,
      model: participant?.model ?? null,
      public_session_ref: participant?.public_session_ref ?? null,
      session_status: session?.status ?? null,
    };
  };

const makeMessage = (
  record: ConversationTraceRecord,
  meta: ReturnType<ReturnType<typeof collectMessageMeta>>,
  seed: {
    key: string;
    kind: MessageKind;
    title: string;
    body: string;
    round_id?: string | null;
    participant_id?: string | null;
    claim?: string | null;
    evidence?: string[];
    complete?: boolean;
    trace_seqs?: number[];
  },
) => ({
  key: seed.key,
  kind: seed.kind,
  seq: record.seq,
  ts: record.ts,
  round_id: seed.round_id ?? null,
  participant_id: seed.participant_id ?? null,
  title: seed.title,
  body: seed.body,
  claim: seed.claim ?? null,
  evidence: seed.evidence ?? [],
  complete: seed.complete ?? true,
  trace_seqs: seed.trace_seqs ?? [record.seq],
  ...meta,
});

export function buildConversationMessages(
  snapshot: ConversationSnapshot | null,
  records: readonly ConversationTraceRecord[],
) {
  const participants = participantLookup(snapshot);
  const sessions = collectTraceSessions(records);
  const meta = collectMessageMeta(participants, sessions);
  const messages: Array<ReturnType<typeof makeMessage>> = [];
  const threaded = new Map<string, ReturnType<typeof makeMessage>>();

  for (const record of records) {
    const event = record.event;
    switch (event.type) {
      case CONVERSATION_TRACE_EVENT_KIND.ROUND_BOUNDARY:
        messages.push(
          makeMessage(record, meta(null), {
            key: `boundary-${record.seq}`,
            kind: "boundary",
            title: `Round ${event.payload.phase}`,
            body: event.payload.round_id,
            round_id: event.payload.round_id,
          }),
        );
        break;
      case CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE:
        messages.push(
          makeMessage(record, meta(null), {
            key: `user-${record.seq}`,
            kind: "user",
            title: "User message",
            body: event.payload.content,
          }),
        );
        break;
      case CONVERSATION_TRACE_EVENT_KIND.PRECOMMIT:
        messages.push(
          makeMessage(record, meta(event.payload.participant_id), {
            key: `precommit-${record.seq}`,
            kind: "precommit",
            title: "Draft claim",
            body: event.payload.answer,
            round_id: event.payload.round_id,
            participant_id: event.payload.participant_id,
            claim: event.payload.answer,
            evidence: [...event.payload.evidence],
          }),
        );
        break;
      case CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA: {
        const key = `${event.payload.round_id}:${event.payload.participant_id}`;
        const current = threaded.get(key);
        if (!current) {
          const created = makeMessage(
            record,
            meta(event.payload.participant_id, record.role_ref ?? null),
            {
              key,
              kind: "participant",
              title: "Participant response",
              body: event.payload.content_delta,
              round_id: event.payload.round_id,
              participant_id: event.payload.participant_id,
              claim: event.payload.final_claim,
              evidence: event.payload.completes_response ? [...event.payload.final_evidence] : [],
              complete: event.payload.completes_response,
            },
          );
          threaded.set(key, created);
          messages.push(created);
          break;
        }
        current.seq = record.seq;
        current.ts = record.ts;
        current.body += event.payload.content_delta;
        current.claim = event.payload.final_claim ?? current.claim;
        current.evidence = event.payload.completes_response
          ? [...event.payload.final_evidence]
          : current.evidence;
        current.complete = current.complete || event.payload.completes_response;
        current.trace_seqs.push(record.seq);
        break;
      }
      case CONVERSATION_TRACE_EVENT_KIND.EVALUATOR_ASSESSMENT:
        messages.push(
          makeMessage(record, meta(record.participant_id ?? null, record.role_ref ?? null), {
            key: `assessment-${record.seq}`,
            kind: "assessment",
            title: `${
              event.payload.stage === CONVERSATION_ASSESSMENT_STAGE.BLIND ? "Blind" : "Full"
            } assessment`,
            body: [
              `agreement ${scoreGate([event.payload.assessment.agreement])}`,
              `conflict ${scoreGate([event.payload.assessment.conflict_resolution])}`,
              `evidence ${scoreGate([
                event.payload.assessment.evidence_quality,
                event.payload.assessment.convergence,
              ])}`,
            ].join(" · "),
            round_id: event.payload.round_id,
            participant_id: record.participant_id ?? null,
          }),
        );
        break;
      case CONVERSATION_TRACE_EVENT_KIND.CONSENSUS_UPDATE:
        messages.push(
          makeMessage(record, meta(null), {
            key: `decision-${record.seq}`,
            kind: "decision",
            title: "Consensus update",
            body:
              event.payload.decision.score === null
                ? event.payload.decision.outcome
                : `${event.payload.decision.outcome} · score ${event.payload.decision.score.toFixed(
                    2,
                  )}`,
            round_id: event.payload.round_id,
          }),
        );
        break;
      case CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE:
      case CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL:
        messages.push(
          makeMessage(record, meta(null), {
            key: `state-${record.seq}`,
            kind: "status",
            title: "Lifecycle",
            body:
              event.type === CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE
                ? `${homeConversationLifecycleLabel(event.payload.lifecycle)} · ${event.payload.health}`
                : homeConversationLifecycleLabel(event.payload.lifecycle),
          }),
        );
        break;
      case CONVERSATION_TRACE_EVENT_KIND.ERROR:
        messages.push(
          makeMessage(record, meta(null), {
            key: `error-${record.seq}`,
            kind: "error",
            title: event.payload.code,
            body: event.payload.message,
          }),
        );
        break;
    }
  }

  return messages;
}
