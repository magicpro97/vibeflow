import type { Engine } from "../../core/agent-contract.js";
import { supportsExactNativeSessionResume } from "../../dispatch/session-contract.js";
import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import type { PublicStoredTraceEvent } from "../trace/types.js";
import {
  type PersistedResumeBinding,
  assertPersistedResumeBinding,
} from "./artifact-resume-validation.js";
import { CONVERSATION_INTERACTION_STATE } from "./conversation-interaction-contract.js";
import type { ConversationInteractionProjectionV1 } from "./conversation-interaction-types.js";
import { MAX_CANONICAL_HANDOFF_BYTES } from "./handoff-limits.js";
import { privateFileRangeTurnContextPrompt } from "./private-file-range-turn-context-prompt.js";
import {
  CONVERSATION_TURN_DELIVERY_MODE,
  CONVERSATION_TURN_DELIVERY_SCHEMA_VERSION,
  CONVERSATION_TURN_NATIVE_SESSION_USE,
  CONVERSATION_TURN_PRIVATE_CONTEXT_KIND,
  CONVERSATION_TURN_PROJECTION_PROFILE,
  CONVERSATION_TURN_PROMPT_PREFIX,
} from "./turn-delivery-contract.js";
import { publicTurnMessages, publicTurnResponses } from "./turn-delivery-source.js";
import type {
  ConversationTurnPreparationRequestV1,
  ConversationTurnPrivateFileRangeContextV1,
  PersistedTurnDeliveryV1,
  PreparedConversationTurnV1,
  ResumeWithDeliveryAuthorityV1,
} from "./turn-delivery-types.js";
import { recipientTurnHistory } from "./turn-recipient-history.js";
import { recipientSafeSharedHandoff } from "./turn-shared-handoff.js";

export const TURN_PROMPT_PREFIX = CONVERSATION_TURN_PROMPT_PREFIX;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const preparedTurns = new WeakSet<object>();

function hasDeliveryAuthority(value: unknown): value is ResumeWithDeliveryAuthorityV1 {
  const candidate = value as Partial<ResumeWithDeliveryAuthorityV1> | null;
  return (
    candidate !== null &&
    candidate !== undefined &&
    Number.isSafeInteger(candidate.delivery_public_seq) &&
    (candidate.delivery_public_seq ?? -1) >= 0 &&
    typeof candidate.delivery_digest === "string" &&
    DIGEST.test(candidate.delivery_digest)
  );
}

function trustedNativeResume(
  value: unknown,
  participantId: string,
  recipientEngine: Engine,
): PersistedResumeBinding | null {
  try {
    assertPersistedResumeBinding(value);
    return value.participant_id === participantId &&
      value.engine === recipientEngine &&
      supportsExactNativeSessionResume(recipientEngine)
      ? value
      : null;
  } catch {
    return null;
  }
}

function validInteractionCursor(input: {
  projection: ConversationInteractionProjectionV1 | undefined;
  resume: ResumeWithDeliveryAuthorityV1;
  prior: PersistedTurnDeliveryV1;
}): boolean {
  if (!input.projection) return false;
  const sequence = input.resume.delivery_interaction_sequence;
  const digest = input.resume.delivery_interaction_digest;
  return (
    input.projection.state === CONVERSATION_INTERACTION_STATE.READY &&
    Number.isSafeInteger(sequence) &&
    (sequence ?? -1) >= 0 &&
    typeof digest === "string" &&
    input.prior.interaction_sequence === sequence &&
    input.prior.interaction_head_digest === digest &&
    input.projection.interaction_head_digests_by_sequence[String(sequence)] === digest
  );
}

