import type { Engine } from "../../core.js";
import type { ConversationHomeCreateBrokerV1 } from "./conversation-home-create-authority.js";
import type { ConversationMessageQueueMutationResultV1 } from "./conversation-message-queue-mutations.js";
import type { ConversationPrivateContextBrokerV1 } from "./conversation-private-context-broker-store.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND,
} from "./conversation-private-context-broker-wire.js";
import type { ConversationAllocatedStartV1 } from "./service-start-authority.js";
import type { ConversationStartResult, MessageRequest } from "./types.js";

export const CONVERSATION_ASK_COMPATIBILITY_REQUEST_KIND = Object.freeze({
  FRESH: "fresh",
  RESUME: "resume",
} as const);

export const CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND = Object.freeze({
  CREATED: "created",
  QUEUED: "queued",
} as const);

export type ConversationAskCompatibilityRequestV1 =
  | {
      kind: typeof CONVERSATION_ASK_COMPATIBILITY_REQUEST_KIND.FRESH;
      question: string;
      engine?: Engine;
      repo_relative_path: string;
      start_line: number;
      end_line: number;
    }
  | {
      kind: typeof CONVERSATION_ASK_COMPATIBILITY_REQUEST_KIND.RESUME;
      conversation_id: string;
      question: string;
    };

export type ConversationAskCompatibilityResultV1 =
  | {
      kind: typeof CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.CREATED;
      conversation_id: string;
      replayed: boolean;
    }
  | {
      kind: typeof CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.QUEUED;
      conversation_id: string;
      root_session_id: string;
      queue_item_id: string;
      replayed: boolean;
    };

/** Shared CLI/HTTP Ask adapter. It owns no native session and never appends directly. */
export class ConversationAskCompatibilityV1 {
  constructor(
    private readonly input: {
      privateContext: Pick<ConversationPrivateContextBrokerV1, "stageDraft">;
      homeCreate: ConversationHomeCreateBrokerV1;
      startAllocated(input: ConversationAllocatedStartV1): Promise<ConversationStartResult>;
      queue: {
        resolveCommittedConversation(conversationId: string): { root_session_id: string };
        enqueueCompatibility(
          conversationId: string,
          principalDigest: string,
          idempotencyKey: string,
          request: MessageRequest,
        ):
          | ConversationMessageQueueMutationResultV1
          | Promise<ConversationMessageQueueMutationResultV1>;
      };
    },
  ) {}

  async submit(input: {
    principal_digest: string;
    idempotency_key: string;
    request: ConversationAskCompatibilityRequestV1;
  }): Promise<ConversationAskCompatibilityResultV1> {
    const request = input.request;
    if (request.kind === CONVERSATION_ASK_COMPATIBILITY_REQUEST_KIND.RESUME)
      return this.resume({
        principal_digest: input.principal_digest,
        idempotency_key: input.idempotency_key,
        request,
      });
    this.input.privateContext.stageDraft({
      principal_digest: input.principal_digest,
      request: {
        schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
        create_idempotency_key: input.idempotency_key,
        source_kind: CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND.PRIVATE_FILE_RANGE,
        repo_relative_path: request.repo_relative_path,
        start_line: request.start_line,
        end_line: request.end_line,
      },
    });
    const prepared = this.input.homeCreate.prepare({
      principal_digest: input.principal_digest,
      request: {
        schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
        idempotency_key: input.idempotency_key,
        topic: request.question,
        policy: "direct",
        ...(request.engine
          ? {
              participants: [{ role_ref: "direct", engine: request.engine }],
            }
          : {}),
        max_rounds: 1,
        private_context_present: true,
      },
    });
    const started = await this.input.startAllocated({
      allocation: prepared.allocation,
      created_at: prepared.created_at,
      private_context_consumed: prepared.private_context_consumed,
      initial_context_record_digest: prepared.initial_context_record_digest,
      request: {
        topic: request.question,
        policy: "direct",
        ...(request.engine
          ? {
              participants: [{ role_ref: "direct", engine: request.engine }],
            }
          : {}),
        max_rounds: 1,
      },
      ...(prepared.private_file_range ? { private_file_range: prepared.private_file_range } : {}),
      before_publish: (digest) => prepared.beforePublish(digest),
    });
    return {
      kind: CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.CREATED,
      conversation_id: started.conversation_id,
      replayed: prepared.replayed,
    };
  }

  private async resume(input: {
    principal_digest: string;
    idempotency_key: string;
    request: Extract<
      ConversationAskCompatibilityRequestV1,
      { kind: typeof CONVERSATION_ASK_COMPATIBILITY_REQUEST_KIND.RESUME }
    >;
  }): Promise<ConversationAskCompatibilityResultV1> {
    const rootSessionId = this.input.queue.resolveCommittedConversation(
      input.request.conversation_id,
    ).root_session_id;
    const admitted = await this.input.queue.enqueueCompatibility(
      input.request.conversation_id,
      input.principal_digest,
      input.idempotency_key,
      { content: input.request.question },
    );
    return {
      kind: CONVERSATION_ASK_COMPATIBILITY_RESULT_KIND.QUEUED,
      conversation_id: input.request.conversation_id,
      root_session_id: rootSessionId,
      queue_item_id: admitted.item.queue_item_id,
      replayed: admitted.replayed,
    };
  }
}
