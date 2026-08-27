import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import type { ArtifactRegistry } from "../trace/artifacts.js";
import type { PublicStoredTraceEvent } from "../trace/types.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import {
  CONVERSATION_INTERACTION_ACTOR_KIND,
  CONVERSATION_INTERACTION_SCHEMA_VERSION,
  type ConversationInteractionActorKind,
} from "./conversation-interaction-contract.js";
import type {
  PublicMessageLocatorV1,
  PublicQuoteProjectionV1,
  PublicQuoteReferenceV1,
} from "./conversation-interaction-types.js";
import { assertPublicMessageLocatorV1 } from "./conversation-interaction-validation.js";
import { assertPublicQuoteReferenceV1 } from "./conversation-interaction-validation.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  type ConversationMessageQueueTargetParticipantsV1,
} from "./conversation-message-queue-contract.js";
import { CONVERSATION_TRACE_EVENT_KIND } from "./conversation-public-wire-contract.js";
import { type ValidatedLineageNodeV1, deriveConversationLineages } from "./lineage-reader.js";
import { projectConversationEvents } from "./policy-registry.js";
import { readConversationSourceInventory } from "./source-inventory.js";
import { publicTurnResponses } from "./turn-delivery-source.js";

type TargetKind = PublicMessageLocatorV1["target_kind"];

export interface ResolvedPublicMessageV1 {
  locator: PublicMessageLocatorV1;
  author_public_id: string;
  preview_text: string;
  created_at: string;
  revision_ordinal: number;
  public_seq: number;
  target_participants: ConversationMessageQueueTargetParticipantsV1;
  quote_refs: PublicQuoteReferenceV1[];
}

export interface PublicMessageActorV1 {
  kind: ConversationInteractionActorKind;
  public_id: string;
  participant_id: string | null;
  source_event_id: string | null;
}

function key(node: {
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
}): string {
  return `${node.conversation_id}\0${node.revision_id}\0${node.revision_ordinal}`;
}

function comparePosition(
  left: Pick<ResolvedPublicMessageV1, "revision_ordinal" | "public_seq">,
  right: Pick<ResolvedPublicMessageV1, "revision_ordinal" | "public_seq">,
): number {
  return left.revision_ordinal - right.revision_ordinal || left.public_seq - right.public_seq;
}

function preview(value: string): string {
  const points = [...value.normalize("NFC")];
  return points.slice(0, 240).join("");
}

function targetDigest(value: unknown): string {
  return digestV1("VF-PUBLIC-MESSAGE-LOCATOR-CONTENT\0v1\0", value);
}

function locator(
  rootSessionId: string,
  revision: ValidatedLineageNodeV1,
  event: PublicStoredTraceEvent,
  kind: TargetKind,
  publicProjection: unknown,
): PublicMessageLocatorV1 {
  return {
    root_session_id: rootSessionId,
    conversation_id: revision.node.conversation_id,
    revision_id: revision.node.revision_id,
    target_event_id: event.event_id,
    target_kind: kind,
    content_digest: targetDigest(publicProjection),
  };
}

function ancestry(
  nodes: readonly ValidatedLineageNodeV1[],
  current: ValidatedLineageNodeV1,
): ValidatedLineageNodeV1[] {
  const byKey = new Map(nodes.map((node) => [key(node.node), node]));
  const selected: ValidatedLineageNodeV1[] = [];
  let cursor: ValidatedLineageNodeV1 | undefined = current;
  while (cursor) {
    selected.push(cursor);
    cursor = cursor.parent ? byKey.get(key(cursor.parent)) : undefined;
  }
  selected.reverse();
  if (selected[0]?.node.conversation_id !== current.root_session_id)
    throw new Error("public message ancestry is incomplete");
  return selected;
}

function targets(value: unknown): ConversationMessageQueueTargetParticipantsV1 {
  if (value === CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL)
    return CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("public message target authority changed");
  return value.map(String);
}

export class ConversationMessageAuthorityV1 {
  constructor(
    private readonly options: {
      artifactRoot: string;
      traceRoot: string;
      artifactRegistry: ArtifactRegistry;
      home: ConversationHomeAuthorities;
    },
  ) {}

  inventory(conversationId: string): {
    root_session_id: string;
    messages: ResolvedPublicMessageV1[];
  } {
    const source = readConversationSourceInventory({
      artifactRoot: this.options.artifactRoot,
      traceRoot: this.options.traceRoot,
      actionAuthority: this.options.home.reviewedActionAuthority(),
    });
    const derived = deriveConversationLineages(source, {
      publishedRevisionTransitions: this.options.home.publishedRevisionTransitions(),
    });
    const lineage = derived.lineages.find((item) =>
      item.nodes.some((node) => node.node.conversation_id === conversationId),
    );
    const current = lineage?.nodes.find((node) => node.node.conversation_id === conversationId);
    if (!source.authoritative || !derived.authoritative || !lineage || !current)
      throw new Error("public message lineage is not authoritative");
    const messages = ancestry(lineage.nodes, current).flatMap((revision) =>
      this.revisionMessages(lineage.root_session_id, revision),
    );
    messages.sort(
      (left, right) =>
        comparePosition(left, right) ||
        Buffer.compare(
          Buffer.from(left.locator.target_event_id),
          Buffer.from(right.locator.target_event_id),
        ),
    );
    return { root_session_id: lineage.root_session_id, messages };
  }

