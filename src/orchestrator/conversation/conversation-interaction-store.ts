import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  atomicCompareAndSwap,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import type { ProcessLock } from "../../durability/index.js";
import {
  type HumanReactionInputV1,
  commitHumanReactionV1,
  recoverPendingHumanReactionsV1,
} from "./conversation-human-reaction-store.js";
import type {
  AgentReactionRequestV1,
  ConversationInteractionEntryV1,
  ConversationInteractionFoldV1,
  ConversationInteractionFrameV1,
  ConversationInteractionHeadV1,
  ConversationParticipantSocialIntentV1,
  ConversationReactionOperationV1,
  PublicMessageLocatorV1,
  PublicQuoteReferenceV1,
  ReactionEmojiV1,
} from "./conversation-interaction-types.js";
import {
  assertConversationInteractionFrameV1,
  assertConversationInteractionHeadV1,
  interactionFrameDigest,
  interactionHeadDigest,
  participantSocialIntentDigest,
  reactionOperationDigest,
  sameCanonicalInteraction,
} from "./conversation-interaction-validation.js";
import { assertParticipantReactionTransitions } from "./conversation-participant-reaction-validation.js";

const MAX_OBJECT_BYTES = 2 * 1024 * 1024;
const MAX_FRAMES = 16_384;
const INITIAL_TIME = "1970-01-01T00:00:00.000Z";

function initialHead(rootSessionId: string): ConversationInteractionHeadV1 {
  const preimage = {
    schema_version: "1.0" as const,
    root_session_id: rootSessionId,
    sequence: 0,
    last_frame_digest: null,
    updated_at: INITIAL_TIME,
  };
  return { ...preimage, content_digest: interactionHeadDigest(preimage) };
}

function entryTime(entry: ConversationInteractionEntryV1): string {
  return entry.kind === "reaction-operation" ? entry.operation.created_at : entry.intent.created_at;
}

function entryPriorHead(entry: ConversationInteractionEntryV1): string {
  return entry.kind === "reaction-operation"
    ? entry.operation.prior_interaction_head_digest
    : entry.intent.prior_interaction_head_digest;
}

function decode<T>(bytes: Buffer, assert: (value: unknown) => void): T {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assert(value);
  if (!canonicalJsonBytes(value, { maxBytes: MAX_OBJECT_BYTES }).equals(bytes))
    throw new Error("conversation interaction authority is non-canonical");
  return structuredClone(value) as T;
}

export class ConversationInteractionCorruptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationInteractionCorruptError";
  }
}

export class ConversationInteractionStore {
  private readonly root: string;
  private readonly heads: string;
  private readonly objects: string;
  private readonly idempotency: string;
  private readonly lockPath: string;

  constructor(
    artifactRoot: string,
    private readonly faults: {
      afterHumanRequestBinding?(): void;
      afterHumanReactionAppend?(): void;
    } = {},
  ) {
    this.root = ensurePrivateDirectory(join(resolve(artifactRoot), "interactions", "v1"));
    this.heads = ensurePrivateDirectory(join(this.root, "heads"));
    this.objects = ensurePrivateDirectory(join(this.root, "objects"));
    this.idempotency = ensurePrivateDirectory(join(this.root, "idempotency"));
    this.lockPath = join(this.root, "interaction.writer.lock");
  }

  private headPath(rootSessionId: string): string {
    const key = digestHex(
      digestV1("VF-CONVERSATION-INTERACTION-STORAGE-KEY\0v1\0", {
        schema_version: "1.0",
        root_session_id: rootSessionId,
      }),
    );
    return join(this.heads, `${key}.json`);
  }

  private objectPath(digest: string): string {
    return join(this.objects, `${digestHex(digest)}.json`);
  }

  readHead(rootSessionId: string): ConversationInteractionHeadV1 {
    const bytes = privateFileBytes(this.headPath(rootSessionId), MAX_OBJECT_BYTES);
    if (bytes === null) return initialHead(rootSessionId);
    try {
      const head = decode<ConversationInteractionHeadV1>(
        bytes,
        assertConversationInteractionHeadV1,
      );
      if (head.root_session_id !== rootSessionId)
        throw new Error("interaction head storage key changed");
      return head;
    } catch (error) {
      throw new ConversationInteractionCorruptError("conversation interaction head is corrupt", {
        cause: error,
      });
    }
  }

