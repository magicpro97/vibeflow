import { canonicalJsonBytes, digestHex, digestV1, sha256Digest } from "../../durability/index.js";
import type {
  ConversationInteractionFoldV1,
  PublicQuoteReferenceV1,
} from "./conversation-interaction-types.js";
import { assertPublicQuoteReferenceV1 } from "./conversation-interaction-validation.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
} from "./conversation-message-queue-contract.js";
import {
  CONVERSATION_PUBLIC_ARTIFACT_DELIVERY,
  CONVERSATION_PUBLIC_ARTIFACT_KIND,
  CONVERSATION_PUBLIC_ARTIFACT_RESOLVER,
  CONVERSATION_TRACE_EVENT_KIND,
  conversationPublicResponseTerminalStatus,
} from "./conversation-public-wire-contract.js";
import type { PromptArtifactSelectionV1 } from "./handoff-types.js";
import type { PublicHandoffMessageV1, PublicHandoffResponseV1 } from "./handoff-types.js";
import type { ConversationLineageReadV1, ValidatedLineageNodeV1 } from "./lineage-reader.js";
import { type LineageNodeIdentityV1, assertLineageNodeIdentityV1 } from "./lineage-types.js";
import { ConversationRevisionCorruptError } from "./revision-errors.js";
import {
  REVISION_INTERACTION_CURSOR_MEDIA_TYPE,
  REVISION_QUOTE_GRAPH_MEDIA_TYPE,
  REVISION_QUOTE_GRAPH_PROFILE,
} from "./revision-handoff-contract.js";
import { selectedRevisionReactionProjection } from "./revision-handoff-reaction-projection.js";
import type {
  RevisionPublicTranscriptV1,
  RevisionQuoteSourceV1,
} from "./revision-handoff-transcript-types.js";

export type {
  RevisionPublicTranscriptV1,
  RevisionQuoteSourceV1,
} from "./revision-handoff-transcript-types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const nodeKey = (node: LineageNodeIdentityV1): string =>
  `${node.conversation_id}\0${node.revision_id}\0${node.revision_ordinal}`;