  private revisionMessages(
    rootSessionId: string,
    revision: ValidatedLineageNodeV1,
  ): ResolvedPublicMessageV1[] {
    const events = projectConversationEvents(
      revision.source.journal_records,
      revision.node.conversation_id,
      this.options.artifactRegistry,
      0,
    );
    const responses = new Map(
      publicTurnResponses(events, "", 0, true).map((response) => [response.message_id, response]),
    );
    const output: ResolvedPublicMessageV1[] = [];
    for (const event of events) {
      if (event.event.type === CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE) {
        const targetParticipants = targets(event.event.payload.target_participants);
        const projection = {
          schema_version: CONVERSATION_INTERACTION_SCHEMA_VERSION,
          target_kind: CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.USER_MESSAGE,
          event_id: event.event_id,
          public_seq: event.seq,
          author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
          content: event.event.payload.content,
          target_participants: targetParticipants,
          quote_refs: event.event.payload.quote_refs ?? [],
          created_at: event.ts,
        };
        const quoteRefs = (event.event.payload.quote_refs ?? []).map((quote) => {
          assertPublicQuoteReferenceV1(quote);
          return structuredClone(quote);
        });
        output.push({
          locator: locator(
            rootSessionId,
            revision,
            event,
            CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.USER_MESSAGE,
            projection,
          ),
          author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
          preview_text: preview(event.event.payload.content),
          created_at: event.ts,
          revision_ordinal: revision.node.revision_ordinal,
          public_seq: event.seq,
          target_participants: targetParticipants,
          quote_refs: quoteRefs,
        });
        continue;
      }
      const response = responses.get(event.event_id);
      if (!response) continue;
      const projection = {
        schema_version: CONVERSATION_INTERACTION_SCHEMA_VERSION,
        target_kind: CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.COMPLETED_AGENT_RESPONSE,
        event_id: event.event_id,
        created_at: event.ts,
        response,
      };
      output.push({
        locator: locator(
          rootSessionId,
          revision,
          event,
          CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.COMPLETED_AGENT_RESPONSE,
          projection,
        ),
        author_public_id: response.author_public_id,
        preview_text: preview(response.answer ?? response.claim ?? ""),
        created_at: event.ts,
        revision_ordinal: revision.node.revision_ordinal,
        public_seq: event.seq,
        target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
        quote_refs: [],
      });
    }
    return output;
  }

  resolve(
    conversationId: string,
    candidate: unknown,
    actor: PublicMessageActorV1,
  ): ResolvedPublicMessageV1 {
    assertPublicMessageLocatorV1(candidate);
    const inventory = this.inventory(conversationId);
    const source = actor.source_event_id
      ? inventory.messages.find((item) => item.locator.target_event_id === actor.source_event_id)
      : null;
    if (actor.source_event_id && !source)
      throw new Error("public message reference is unavailable");
    const target = inventory.messages.find(
      (item) => item.locator.target_event_id === candidate.target_event_id,
    );
    if (
      !target ||
      candidate.root_session_id !== inventory.root_session_id ||
      !canonicalJsonBytes(target.locator).equals(canonicalJsonBytes(candidate)) ||
      (source && comparePosition(target, source) >= 0) ||
      (actor.kind === CONVERSATION_INTERACTION_ACTOR_KIND.PARTICIPANT &&
        target.target_participants !== CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL &&
        !target.target_participants.includes(actor.participant_id ?? ""))
    )
      throw new Error("public message reference is unavailable");
    return structuredClone(target);
  }

  quote(
    conversationId: string,
    candidate: unknown,
    actor: PublicMessageActorV1,
  ): PublicQuoteProjectionV1 {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
      throw new Error("public quote reference is unavailable");
    const record = candidate as Record<string, unknown>;
    const { author_public_id: author, ...locatorCandidate } = record;
    if (typeof author !== "string") throw new Error("public quote reference is unavailable");
    const target = this.resolve(conversationId, locatorCandidate, actor);
    if (target.author_public_id !== author)
      throw new Error("public quote reference is unavailable");
    return {
      ...structuredClone(target.locator),
      author_public_id: target.author_public_id,
      preview_text: target.preview_text,
      created_at: target.created_at,
    };
  }
}