  readFold(rootSessionId: string): ConversationInteractionFoldV1 {
    try {
      const head = this.readHead(rootSessionId);
      const reversed: ConversationInteractionFrameV1[] = [];
      let digest = head.last_frame_digest;
      for (let count = 0; digest !== null && count < MAX_FRAMES; count += 1) {
        const bytes = privateFileBytes(this.objectPath(digest), MAX_OBJECT_BYTES);
        if (bytes === null) throw new Error("interaction frame is absent");
        const frame = decode<ConversationInteractionFrameV1>(
          bytes,
          assertConversationInteractionFrameV1,
        );
        if (frame.frame_digest !== digest || frame.root_session_id !== rootSessionId)
          throw new Error("interaction frame reference changed");
        reversed.push(frame);
        digest = frame.previous_frame_digest;
      }
      if (digest !== null) throw new Error("interaction history exceeds bound");
      const frames = reversed.reverse();
      let prior = initialHead(rootSessionId);
      const operations: ConversationReactionOperationV1[] = [];
      const intents: ConversationParticipantSocialIntentV1[] = [];
      const headDigests: Record<string, string> = { "0": prior.content_digest };
      const reactionSequences: Record<string, number> = {};
      for (const [index, frame] of frames.entries()) {
        if (
          frame.sequence !== index + 1 ||
          frame.previous_frame_digest !== prior.last_frame_digest ||
          entryPriorHead(frame.entry) !== prior.content_digest
        )
          throw new Error("interaction frame chain changed");
        if (frame.entry.kind === "reaction-operation") {
          operations.push(structuredClone(frame.entry.operation));
          reactionSequences[frame.entry.operation.operation_id] = frame.sequence;
        } else {
          intents.push(structuredClone(frame.entry.intent));
          operations.push(...structuredClone(frame.entry.intent.reaction_operations));
          for (const operation of frame.entry.intent.reaction_operations)
            reactionSequences[operation.operation_id] = frame.sequence;
        }
        const headPreimage = {
          schema_version: "1.0" as const,
          root_session_id: rootSessionId,
          sequence: frame.sequence,
          last_frame_digest: frame.frame_digest,
          updated_at: entryTime(frame.entry),
        };
        prior = { ...headPreimage, content_digest: interactionHeadDigest(headPreimage) };
        headDigests[String(frame.sequence)] = prior.content_digest;
      }
      if (!sameCanonicalInteraction(prior, head))
        throw new Error("interaction folded head changed");
      return {
        schema_version: "1.0",
        root_session_id: rootSessionId,
        head_digest: head.content_digest,
        head_sequence: head.sequence,
        head_digests_by_sequence: headDigests,
        reaction_sequences_by_operation_id: reactionSequences,
        reactions: operations,
        participant_intents: intents,
      };
    } catch (error) {
      if (error instanceof ConversationInteractionCorruptError) throw error;
      throw new ConversationInteractionCorruptError("conversation interaction journal is corrupt", {
        cause: error,
      });
    }
  }

  private append(
    rootSessionId: string,
    prior: ConversationInteractionHeadV1,
    entry: ConversationInteractionEntryV1,
    lock: ProcessLock,
  ): ConversationInteractionHeadV1 {
    const framePreimage = {
      schema_version: "1.0" as const,
      root_session_id: rootSessionId,
      sequence: prior.sequence + 1,
      previous_frame_digest: prior.last_frame_digest,
      entry: structuredClone(entry),
    };
    const frame = { ...framePreimage, frame_digest: interactionFrameDigest(framePreimage) };
    assertConversationInteractionFrameV1(frame);
    createOrVerifyPrivateFile(this.objectPath(frame.frame_digest), canonicalJsonBytes(frame), {
      lock,
      maxBytes: MAX_OBJECT_BYTES,
    });
    const headPreimage = {
      schema_version: "1.0" as const,
      root_session_id: rootSessionId,
      sequence: frame.sequence,
      last_frame_digest: frame.frame_digest,
      updated_at: entryTime(entry),
    };
    const head = { ...headPreimage, content_digest: interactionHeadDigest(headPreimage) };
    assertConversationInteractionHeadV1(head);
    const expected = prior.sequence === 0 ? null : canonicalJsonBytes(prior);
    atomicCompareAndSwap(this.headPath(rootSessionId), expected, canonicalJsonBytes(head), {
      lock,
      maxBytes: MAX_OBJECT_BYTES,
    });
    return head;
  }

  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.lockPath, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  commitHumanReaction(input: {
    root_session_id: string;
    actor_public_id: string;
    idempotency_key: string;
    operation: "add" | "remove";
    target: PublicMessageLocatorV1;
    emoji: ReactionEmojiV1;
    created_at: string;
  }): ConversationReactionOperationV1 {
    const { operation, ...request } = input;
    return commitHumanReactionV1(this.humanHost(), request, operation);
  }

