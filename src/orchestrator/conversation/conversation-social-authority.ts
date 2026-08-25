import {
  ConversationInteractionCorruptError,
  type ConversationInteractionStore,
} from "./conversation-interaction-store.js";
import type {
  AgentReactionRequestV1,
  AgentSocialIntentRequestV1,
  ConversationInteractionProjectionV1,
  ConversationReactionOperationV1,
  PublicMessageLocatorV1,
  PublicQuoteReferenceV1,
  ReactionEmojiV1,
} from "./conversation-interaction-types.js";
import {
  assertPublicMessageLocatorV1,
  assertPublicQuoteReferenceV1,
  isReactionEmojiV1,
} from "./conversation-interaction-validation.js";
import type {
  ConversationMessageAuthorityV1,
  PublicMessageActorV1,
} from "./conversation-message-authority.js";
import {
  conversationReactionChanges,
  publicReactionProjection,
} from "./conversation-reaction-projection.js";

const MAX_AGENT_REACTION_REQUESTS = 16;

export class ConversationMessageReferenceUnavailableError extends Error {
  constructor() {
    super("public message reference is unavailable");
    this.name = "ConversationMessageReferenceUnavailableError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function locatorKey(value: PublicMessageLocatorV1): string {
  return `${value.target_event_id}\0${value.content_digest}`;
}

function parseQuoteRefs(value: unknown): PublicQuoteReferenceV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8)
    throw new Error("invalid quote reference count");
  const output = value.map((item) => {
    assertPublicQuoteReferenceV1(item);
    return structuredClone(item);
  });
  if (new Set(output.map(locatorKey)).size !== output.length)
    throw new Error("duplicate quote reference");
  return output;
}

function parseReactions(value: unknown): AgentReactionRequestV1[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_REACTION_REQUESTS)
    throw new Error("invalid reaction request count");
  return value.map((item) => {
    if (
      !record(item) ||
      !exact(item, ["operation", "target", "emoji"]) ||
      (item.operation !== "add" && item.operation !== "remove") ||
      !isReactionEmojiV1(item.emoji)
    )
      throw new Error("invalid reaction request");
    assertPublicMessageLocatorV1(item.target);
    return {
      operation: item.operation,
      target: structuredClone(item.target),
      emoji: item.emoji,
    };
  });
}

export class ConversationSocialAuthorityV1 {
  constructor(
    private readonly store: ConversationInteractionStore,
    private readonly messages: ConversationMessageAuthorityV1,
    private readonly now: () => string,
  ) {}

  humanQuotes(
    conversationId: string,
    candidates: readonly PublicQuoteReferenceV1[],
  ): PublicQuoteReferenceV1[] {
    try {
      const refs = parseQuoteRefs(candidates);
      for (const quote of refs)
        this.messages.quote(conversationId, quote, {
          kind: "human",
          public_id: "human",
          participant_id: null,
          source_event_id: null,
        });
      return refs;
    } catch (error) {
      if (error instanceof ConversationInteractionCorruptError) throw error;
      throw new ConversationMessageReferenceUnavailableError();
    }
  }

  participantIntent(input: {
    conversation_id: string;
    response_event_id: string;
    actor_participant_id: string;
    request: AgentSocialIntentRequestV1;
  }): { accepted: boolean; diagnostic_code: string | null } {
    const actor: PublicMessageActorV1 = {
      kind: "participant",
      public_id: input.actor_participant_id,
      participant_id: input.actor_participant_id,
      source_event_id: input.response_event_id,
    };
    let response: ReturnType<ConversationMessageAuthorityV1["resolve"]>;
    try {
      const inventory = this.messages.inventory(input.conversation_id);
      const candidate = inventory.messages.find(
        (item) => item.locator.target_event_id === input.response_event_id,
      );
      if (!candidate) throw new Error("participant response is unavailable");
      response = this.messages.resolve(input.conversation_id, candidate.locator, {
        ...actor,
        source_event_id: null,
      });
      if (
        response.locator.target_kind !== "completed-agent-response" ||
        response.author_public_id !== input.actor_participant_id
      )
        throw new Error("participant response authority changed");
    } catch {
      return { accepted: false, diagnostic_code: "social_intent_response_unavailable" };
    }
    try {
      const quoteRefs =
        input.request.quote_refs === undefined ? [] : parseQuoteRefs(input.request.quote_refs);
      const reactions =
        input.request.reactions === undefined ? [] : parseReactions(input.request.reactions);
      const adds = reactions.filter((item) => item.operation === "add");
      if (
        adds.length > 3 ||
        new Set(adds.map((item) => item.target.target_event_id)).size !== adds.length
      )
        throw new Error("participant reaction add bound exceeded");
      for (const quote of quoteRefs) this.messages.quote(input.conversation_id, quote, actor);
      for (const reaction of reactions) {
        const target = this.messages.resolve(input.conversation_id, reaction.target, actor);
        if (target.author_public_id === input.actor_participant_id)
          throw new Error("participant cannot self-react");
      }
      this.store.commitParticipantIntent({
        root_session_id: response.locator.root_session_id,
        actor_participant_id: input.actor_participant_id,
        response: response.locator,
        quote_refs: quoteRefs,
        reactions,
        diagnostic_code: null,
        created_at: response.created_at,
      });
      return { accepted: true, diagnostic_code: null };
    } catch (error) {
      if (error instanceof ConversationInteractionCorruptError)
        return { accepted: false, diagnostic_code: "interaction_authority_corrupt" };
      try {
        this.store.commitParticipantIntent({
          root_session_id: response.locator.root_session_id,
          actor_participant_id: input.actor_participant_id,
          response: response.locator,
          quote_refs: [],
          reactions: [],
          diagnostic_code: "invalid_social_intent",
          created_at: response.created_at,
        });
      } catch {
        return { accepted: false, diagnostic_code: "interaction_authority_corrupt" };
      }
      return { accepted: false, diagnostic_code: "invalid_social_intent" };
    }
  }