function ancestry(lineage: ConversationLineageReadV1, parent: ValidatedLineageNodeV1) {
  const byNode = new Map(lineage.nodes.map((node) => [nodeKey(node.node), node]));
  const output: ValidatedLineageNodeV1[] = [];
  let current: ValidatedLineageNodeV1 | undefined = parent;
  while (current) {
    output.push(current);
    current = current.parent ? byNode.get(nodeKey(current.parent)) : undefined;
  }
  output.reverse();
  if (output[0]?.node.conversation_id !== lineage.root_session_id)
    throw new ConversationRevisionCorruptError("conversation ancestry is incomplete");
  return output;
}
function redactionDigest(kind: string, value: unknown): string {
  return digestV1("VF-PUBLIC-HANDOFF-REDACTION\0v1\0", {
    schema_version: "1.0",
    kind,
    value,
  });
}
export function revisionPublicTranscript(
  lineage: ConversationLineageReadV1,
  parent: ValidatedLineageNodeV1,
): RevisionPublicTranscriptV1 {
  const messages: PublicHandoffMessageV1[] = [];
  const responses: PublicHandoffResponseV1[] = [];
  const quote_sources: RevisionQuoteSourceV1[] = [];
  const selectedAncestry = ancestry(lineage, parent);
  for (const revision of selectedAncestry) {
    const partial = new Map<string, string>();
    for (const { stored_event: stored } of revision.source.journal_records) {
      if (stored.event.type === CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE) {
        const quoteRefs = (stored.event.payload.quote_refs ?? []).map((quote) => {
          try {
            assertPublicQuoteReferenceV1(quote);
          } catch (error) {
            throw new ConversationRevisionCorruptError("user quote reference is invalid", {
              cause: error,
            });
          }
          return structuredClone(quote);
        });
        messages.push({
          event_id: stored.event_id,
          conversation_id: revision.node.conversation_id,
          revision_id: revision.node.revision_id,
          revision_ordinal: revision.node.revision_ordinal,
          public_seq: stored.seq,
          author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
          text: stored.event.payload.content,
          created_at: stored.ts,
          redaction_manifest_digest: redactionDigest(
            CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.USER_MESSAGE,
            stored.event.payload,
          ),
        });
        if (quoteRefs.length)
          quote_sources.push({
            quoting_message_id: stored.event_id,
            revision_ordinal: revision.node.revision_ordinal,
            public_seq: stored.seq,
            quote_refs: quoteRefs,
          });
      }
      if (stored.event.type !== CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA) continue;
      const payload = stored.event.payload;
      const responseKey = `${payload.round_id}\0${payload.participant_id}`;
      const content = `${partial.get(responseKey) ?? ""}${payload.content_delta}`;
      partial.set(responseKey, content);
      if (!payload.completes_response) continue;
      partial.delete(responseKey);
      const role = revision.source.manifest.bindings.find(
        (binding) => binding.participant_id === payload.participant_id,
      )?.input.roleRef;
      if (!role) throw new ConversationRevisionCorruptError("response binding is absent");
      responses.push({
        event_id: stored.event_id,
        conversation_id: revision.node.conversation_id,
        revision_id: revision.node.revision_id,
        revision_ordinal: revision.node.revision_ordinal,
        public_seq: stored.seq,
        participant_id: payload.participant_id,
        role_ref: role,
        text: content,
        terminal_status: conversationPublicResponseTerminalStatus(
          revision.source.journal_head.lifecycle,
        ),
        created_at: stored.ts,
        redaction_manifest_digest: redactionDigest("participant-response", {
          participant_id: payload.participant_id,
          content,
        }),
      });
    }
  }
  return {
    selected_ancestry: selectedAncestry.map(({ node }) => structuredClone(node)),
    messages,
    responses,
    quote_sources,
  };
}

interface RevisionQuoteOccurrenceV1 {
  quoting_message_id: string;
  quote_order: number;
  target: PublicQuoteReferenceV1;
}

function compareQuotePosition(
  left: { revision_ordinal: number; public_seq: number },
  right: { revision_ordinal: number; public_seq: number },
): number {
  return left.revision_ordinal - right.revision_ordinal || left.public_seq - right.public_seq;
}

function buildInteractionCursorArtifact(
  fold: ConversationInteractionFoldV1,
): PromptArtifactSelectionV1 {
  const publicText = `${fold.head_sequence}:${digestHex(fold.head_digest)}`;
  const bytes = Buffer.from(publicText, "utf8");
  const contentSha = digestHex(sha256Digest(bytes));
  return {
    artifact: {
      artifact_id: `vf-ic-${contentSha}`,
      artifact_kind: CONVERSATION_PUBLIC_ARTIFACT_KIND.CONVERSATION,
      media_type: REVISION_INTERACTION_CURSOR_MEDIA_TYPE,
      byte_length: bytes.byteLength,
      content_sha256: contentSha,
      resolver: CONVERSATION_PUBLIC_ARTIFACT_RESOLVER.CONVERSATION,
    },
    delivery: CONVERSATION_PUBLIC_ARTIFACT_DELIVERY.INLINE_PUBLIC_TEXT,
    public_text: publicText,
  };
}