  commitHumanToggle(input: HumanReactionInputV1): ConversationReactionOperationV1 {
    return commitHumanReactionV1(this.humanHost(), input, "toggle-self");
  }

  private humanHost() {
    return {
      idempotencyRoot: this.idempotency,
      withLock: <T>(operation: string, run: (lock: ProcessLock) => T) =>
        this.withLock(operation, run),
      readFold: (rootSessionId: string) => this.readFold(rootSessionId),
      readHead: (rootSessionId: string) => this.readHead(rootSessionId),
      append: (
        rootSessionId: string,
        prior: ConversationInteractionHeadV1,
        entry: ConversationInteractionEntryV1,
        lock: ProcessLock,
      ) => this.append(rootSessionId, prior, entry, lock),
      afterRequestBinding: () => this.faults.afterHumanRequestBinding?.(),
      afterReactionAppend: () => this.faults.afterHumanReactionAppend?.(),
    };
  }

  commitParticipantIntent(input: {
    root_session_id: string;
    actor_participant_id: string;
    response: PublicMessageLocatorV1;
    quote_refs: PublicQuoteReferenceV1[];
    reactions: AgentReactionRequestV1[];
    diagnostic_code: string | null;
    created_at: string;
  }): ConversationParticipantSocialIntentV1 {
    return this.withLock(`participant-social:${input.response.target_event_id}`, (lock) => {
      recoverPendingHumanReactionsV1(this.humanHost(), input.root_session_id, lock);
      const fold = this.readFold(input.root_session_id);
      const intentId = `vf-social-intent-${digestHex(
        digestV1("VF-CONVERSATION-PARTICIPANT-SOCIAL-INTENT-ID\0v1\0", {
          root_session_id: input.root_session_id,
          actor_participant_id: input.actor_participant_id,
          response_event_id: input.response.target_event_id,
        }),
      )}`;
      const existing = fold.participant_intents.find((item) => item.intent_id === intentId);
      if (existing) {
        const requested = input.reactions.map(({ operation, target, emoji }) => ({
          operation,
          target,
          emoji,
        }));
        const recorded = existing.reaction_operations.map(({ operation, target, emoji }) => ({
          operation,
          target,
          emoji,
        }));
        if (
          existing.actor_participant_id !== input.actor_participant_id ||
          existing.diagnostic_code !== input.diagnostic_code ||
          !sameCanonicalInteraction(existing.response, input.response) ||
          !sameCanonicalInteraction(existing.quote_refs, input.quote_refs) ||
          !sameCanonicalInteraction(recorded, requested)
        )
          throw new Error("participant social intent idempotency conflict");
        return existing;
      }
      const head = this.readHead(input.root_session_id);
      const reactionOperations = input.reactions.map((request, index) => {
        const operationId = `vf-reaction-${digestHex(
          digestV1("VF-CONVERSATION-PARTICIPANT-REACTION-ID\0v1\0", {
            intent_id: intentId,
            index,
            request,
          }),
        )}`;
        const preimage = {
          schema_version: "1.0" as const,
          operation_id: operationId,
          root_session_id: input.root_session_id,
          actor_public_id: input.actor_participant_id,
          actor_kind: "participant" as const,
          operation: request.operation,
          target: structuredClone(request.target),
          emoji: request.emoji,
          prior_interaction_head_digest: head.content_digest,
          created_at: input.created_at,
        };
        return { ...preimage, operation_digest: reactionOperationDigest(preimage) };
      });
      if (input.diagnostic_code === null) {
        const adds = reactionOperations.filter((item) => item.operation === "add");
        if (
          adds.length > 3 ||
          new Set(adds.map((item) => item.target.target_event_id)).size !== adds.length
        )
          throw new Error("participant reaction add bound exceeded");
        assertParticipantReactionTransitions(fold.reactions, reactionOperations);
      } else if (input.quote_refs.length || reactionOperations.length)
        throw new Error("rejected social intent contains effects");
      const intentPreimage = {
        schema_version: "1.0" as const,
        intent_id: intentId,
        root_session_id: input.root_session_id,
        actor_participant_id: input.actor_participant_id,
        response: structuredClone(input.response),
        quote_refs: structuredClone(input.quote_refs),
        reaction_operations: reactionOperations,
        diagnostic_code: input.diagnostic_code,
        prior_interaction_head_digest: head.content_digest,
        created_at: input.created_at,
      };
      const intent = {
        ...intentPreimage,
        intent_digest: participantSocialIntentDigest(intentPreimage),
      };
      this.append(input.root_session_id, head, { kind: "participant-social-intent", intent }, lock);
      return intent;
    });
  }
}