  humanReaction(input: {
    conversation_id: string;
    actor_public_id: string;
    idempotency_key: string;
    operation: "add" | "remove";
    target: PublicMessageLocatorV1;
    emoji: ReactionEmojiV1;
  }): ConversationReactionOperationV1 {
    const resolved = this.messages.resolve(input.conversation_id, input.target, {
      kind: "human",
      public_id: input.actor_public_id,
      participant_id: null,
      source_event_id: null,
    });
    return this.store.commitHumanReaction({
      root_session_id: resolved.locator.root_session_id,
      actor_public_id: input.actor_public_id,
      idempotency_key: input.idempotency_key,
      operation: input.operation,
      target: resolved.locator,
      emoji: input.emoji,
      created_at: this.now(),
    });
  }

  humanToggle(
    input: Omit<Parameters<ConversationSocialAuthorityV1["humanReaction"]>[0], "operation">,
  ): ConversationReactionOperationV1 {
    const resolved = this.messages.resolve(input.conversation_id, input.target, {
      kind: "human",
      public_id: input.actor_public_id,
      participant_id: null,
      source_event_id: null,
    });
    return this.store.commitHumanToggle({
      root_session_id: resolved.locator.root_session_id,
      actor_public_id: input.actor_public_id,
      idempotency_key: input.idempotency_key,
      target: resolved.locator,
      emoji: input.emoji,
      created_at: this.now(),
    });
  }

  projection(
    conversationId: string,
    recipientParticipantId: string | null,
  ): ConversationInteractionProjectionV1 {
    let root = "";
    try {
      const inventory = this.messages.inventory(conversationId);
      root = inventory.root_session_id;
      const fold = this.store.readFold(root);
      const quotesByResponse: Record<
        string,
        ReturnType<ConversationMessageAuthorityV1["quote"]>[]
      > = {};
      const diagnostics: Record<string, string> = {};
      for (const message of inventory.messages) {
        if (!message.quote_refs.length) continue;
        quotesByResponse[message.locator.target_event_id] = message.quote_refs.map((quote) =>
          this.messages.quote(conversationId, quote, {
            kind: "human",
            public_id: "human",
            participant_id: null,
            source_event_id: message.locator.target_event_id,
          }),
        );
      }
      for (const intent of fold.participant_intents) {
        const response = this.messages.resolve(conversationId, intent.response, {
          kind: "participant",
          public_id: intent.actor_participant_id,
          participant_id: intent.actor_participant_id,
          source_event_id: null,
        });
        if (
          response.author_public_id !== intent.actor_participant_id ||
          response.locator.target_kind !== "completed-agent-response"
        )
          throw new Error("social intent response authority changed");
        if (intent.diagnostic_code !== null) {
          diagnostics[intent.response.target_event_id] = intent.diagnostic_code;
          continue;
        }
        quotesByResponse[intent.response.target_event_id] = intent.quote_refs.map((quote) =>
          this.messages.quote(conversationId, quote, {
            kind: "participant",
            public_id: intent.actor_participant_id,
            participant_id: intent.actor_participant_id,
            source_event_id: intent.response.target_event_id,
          }),
        );
      }
      for (const operation of fold.reactions) {
        const target = this.messages.resolve(conversationId, operation.target, {
          kind: operation.actor_kind,
          public_id: operation.actor_public_id,
          participant_id: operation.actor_kind === "participant" ? operation.actor_public_id : null,
          source_event_id:
            operation.actor_kind === "participant"
              ? (fold.participant_intents.find((intent) =>
                  intent.reaction_operations.some(
                    (candidate) => candidate.operation_id === operation.operation_id,
                  ),
                )?.response.target_event_id ?? null)
              : null,
        });
        if (
          operation.actor_kind === "participant" &&
          target.author_public_id === operation.actor_public_id
        )
          throw new Error("participant self reaction entered interaction fold");
      }
      return {
        schema_version: "1.0",
        state: "ready",
        root_session_id: root,
        interaction_head_digest: fold.head_digest,
        interaction_head_sequence: fold.head_sequence,
        interaction_head_digests_by_sequence: structuredClone(fold.head_digests_by_sequence),
        reaction_changes: conversationReactionChanges(fold, recipientParticipantId),
        message_locators_by_event_id: Object.fromEntries(
          inventory.messages.map((message) => [
            message.locator.target_event_id,
            structuredClone(message.locator),
          ]),
        ),
        quote_projections_by_response_event_id: quotesByResponse,
        reaction_projections: publicReactionProjection(fold.reactions, recipientParticipantId),
        diagnostics_by_response_event_id: diagnostics,
      };
    } catch {
      return {
        schema_version: "1.0",
        state: "degraded",
        root_session_id: root,
        interaction_head_digest: null,
        interaction_head_sequence: 0,
        interaction_head_digests_by_sequence: {},
        reaction_changes: [],
        message_locators_by_event_id: {},
        quote_projections_by_response_event_id: {},
        reaction_projections: [],
        diagnostics_by_response_event_id: {},
      };
    }
  }
}