export function prepareConversationTurn(input: {
  conversation_id: string;
  revision_id: string;
  recipient_engine: Engine;
  request: ConversationTurnPreparationRequestV1;
  events: readonly PublicStoredTraceEvent[];
  resume: unknown;
  prior_delivery: PersistedTurnDeliveryV1 | undefined;
  observed_after_public_seq: number;
  shared_handoff: string | null;
  private_contexts?: readonly ConversationTurnPrivateFileRangeContextV1[];
  interaction_projection?: ConversationInteractionProjectionV1;
}): PreparedConversationTurnV1 {
  const resume = trustedNativeResume(
    input.resume,
    input.request.participant_id,
    input.recipient_engine,
  );
  const prior = input.prior_delivery;
  const exactBase =
    resume !== null &&
    hasDeliveryAuthority(resume) &&
    prior?.participant_id === input.request.participant_id &&
    prior.attempt_id === resume.attemptId &&
    prior.through_public_seq === resume.delivery_public_seq &&
    prior.envelope_digest === resume.delivery_digest;
  const exact =
    exactBase &&
    validInteractionCursor({
      projection: input.interaction_projection,
      resume,
      prior,
    });
  const after = exact ? resume.delivery_public_seq : 0;
  const through = input.events.at(-1)?.seq ?? 0;
  if (after > through) throw new Error("turn delivery cursor is in the future");
  const userMessages = publicTurnMessages(input.events, input.request.participant_id, after);
  const publicResponses = publicTurnResponses(
    input.events,
    input.request.participant_id,
    after,
    false,
  );
  const recipientResponses = publicTurnResponses(
    input.events,
    input.request.participant_id,
    0,
    true,
  ).filter((response) => response.author_public_id === input.request.participant_id);
  const recipientHistory = recipientTurnHistory(recipientResponses, resume !== null);
  const deliveredIds = new Set([
    ...userMessages.map((message) => message.message_id),
    ...publicResponses.map((response) => response.message_id),
    ...recipientHistory.entries.map((response) => response.message_id),
  ]);
  const interactions = input.interaction_projection;
  const quotedMessages =
    interactions?.state === CONVERSATION_INTERACTION_STATE.READY
      ? [...userMessages, ...publicResponses, ...recipientHistory.entries].flatMap((message) =>
          (interactions.quote_projections_by_response_event_id[message.message_id] ?? []).map(
            (target, index) => ({
              quoting_message_id: message.message_id,
              quote_order: index + 1,
              target: deliveredIds.has(target.target_event_id)
                ? (() => {
                    const { preview_text: _preview, created_at: _createdAt, ...reference } = target;
                    return structuredClone(reference);
                  })()
                : structuredClone(target),
            }),
          ),
        )
      : [];
  const afterInteraction = exact ? (resume.delivery_interaction_sequence ?? 0) : 0;
  const throughInteraction =
    interactions?.state === CONVERSATION_INTERACTION_STATE.READY
      ? interactions.interaction_head_sequence
      : 0;
  const interactionHeadDigest =
    interactions?.state === CONVERSATION_INTERACTION_STATE.READY
      ? interactions.interaction_head_digest
      : null;
  const peerReactions =
    interactions?.state === CONVERSATION_INTERACTION_STATE.READY
      ? interactions.reaction_changes
          .filter((reaction) =>
            exact
              ? reaction.last_changed_interaction_sequence > afterInteraction
              : reaction.count > 0,
          )
          .map(({ last_changed_interaction_sequence: _sequence, ...reaction }) => {
            const actorIds = reaction.actor_public_ids.filter(
              (actor) => actor !== input.request.participant_id,
            );
            return {
              ...reaction,
              count: actorIds.length,
              reacted_by_recipient: false,
              actor_public_ids: actorIds,
            };
          })
          .filter((reaction) => reaction.count > 0)
      : [];
  const privateContextPrompt = privateFileRangeTurnContextPrompt(
    (input.private_contexts ?? [])
      .filter((context) =>
        context.context_kind === CONVERSATION_TURN_PRIVATE_CONTEXT_KIND.CONVERSATION_CREATE
          ? after === 0
          : context.message_public_seq !== null && context.message_public_seq > after,
      )
      .map((context) => ({
        delivery_kind: context.context_kind,
        message_public_seq: context.message_public_seq,
        repo_relative_path: context.repo_relative_path,
        start_line: context.start_line,
        end_line: context.end_line,
        line_count: context.line_count,
        content: context.content,
      })),
    MAX_CANONICAL_HANDOFF_BYTES,
  );
  const envelope = {
    schema_version: CONVERSATION_TURN_DELIVERY_SCHEMA_VERSION,
    projection_profile: CONVERSATION_TURN_PROJECTION_PROFILE.PUBLIC_V1,
    conversation_id: input.conversation_id,
    revision_id: input.revision_id,
    recipient_participant_id: input.request.participant_id,
    recipient_engine: input.recipient_engine,
    delivery_mode: exact
      ? CONVERSATION_TURN_DELIVERY_MODE.EXACT_DELTA
      : CONVERSATION_TURN_DELIVERY_MODE.FULL_HISTORY,
    native_session_use:
      resume === null
        ? CONVERSATION_TURN_NATIVE_SESSION_USE.NOT_USED
        : CONVERSATION_TURN_NATIVE_SESSION_USE.REQUIRED_EXACT,
    after_public_seq: after,
    through_public_seq: through,
    prior_delivery_digest: exact ? (input.prior_delivery?.envelope_digest ?? null) : null,
    interaction_state: interactions?.state ?? CONVERSATION_INTERACTION_STATE.DEGRADED,
    after_interaction_sequence: afterInteraction,
    through_interaction_sequence: throughInteraction,
    prior_interaction_head_digest: exact ? (resume.delivery_interaction_digest ?? null) : null,
    interaction_head_digest: interactionHeadDigest,
    instruction: structuredClone(input.request.instruction),
    user_messages: userMessages,
    public_responses: publicResponses,
    recipient_history: recipientHistory,
    quoted_messages: quotedMessages,
    peer_reactions: peerReactions,
  };
  const sharedPrompt =
    !exact && input.shared_handoff
      ? recipientSafeSharedHandoff(input.shared_handoff, input.request.participant_id)
      : null;
  const sharedBytes = sharedPrompt ? Buffer.byteLength(`${sharedPrompt}\n\n`, "utf8") : 0;
  const privateBytes = privateContextPrompt
    ? Buffer.byteLength(`${privateContextPrompt}\n\n`, "utf8")
    : 0;
  const turnBudget =
    MAX_CANONICAL_HANDOFF_BYTES -
    sharedBytes -
    privateBytes -
    Buffer.byteLength(TURN_PROMPT_PREFIX, "utf8");
  if (turnBudget < 1) throw new Error("turn delivery exceeds common prompt bound");
  const bytes = canonicalJsonBytes(envelope, { maxBytes: turnBudget });
  const envelopeDigest = digestV1("VF-CONVERSATION-TURN-ENVELOPE\0v1\0", envelope);
  const turn = Object.freeze({
    prompt_input: `${TURN_PROMPT_PREFIX}${bytes.toString("utf8")}`,
    private_context_prompt: privateContextPrompt,
    envelope: Object.freeze(envelope),
    receipt: Object.freeze({
      schema_version: CONVERSATION_TURN_DELIVERY_SCHEMA_VERSION,
      participant_id: input.request.participant_id,
      prior_attempt_id: exact ? resume.attemptId : null,
      delivery_mode: envelope.delivery_mode,
      after_public_seq: after,
      through_public_seq: through,
      envelope_digest: envelopeDigest,
      interaction_state: envelope.interaction_state,
      after_interaction_sequence: afterInteraction,
      through_interaction_sequence: throughInteraction,
      prior_interaction_head_digest: envelope.prior_interaction_head_digest,
      interaction_head_digest: interactionHeadDigest,
    }),
    applicable_user_message_count: publicTurnMessages(
      input.events,
      input.request.participant_id,
      input.observed_after_public_seq,
    ).length,
  });
  preparedTurns.add(turn);
  return turn;
}

export function assertPreparedConversationTurn(
  value: PreparedConversationTurnV1,
  participantId: string,
  promptInput: string,
): void {
  if (
    !preparedTurns.has(value) ||
    value.receipt.participant_id !== participantId ||
    value.prompt_input !== promptInput ||
    !promptInput.startsWith(TURN_PROMPT_PREFIX)
  )
    throw new Error("conversation turn delivery authority is invalid");
}

export function bindFullHandoffToTurn(
  sharedHandoff: string | null,
  prepared: PreparedConversationTurnV1,
): string {
  if (
    sharedHandoff === null ||
    prepared.receipt.delivery_mode === CONVERSATION_TURN_DELIVERY_MODE.EXACT_DELTA
  )
    return prepared.prompt_input;
  const projected = recipientSafeSharedHandoff(
    sharedHandoff,
    prepared.envelope.recipient_participant_id,
  );
  const combined = `${projected}\n\n${prepared.prompt_input}`;
  if (Buffer.byteLength(combined, "utf8") > MAX_CANONICAL_HANDOFF_BYTES)
    throw new Error("turn delivery exceeds common prompt bound");
  return combined;
}
