import { digestV1 } from "../../durability/index.js";
import type { PublicStoredTraceEvent } from "../trace/types.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  type ConversationMessageQueueTargetParticipantsV1,
} from "./conversation-message-queue-contract.js";
import { CONVERSATION_TRACE_EVENT_KIND } from "./conversation-public-wire-contract.js";
import type {
  ConversationTurnMessageV1,
  ConversationTurnResponseV1,
} from "./turn-delivery-types.js";

function applies(
  targets: ConversationMessageQueueTargetParticipantsV1,
  participantId: string,
): boolean {
  return (
    targets === CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL ||
    targets.includes(participantId)
  );
}

function messageDigest(value: Omit<ConversationTurnMessageV1, "content_digest">): string {
  return digestV1("VF-PUBLIC-TURN-MESSAGE\0v1\0", value);
}

function responseDigest(value: Omit<ConversationTurnResponseV1, "content_digest">): string {
  return digestV1("VF-PUBLIC-TURN-RESPONSE\0v1\0", value);
}

export function publicTurnMessages(
  events: readonly PublicStoredTraceEvent[],
  participantId: string,
  afterSeq: number,
): ConversationTurnMessageV1[] {
  return events.flatMap((stored) => {
    if (stored.seq <= afterSeq || stored.event.type !== CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE)
      return [];
    const projectedTargets = stored.event.payload.target_participants;
    const targets: ConversationMessageQueueTargetParticipantsV1 = Array.isArray(projectedTargets)
      ? projectedTargets.map(String)
      : String(projectedTargets) === CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL
        ? CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL
        : (() => {
            throw new Error("public turn message targets are invalid");
          })();
    if (!applies(targets, participantId)) return [];
    const preimage = {
      message_id: stored.event_id,
      public_seq: stored.seq,
      author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
      content: stored.event.payload.content,
      target_participants: structuredClone(targets),
    };
    return [{ ...preimage, content_digest: messageDigest(preimage) }];
  });
}

interface PartialResponse {
  first_seq: number;
  answer: string | null;
  content: string;
  evidence_refs: Set<string>;
}

export function publicTurnResponses(
  events: readonly PublicStoredTraceEvent[],
  recipientId: string,
  afterSeq: number,
  includeRecipientResponse: boolean,
): ConversationTurnResponseV1[] {
  const partial = new Map<string, PartialResponse>();
  const output: ConversationTurnResponseV1[] = [];
  for (const stored of events) {
    if (stored.event.type === CONVERSATION_TRACE_EVENT_KIND.PRECOMMIT) {
      const payload = stored.event.payload;
      const key = `${payload.round_id}\0${payload.participant_id}`;
      const current = partial.get(key);
      partial.set(key, {
        first_seq: Math.min(current?.first_seq ?? stored.seq, stored.seq),
        answer: payload.answer,
        content: current?.content ?? "",
        evidence_refs: current?.evidence_refs ?? new Set(),
      });
      continue;
    }
    if (stored.event.type !== CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA) continue;
    const payload = stored.event.payload;
    const key = `${payload.round_id}\0${payload.participant_id}`;
    const current = partial.get(key) ?? {
      first_seq: stored.seq,
      answer: null,
      content: "",
      evidence_refs: new Set<string>(),
    };
    current.content += payload.content_delta;
    for (const reference of stored.evidence_refs ?? []) current.evidence_refs.add(reference);
    partial.set(key, current);
    if (!payload.completes_response) continue;
    partial.delete(key);
    if (stored.seq <= afterSeq) continue;
    if (!includeRecipientResponse && payload.participant_id === recipientId) continue;
    const preimage = {
      message_id: stored.event_id,
      public_seq: stored.seq,
      author_public_id: payload.participant_id,
      role_ref: stored.role_ref ?? "unknown",
      round_id: payload.round_id,
      answer: current.answer ?? current.content,
      claim: payload.final_claim,
      evidence: [...payload.final_evidence],
      artifact_refs: [...current.evidence_refs].sort(),
    };
    output.push({
      ...preimage,
      content_digest: responseDigest(preimage),
    });
  }
  return output;
}
