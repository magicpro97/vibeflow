import { CONVERSATION_TRACE_EVENT_KIND } from "../../orchestrator/conversation/conversation-public-wire-contract.js";
import { homeReactionLabel } from "./conversation-home-authoring.js";
import { homeParticipantDisplayLabel } from "./conversation-home-participant-label.js";
export type { RenderedHomeTraceEntry } from "./conversation-home-trace-projection.js";
export { projectHomeTrace } from "./conversation-home-trace-projection.js";
import type {
  HomeActionOperation,
  HomeCanonicalMessageReference,
  HomeParticipant,
  HomeQuoteProjection,
  HomeReactionSummary,
  HomeTimelineItem,
} from "./conversation-home-types.js";

export interface RenderedHomeTimelineItem {
  id: string;
  kind: "user" | "assistant" | "system" | "boundary" | "error";
  title: string;
  body: string;
  at: string | null;
  anchorKey: string | null;
  sourceKey: string | null;
  sourceEventIds: string[];
  conversationId: string | null;
  revisionId: string | null;
  publicSessionRef: string | null;
  publicAuthorId: string | null;
  messageRef: HomeCanonicalMessageReference | null;
  revisionOrdinal: number;
  complete: boolean;
  evidence: string[];
  quoteRefs: Array<{
    quotingMessageId: string;
    quoteOrder: number;
    target: HomeQuoteProjection;
  }>;
  reactions: HomeReactionSummary[];
  diagnosticCode: string | null;
  operations: HomeActionOperation[];
}

const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function reactionSummaries(value: unknown): HomeReactionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const emoji = text(row.emoji);
    if (!emoji) return [];
    const count = typeof row.count === "number" ? row.count : 0;
    const actors = stringList(row.actor_public_ids ?? row.actors);
    return [
      {
        emoji: emoji as HomeReactionSummary["emoji"],
        label: text(row.label, homeReactionLabel(emoji as HomeReactionSummary["emoji"])),
        count,
        reacted_by_recipient: row.reacted_by_recipient === true || row.reacted_by_viewer === true,
        actor_public_ids: actors,
      },
    ];
  });
}

function systemItem(
  id: string,
  title: string,
  body: string,
  revisionOrdinal: number,
  at: string | null,
  operations: HomeActionOperation[] = [],
): RenderedHomeTimelineItem {
  return {
    id,
    kind: "system",
    title,
    body,
    at,
    anchorKey: null,
    sourceKey: null,
    sourceEventIds: [],
    conversationId: null,
    revisionId: null,
    publicSessionRef: null,
    publicAuthorId: null,
    messageRef: null,
    revisionOrdinal,
    complete: true,
    evidence: [],
    quoteRefs: [],
    reactions: [],
    diagnosticCode: null,
    operations,
  };
}