export function buildRevisionQuoteGraphArtifact(input: {
  root_session_id: string;
  transcript: RevisionPublicTranscriptV1;
  interaction_fold: ConversationInteractionFoldV1 | null;
}): PromptArtifactSelectionV1 | null {
  if (input.interaction_fold !== null) {
    if (
      input.interaction_fold.root_session_id !== input.root_session_id ||
      !Number.isSafeInteger(input.interaction_fold.head_sequence) ||
      input.interaction_fold.head_sequence < 0 ||
      !DIGEST.test(input.interaction_fold.head_digest) ||
      input.interaction_fold.head_digests_by_sequence[
        String(input.interaction_fold.head_sequence)
      ] !== input.interaction_fold.head_digest
    )
      throw new ConversationRevisionCorruptError("interaction quote head changed");
  }
  const selectedByRevision = new Map<string, LineageNodeIdentityV1>();
  for (const [index, node] of input.transcript.selected_ancestry.entries()) {
    try {
      assertLineageNodeIdentityV1(node);
    } catch (error) {
      throw new ConversationRevisionCorruptError("quote graph ancestry is invalid", {
        cause: error,
      });
    }
    const revisionKey = `${node.conversation_id}\0${node.revision_id}`;
    const prior = input.transcript.selected_ancestry[index - 1];
    if (
      selectedByRevision.has(revisionKey) ||
      (index === 0 && node.conversation_id !== input.root_session_id) ||
      (prior && node.revision_ordinal <= prior.revision_ordinal)
    )
      throw new ConversationRevisionCorruptError("quote graph ancestry changed");
    selectedByRevision.set(revisionKey, structuredClone(node));
  }
  if (selectedByRevision.size === 0)
    throw new ConversationRevisionCorruptError("quote graph ancestry is absent");
  const events = [
    ...input.transcript.messages.map((event) => ({
      event_id: event.event_id,
      conversation_id: event.conversation_id,
      revision_id: event.revision_id,
      revision_ordinal: event.revision_ordinal,
      public_seq: event.public_seq,
      target_kind: CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.USER_MESSAGE,
      author_public_id: event.author_public_id,
    })),
    ...input.transcript.responses.map((event) => ({
      event_id: event.event_id,
      conversation_id: event.conversation_id,
      revision_id: event.revision_id,
      revision_ordinal: event.revision_ordinal,
      public_seq: event.public_seq,
      target_kind: CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.COMPLETED_AGENT_RESPONSE,
      author_public_id: event.participant_id,
    })),
  ];
  for (const event of events) {
    const selected = selectedByRevision.get(`${event.conversation_id}\0${event.revision_id}`);
    if (!selected || selected.revision_ordinal !== event.revision_ordinal)
      throw new ConversationRevisionCorruptError(
        "quote graph event is outside the selected ancestry",
      );
  }
  const byEventId = new Map(events.map((event) => [event.event_id, event]));
  if (byEventId.size !== events.length)
    throw new ConversationRevisionCorruptError("quote graph event identity is ambiguous");
  const reactionProjections = selectedRevisionReactionProjection({
    root_session_id: input.root_session_id,
    interaction_fold: input.interaction_fold,
    selected_by_revision: selectedByRevision,
    events_by_id: byEventId,
  });
  const sources = [
    ...input.transcript.quote_sources.map((source) => ({
      ...structuredClone(source),
      author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
      source_locator: null,
    })),
    ...(input.interaction_fold?.participant_intents.flatMap((intent) => {
      if (intent.diagnostic_code !== null || !intent.quote_refs.length) return [];
      const quoting = byEventId.get(intent.response.target_event_id);
      const selected = selectedByRevision.get(
        `${intent.response.conversation_id}\0${intent.response.revision_id}`,
      );
      if (!quoting && !selected) return [];
      return [
        {
          quoting_message_id: intent.response.target_event_id,
          revision_ordinal: quoting?.revision_ordinal ?? selected?.revision_ordinal ?? -1,
          public_seq: quoting?.public_seq ?? -1,
          quote_refs: structuredClone(intent.quote_refs),
          author_public_id: intent.actor_participant_id,
          source_locator: structuredClone(intent.response),
        },
      ];
    }) ?? []),
  ];
  const occurrences: Array<
    RevisionQuoteOccurrenceV1 & { revision_ordinal: number; public_seq: number }
  > = [];
  const quotingMessageIds = new Set<string>();
  for (const source of sources) {
    const quoting = byEventId.get(source.quoting_message_id);
    if (
      !quoting ||
      source.quote_refs.length < 1 ||
      source.quote_refs.length > 8 ||
      quotingMessageIds.has(source.quoting_message_id) ||
      quoting.revision_ordinal !== source.revision_ordinal ||
      quoting.public_seq !== source.public_seq ||
      quoting.author_public_id !== source.author_public_id ||
      (source.source_locator === null &&
        quoting.target_kind !== CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.USER_MESSAGE) ||
      (source.source_locator !== null &&
        (source.source_locator.root_session_id !== input.root_session_id ||
          source.source_locator.conversation_id !== quoting.conversation_id ||
          source.source_locator.revision_id !== quoting.revision_id ||
          source.source_locator.target_event_id !== quoting.event_id ||
          source.source_locator.target_kind !==
            CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.COMPLETED_AGENT_RESPONSE))
    )
      throw new ConversationRevisionCorruptError("quote occurrence source changed");
    quotingMessageIds.add(source.quoting_message_id);
    const quoteTargets = new Set<string>();
    source.quote_refs.forEach((reference, index) => {
      try {
        assertPublicQuoteReferenceV1(reference);
      } catch (error) {
        throw new ConversationRevisionCorruptError("quote occurrence target is invalid", {
          cause: error,
        });
      }
      const target = byEventId.get(reference.target_event_id);
      const targetKey = `${reference.target_event_id}\0${reference.content_digest}`;
      if (
        !target ||
        quoteTargets.has(targetKey) ||
        reference.root_session_id !== input.root_session_id ||
        reference.conversation_id !== target.conversation_id ||
        reference.revision_id !== target.revision_id ||
        reference.target_kind !== target.target_kind ||
        reference.author_public_id !== target.author_public_id ||
        compareQuotePosition(target, quoting) >= 0
      )
        throw new ConversationRevisionCorruptError("quote occurrence target changed");
      quoteTargets.add(targetKey);
      occurrences.push({
        quoting_message_id: source.quoting_message_id,
        quote_order: index + 1,
        target: structuredClone(reference),
        revision_ordinal: source.revision_ordinal,
        public_seq: source.public_seq,
      });
    });
  }
  if (!occurrences.length && !reactionProjections.length)
    return input.interaction_fold ? buildInteractionCursorArtifact(input.interaction_fold) : null;
  occurrences.sort(
    (left, right) =>
      compareQuotePosition(left, right) ||
      Buffer.compare(Buffer.from(left.quoting_message_id), Buffer.from(right.quoting_message_id)) ||
      left.quote_order - right.quote_order,
  );
  const graph = {
    schema_version: "1.0" as const,
    profile: REVISION_QUOTE_GRAPH_PROFILE,
    root_session_id: input.root_session_id,
    interaction_head_sequence: input.interaction_fold?.head_sequence ?? null,
    interaction_head_digest: input.interaction_fold?.head_digest ?? null,
    reaction_projections: reactionProjections,
    occurrences: occurrences.map(
      ({ revision_ordinal: _revisionOrdinal, public_seq: _publicSeq, ...occurrence }) => occurrence,
    ),
  };
  const bytes = canonicalJsonBytes(graph);
  const contentSha = digestHex(sha256Digest(bytes));
  return {
    artifact: {
      artifact_id: `vf-public-quote-graph-${contentSha}`,
      artifact_kind: CONVERSATION_PUBLIC_ARTIFACT_KIND.CONVERSATION,
      media_type: REVISION_QUOTE_GRAPH_MEDIA_TYPE,
      byte_length: bytes.byteLength,
      content_sha256: contentSha,
      resolver: CONVERSATION_PUBLIC_ARTIFACT_RESOLVER.CONVERSATION,
    },
    delivery: CONVERSATION_PUBLIC_ARTIFACT_DELIVERY.INLINE_PUBLIC_TEXT,
    public_text: bytes.toString("utf8"),
  };
}