export function projectHomeTimeline(
  source: readonly HomeTimelineItem[],
  participants: readonly HomeParticipant[] = [],
): RenderedHomeTimelineItem[] {
  const output: RenderedHomeTimelineItem[] = [];
  const streamed = new Map<string, RenderedHomeTimelineItem>();
  const participantById = new Map(
    participants.map((participant) => [participant.participant_id, participant] as const),
  );
  const participantTitle = (
    participantId: string,
    fallback: { readonly role_ref?: unknown; readonly engine?: unknown },
  ) => {
    const participant = participantById.get(participantId);
    return homeParticipantDisplayLabel({
      participantId,
      roleRef: participant?.role_ref ?? fallback.role_ref,
      engine: participant?.engine ?? fallback.engine,
    });
  };

  for (const item of source) {
    if (item.kind === "revision-boundary") {
      output.push({
        id: item.boundary_id,
        kind: "boundary",
        title: `Revision ${item.to.revision_ordinal + 1}`,
        body: "Context carried forward through a verified handoff.",
        at: null,
        anchorKey: null,
        sourceKey: null,
        sourceEventIds: [],
        conversationId: null,
        revisionId: null,
        publicSessionRef: null,
        publicAuthorId: null,
        messageRef: null,
        revisionOrdinal: item.to.revision_ordinal,
        complete: true,
        evidence: [],
        quoteRefs: [],
        reactions: [],
        diagnosticCode: null,
        operations: [],
      });
      continue;
    }
    if (item.kind === "conversation-start") {
      output.push(
        systemItem(
          item.anchor_id,
          item.revision_ordinal === 0 ? "Conversation started" : "Revision started",
          item.revision_ordinal === 0
            ? "VibeFlow connected the selected AI participants."
            : "The next revision is using the approved context handoff.",
          item.revision_ordinal,
          null,
          item.action_operations.items,
        ),
      );
      continue;
    }

    const { event } = item;
    const payload = event.event.payload as Record<string, unknown>;
    const interaction = item.interaction;
    const messageRef = interaction.message_locator
      ? structuredClone(interaction.message_locator)
      : null;
    const quoteRefs = interaction.quote_refs.map((quote) => ({
      quotingMessageId: quote.quoting_message_id,
      quoteOrder: quote.quote_order,
      target: structuredClone(quote.target),
    }));
    const reactions = reactionSummaries(interaction.reactions);
    const operations = item.action_operations.items;
    switch (event.event.type) {
      case CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA: {
        const participantId = text(payload.participant_id, event.participant_id ?? "AI");
        const title = participantTitle(participantId, event);
        const roundId = text(payload.round_id, "round");
        const key = `${item.revision_ordinal}:${roundId}:${participantId}`;
        const existing = streamed.get(key);
        if (existing) {
          existing.body += text(payload.content_delta);
          existing.complete ||= payload.completes_response === true;
          if (Array.isArray(payload.final_evidence))
            existing.evidence = payload.final_evidence.filter(
              (value): value is string => typeof value === "string",
            );
          if (messageRef) {
            existing.messageRef = messageRef;
            existing.anchorKey = messageRef.target_event_id;
          }
          existing.sourceEventIds = [...new Set([...existing.sourceEventIds, event.event_id])];
          existing.quoteRefs = quoteRefs;
          existing.reactions = reactions;
          existing.diagnosticCode = interaction.diagnostic_code;
          existing.operations.push(...operations);
          continue;
        }
        const rendered: RenderedHomeTimelineItem = {
          id: key,
          kind: "assistant",
          title,
          body: text(payload.content_delta),
          at: event.ts,
          anchorKey: messageRef?.target_event_id ?? null,
          sourceKey: key,
          sourceEventIds: [event.event_id],
          conversationId: event.conversation_id,
          revisionId: event.revision_id,
          publicSessionRef: event.public_session_ref,
          publicAuthorId: participantId,
          messageRef,
          revisionOrdinal: item.revision_ordinal,
          complete: payload.completes_response === true,
          evidence: Array.isArray(payload.final_evidence)
            ? payload.final_evidence.filter((value): value is string => typeof value === "string")
            : [],
          quoteRefs,
          reactions,
          diagnosticCode: interaction.diagnostic_code,
          operations: [...operations],
        };
        streamed.set(key, rendered);
        output.push(rendered);
        break;
      }
      case CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE:
        output.push({
          id: event.event_id,
          kind: "user",
          title: "You",
          body: text(payload.content),
          at: event.ts,
          anchorKey: messageRef?.target_event_id ?? event.event_id,
          sourceKey: event.event_id,
          sourceEventIds: [event.event_id],
          conversationId: event.conversation_id,
          revisionId: event.revision_id,
          publicSessionRef: event.public_session_ref,
          publicAuthorId: "human",
          messageRef,
          revisionOrdinal: item.revision_ordinal,
          complete: true,
          evidence: [],
          quoteRefs,
          reactions,
          diagnosticCode: interaction.diagnostic_code,
          operations,
        });
        break;
      case CONVERSATION_TRACE_EVENT_KIND.PRECOMMIT: {
        const participantId = text(payload.participant_id, event.participant_id ?? "AI");
        output.push({
          id: event.event_id,
          kind: "assistant",
          title: participantTitle(participantId, event),
          body: text(payload.answer),
          at: event.ts,
          anchorKey: messageRef?.target_event_id ?? null,
          sourceKey: event.event_id,
          sourceEventIds: [event.event_id],
          conversationId: event.conversation_id,
          revisionId: event.revision_id,
          publicSessionRef: event.public_session_ref,
          publicAuthorId: participantId,
          messageRef,
          revisionOrdinal: item.revision_ordinal,
          complete: false,
          evidence: Array.isArray(payload.evidence)
            ? payload.evidence.filter((value): value is string => typeof value === "string")
            : [],
          quoteRefs,
          reactions,
          diagnosticCode: interaction.diagnostic_code,
          operations,
        });
        break;
      }
      case CONVERSATION_TRACE_EVENT_KIND.ERROR:
        output.push({
          ...systemItem(
            event.event_id,
            text(payload.code, "Conversation error"),
            text(payload.message, "The conversation reported an error."),
            item.revision_ordinal,
            event.ts,
            operations,
          ),
          kind: "error",
        });
        break;
      case CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE:
        output.push(
          systemItem(
            event.event_id,
            text(payload.lifecycle, "State changed"),
            payload.reason
              ? text(payload.reason)
              : `Conversation is ${text(payload.health, "updated")}.`,
            item.revision_ordinal,
            event.ts,
            operations,
          ),
        );
        break;
      case CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL:
        output.push(
          systemItem(
            event.event_id,
            text(payload.lifecycle, "Conversation complete"),
            typeof payload.final_score === "number"
              ? `Final confidence ${Math.round(payload.final_score * 100)}%.`
              : "The conversation reached a terminal state.",
            item.revision_ordinal,
            event.ts,
            operations,
          ),
        );
        break;
      case CONVERSATION_TRACE_EVENT_KIND.TOOL_ACTION:
        output.push(
          systemItem(
            event.event_id,
            `${text(payload.tool, "Tool")} · ${text(payload.status, "updated")}`,
            text(payload.action, "Tool activity"),
            item.revision_ordinal,
            event.ts,
            operations,
          ),
        );
        break;
      case CONVERSATION_TRACE_EVENT_KIND.CONSENSUS_UPDATE: {
        const decision = payload.decision as { outcome?: unknown; score?: unknown } | undefined;
        output.push(
          systemItem(
            event.event_id,
            "Consensus update",
            typeof decision?.score === "number"
              ? `${text(decision.outcome, "updated")} · ${Math.round(decision.score * 100)}%`
              : text(decision?.outcome, "The agents updated their decision."),
            item.revision_ordinal,
            event.ts,
            operations,
          ),
        );
        break;
      }
      case CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED:
      case CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_UPDATED:
        output.push(
          systemItem(
            event.event_id,
            event.event.type === CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED
              ? "Artifact ready"
              : "Artifact updated",
            text(payload.artifact_type, "Conversation artifact"),
            item.revision_ordinal,
            event.ts,
            operations,
          ),
        );
        break;
      default:
        if (operations.length)
          output.push(
            systemItem(
              event.event_id,
              "Action update",
              "A durable conversation action is attached to this point in the timeline.",
              item.revision_ordinal,
              event.ts,
              operations,
            ),
          );
    }
  }
  return output;
}
